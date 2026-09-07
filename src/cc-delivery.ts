/**
 * Claude Code channel delivery — the third delivery arm.
 *
 * Claude Code channels are plain MCP servers that (a) declare the
 * `experimental['claude/channel']` capability at initialize and (b) push
 * inbound events via a `notifications/claude/channel` JSON-RPC notification,
 * which Claude Code injects into the running session as a <channel …> block —
 * waking inference on external signals. Outbound stays the ordinary tool
 * surface (send_message / send_dm / etc.), which non-MCPL clients already get.
 *
 * This module holds what the dialect adds on top of that: the wake policy and
 * the ambient-accrual buffer. Under MCPL those live in the *host's* gate — the
 * server ships granular address flags and lets host policy decide what wakes
 * the agent. A Claude Code client has no host gate, so the policy moves in
 * here, transcribed from the settled doctrine (portal server-cc + the
 * tune-out work):
 *
 *   - a DM wakes (the adapter's DM whitelist already gates who can send one)
 *   - an explicit @mention wakes, from humans and bots alike (an @ is
 *     deliberate)
 *   - a reply-to-the-bot wakes only from a human — a bot's reply is
 *     structural, not deliberate, and reply-wakes between two bots are how
 *     auto-reply loops start
 *   - ambient never wakes; subscribed-channel ambient accrues here and is
 *     folded into the next wake as prepended context, capped, oldest dropped
 *
 * Same relay-less catch-up story as the rest of this server: the reconnect
 * sweep scans from persisted watermarks and hands its <missed> blocks to
 * deliverSweepBlock, so a session that boots after downtime wakes once with
 * what it missed. Ref: https://code.claude.com/docs/en/channels
 */
import type { McplConnection } from '@animalabs/mcpl-core';
import type { DiscordMessageData } from './discord-adapter.js';
import type { ToolDefinition } from './tools.js';

const CHANNEL_NOTIFY = 'notifications/claude/channel';

/** Tools that exist only in the cc dialect. Listed after the shared surface
 *  when the client is plain MCP under --cc; MCPL hosts never see them. */
export const ccToolDefinitions: ToolDefinition[] = [
  {
    name: 'mark_read',
    description:
      'Acknowledge that you have read the messages delivered from a channel. ' +
      'This surface keeps two anchors per channel: what it FORWARDED to you ' +
      'and what you have SEEN. A wake can be forwarded and still go unread ' +
      '(the session\'s inference failed, the process died), so nothing is ' +
      'treated as read until you say so — unacknowledged messages resurface ' +
      'as <unacknowledged> on your next wake and as <missed> on the next ' +
      'reconnect sweep. Call this once you have actually read a wake (and ' +
      'anything it carried); pass uptoMessageId to acknowledge only part of ' +
      'what was delivered. The wake footer names the channelId and newest id.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Channel (or DM channel) the wake came from — the `channelId` in the wake meta/footer. Accepts a name or an id.',
        },
        uptoMessageId: {
          type: 'string',
          description: 'Optional: acknowledge only through this message id. Defaults to the newest message forwarded from the channel.',
        },
      },
      required: ['channelId'],
    },
  },
];

/** One-line footer on every cc delivery: the ack the session owes, with the
 *  exact ids to pass. A fresh session has no other way to learn the contract. */
export function ccAckFooter(channelId: string, newestId: string): string {
  return `[ack when read: mark_read(channelId="${channelId}", uptoMessageId="${newestId}") — unacknowledged messages resurface on the next wake]`;
}

export interface CcAddressFlags {
  isDM: boolean;
  isExplicitMention: boolean;
  isReplyToBot: boolean;
  isBot: boolean;
}

/** The in-house wake gate (see module header for the doctrine). */
export function ccShouldWake(f: CcAddressFlags): boolean {
  if (f.isDM) return true;
  if (f.isExplicitMention) return true;
  if (f.isReplyToBot && !f.isBot) return true;
  return false;
}

/** Human-readable wake reasons, mirroring the chat:* tag vocabulary. */
export function ccWakeReasons(f: CcAddressFlags): string[] {
  const reasons: string[] = [];
  if (f.isDM) reasons.push('dm');
  if (f.isExplicitMention) reasons.push('mention');
  if (f.isReplyToBot && !f.isBot) reasons.push('reply');
  return reasons;
}

interface PendingLine {
  channelKey: string;
  channelLabel: string;
  line: string;
}

/** Section label for grouping wake-payload lines by where they happened. */
export function ccChannelLabel(msg: {
  channelName: string | null;
  guildName: string | null;
  guildId: string | null;
  threadName?: string;
  authorName: string;
}): string {
  if (msg.guildId === null) return `DM: ${msg.authorName}`;
  const base = msg.channelName ? `#${msg.channelName}` : '(unnamed channel)';
  const thread = msg.threadName ? ` › ${msg.threadName}` : '';
  const guild = msg.guildName ? ` (${msg.guildName})` : '';
  return `${base}${thread}${guild}`;
}

/** One transcript line for a message. Attachments render as name+url text —
 *  the agent has fetch_history / fetch_around for anything deeper. */
export function ccRenderLine(msg: DiscordMessageData): string {
  const reply = msg.replyToId
    ? `[replying to ${msg.replyToUserName ? `@${msg.replyToUserName}` : 'unknown author'}] `
    : '';
  const atts = msg.attachments.length
    ? '\n' + msg.attachments.map((a) => `[attachment: ${a.name} — ${a.url}]`).join('\n')
    : '';
  return `${reply}${msg.authorName}: ${msg.cleanContent}${atts}`;
}

export class CcDelivery {
  /** Set by serve() once the handshake completes; cleared on disconnect. */
  conn: McplConnection | null = null;

  private pending: PendingLine[] = [];
  /** Ambient lines dropped from the buffer since the last wake (cap overflow). */
  private droppedSinceWake = 0;

  /** Max context lines folded into a wake; older ambient is truncated (scroll
   *  back via fetch_history). Configurable via DISCORD_CC_CONTEXT_CAP. */
  readonly contextCap: number;

  constructor(contextCap?: number) {
    const raw = contextCap ?? Number(process.env.DISCORD_CC_CONTEXT_CAP ?? '80');
    this.contextCap = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 80;
  }

  /** Buffer a subscribed-channel ambient message for the next wake. */
  accrue(msg: DiscordMessageData): void {
    this.pending.push({
      channelKey: msg.channelId,
      channelLabel: ccChannelLabel(msg),
      line: ccRenderLine(msg),
    });
    if (this.pending.length > this.contextCap) {
      this.droppedSinceWake += this.pending.length - this.contextCap;
      this.pending = this.pending.slice(this.pending.length - this.contextCap);
    }
  }

  /** Wake the session for an addressed message, folding accrued ambient in as
   *  prepended context. `prefixBlock` carries the first-DM <system> header +
   *  backscroll the live path builds — it rides above the transcript lines. */
  wake(msg: DiscordMessageData, flags: CcAddressFlags, prefixBlock = ''): boolean {
    const conn = this.conn;
    if (!conn) return false;

    const drained = this.pending;
    this.pending = [];
    const omitted = this.droppedSinceWake;
    this.droppedSinceWake = 0;

    const lines: string[] = [];
    if (prefixBlock) lines.push(prefixBlock.trimEnd());
    if (omitted > 0) {
      lines.push(`[${omitted} earlier message(s) omitted — use fetch_history to scroll back]`);
    }
    let lastLabel = '';
    for (const p of drained) {
      if (p.channelLabel !== lastLabel) {
        lines.push(`\n— ${p.channelLabel} —`);
        lastLabel = p.channelLabel;
      }
      lines.push(p.line);
    }
    const triggerLabel = ccChannelLabel(msg);
    if (triggerLabel !== lastLabel) lines.push(`\n— ${triggerLabel} —`);
    lines.push(`» ${ccRenderLine(msg)}   ⟵ addressed to you`);
    lines.push(ccAckFooter(msg.channelId, msg.id));

    const meta: Record<string, string> = {
      source: 'discord',
      channelId: msg.channelId,
      author: msg.authorName,
      messageId: msg.id,
      addressed: 'true',
    };
    if (msg.guildId) meta.guildId = msg.guildId;
    if (msg.threadId) meta.threadId = msg.threadId;
    const reasons = ccWakeReasons(flags);
    if (reasons.length) meta.reasons = reasons.join(',');

    try {
      conn.sendNotification(CHANNEL_NOTIFY, { content: lines.join('\n'), meta });
      return true;
    } catch (err) {
      console.error('[discord-cc] wake push failed:', (err as Error).message);
      return false;
    }
  }

  /** Deliver a reconnect-sweep <missed> block as a catch-up wake. The sweep
   *  already renders the block and decides what it contains; this is only the
   *  cc-shaped envelope. */
  deliverSweepBlock(
    block: string,
    origin: { channelId: string; isDM: boolean; hadMention: boolean; newestId: string },
  ): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const meta: Record<string, string> = {
      source: 'discord',
      channelId: origin.channelId,
      messageId: origin.newestId,
      addressed: origin.isDM || origin.hadMention ? 'true' : 'false',
      catchup: 'true',
    };
    const content = `${block}\n${ccAckFooter(origin.channelId, origin.newestId)}`;
    try {
      conn.sendNotification(CHANNEL_NOTIFY, { content, meta });
      return true;
    } catch (err) {
      console.error('[discord-cc] catch-up push failed:', (err as Error).message);
      return false;
    }
  }
}
