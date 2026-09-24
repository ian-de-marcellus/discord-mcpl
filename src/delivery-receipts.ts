/**
 * Delivery receipts, reaction wake policy, and send confirmations.
 *
 * - Reactions never wake the agent: they land in context for its next turn.
 *   A deliberate "ping" emoji (DISCORD_REACTION_PING_EMOJI) placed by a human
 *   on the agent's own message is the one exception.
 * - In bot-to-bot channels (DISCORD_RECEIPT_CHANNELS, else
 *   DISCORD_BOT_LOOP_CHANNELS) the receiving connector marks another bot's
 *   message once its host has durably accepted it:
 *     📥        stored in the agent's context (the host's gate decides waking)
 *     📥 + 💤   stored without waking (context-only: held by the loop guard,
 *               a continuation chunk, a batch's non-final message, a replay)
 *   A missing 📥 after a minute or two means the message never landed.
 * - Successful sends say plainly that they are live, with every part's id.
 */

export const RECEIPT_STORED = '📥';
export const RECEIPT_NO_WAKE = '💤';

/** Comma/space-separated emoji list from an env value. */
export function parseEmojiList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(/[,\s]+/)
      .map((e) => e.trim())
      .filter(Boolean),
  );
}

/** Channels that get delivery receipts. */
export function receiptChannelSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.DISCORD_RECEIPT_CHANNELS ?? env.DISCORD_BOT_LOOP_CHANNELS ?? '';
  return new Set(raw.split(',').map((v) => v.trim()).filter(Boolean));
}

/** A reaction wakes the agent only when a human places a configured ping
 *  emoji on the agent's own message. Removals never wake. */
export function reactionWakes(input: {
  action: 'add' | 'remove';
  reactorIsBot: boolean;
  onOwnMessage: boolean;
  emoji: string;
  token: string;
  pingEmoji: Set<string>;
}): boolean {
  if (input.action !== 'add' || input.reactorIsBot || !input.onOwnMessage) return false;
  if (input.pingEmoji.size === 0) return false;
  return input.pingEmoji.has(input.emoji) || input.pingEmoji.has(input.token);
}

/** Which receipt reactions a delivered message should get, or [] for none. */
export function receiptEmojis(input: {
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  selfId: string | null;
  receiptChannels: Set<string>;
  suppressWake: boolean;
}): string[] {
  if (!input.authorIsBot) return [];
  if (input.selfId !== null && input.authorId === input.selfId) return [];
  if (!input.receiptChannels.has(input.channelId)) return [];
  return input.suppressWake ? [RECEIPT_STORED, RECEIPT_NO_WAKE] : [RECEIPT_STORED];
}

/** Sequential, best-effort, idempotent reaction sender: one reaction at a
 *  time (Discord rate-limits reactions per channel), each (message, emoji)
 *  attempted at most once per process (Discord itself also treats a repeated
 *  reaction by the same user as a no-op, so a redelivery after restart is
 *  harmless). Failures are reported, never thrown. */
export class ReceiptQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly done = new Set<string>();
  private readonly maxRemembered: number;

  constructor(
    private readonly react: (channelId: string, messageId: string, emoji: string) => Promise<void>,
    private readonly onError: (info: { channelId: string; messageId: string; emoji: string; error: string }) => void = () => {},
    opts: { maxRemembered?: number } = {},
  ) {
    this.maxRemembered = opts.maxRemembered ?? 5000;
  }

  enqueue(channelId: string, messageId: string, emojis: string[]): Promise<void> {
    for (const emoji of emojis) {
      const key = `${messageId}:${emoji}`;
      if (this.done.has(key)) continue;
      this.done.add(key);
      if (this.done.size > this.maxRemembered) {
        const oldest = this.done.values().next().value;
        if (oldest !== undefined) this.done.delete(oldest);
      }
      this.chain = this.chain.then(async () => {
        try {
          await this.react(channelId, messageId, emoji);
        } catch (err) {
          this.onError({ channelId, messageId, emoji, error: (err as Error).message });
        }
      });
    }
    return this.chain;
  }
}

/** The plain confirmation a successful send returns. */
export function liveLine(input: { where: string; messageIds: string[] }): string {
  const n = input.messageIds.length;
  const parts = n === 1 ? '1 part' : `${n} parts`;
  return `✓ live in ${input.where} — ${parts}: ${input.messageIds.join(', ')}`;
}
