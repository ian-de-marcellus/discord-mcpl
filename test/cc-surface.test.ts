/**
 * Tests for the Claude Code channel dialect (--cc / DISCORD_CC=1).
 *
 * The dialect is a third delivery arm on DiscordMcplServer for plain-MCP
 * clients: initialize advertises `experimental['claude/channel']`, addressed
 * messages push `notifications/claude/channel` wakes, subscribed ambient
 * accrues and folds into the next wake, and the reconnect sweep delivers its
 * <missed> blocks through the same envelope. Wake policy lives in the surface
 * (cc-delivery.ts) because there is no host gate downstream.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { McplConnection } from '@animalabs/mcpl-core';
import type { McplInitializeParams, McplInitializeResult } from '@animalabs/mcpl-core';

import { DiscordMcplServer } from '../src/server.js';
import {
  CcDelivery,
  ccShouldWake,
  ccWakeReasons,
  ccRenderLine,
  ccChannelLabel,
} from '../src/cc-delivery.js';
import type {
  DiscordAdapter,
  DiscordMessageData,
  DiscordChannelInfo,
} from '../src/discord-adapter.js';

// ── Minimal mock adapter (only what the cc paths touch) ──

class MockDiscordAdapter {
  private _messageHandler?: (msg: DiscordMessageData) => void;

  get isConnected(): boolean { return true; }
  get botUserId(): string | null { return 'bot_123'; }

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this._messageHandler = handler;
  }
  onMessageEdit(): void {}
  onMessageDelete(): void {}
  onReaction(): void {}
  onReady(): void {}
  onChannelCreate(): void {}
  onChannelDelete(): void {}
  onGuildCreate(): void {}
  onChannelAvailable(): void {}

  /** Messages fetchHistory returns — drives the sweep and DM backscroll. */
  historyToReturn: Array<{
    id: string; authorId: string; authorName: string; isBot: boolean;
    content: string; cleanContent: string; attachments: never[];
    mentionsBot: boolean; timestamp: Date;
  }> = [];

  async fetchHistory(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  channelMeta = { name: 'general', guildId: 'g1', guildName: 'Test Guild', isDM: false };
  getCachedChannelMeta(): MockDiscordAdapter['channelMeta'] | null { return this.channelMeta; }
  async getChannelMeta(): Promise<MockDiscordAdapter['channelMeta']> { return this.channelMeta; }

  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    return [];
  }

  simulateMessage(msg: DiscordMessageData): void {
    this._messageHandler?.(msg);
  }
}

// ── Helpers ──

async function createTestPair(): Promise<{
  client: McplConnection;
  serverConn: McplConnection;
  discord: MockDiscordAdapter;
}> {
  const tcpServer = net.createServer();
  tcpServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => tcpServer.once('listening', resolve));
  const addr = tcpServer.address() as net.AddressInfo;

  const [serverConn, clientSocket] = await Promise.all([
    McplConnection.acceptTcp(tcpServer),
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => resolve(socket));
      socket.once('error', reject);
    }),
  ]);

  const client = McplConnection.fromTcp(clientSocket);
  const discord = new MockDiscordAdapter();
  tcpServer.close();
  return { client, serverConn, discord };
}

/** Plain-MCP handshake — the Claude Code client shape. */
async function mcpHandshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '0.1.0' },
  };
  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

function msgFixture(overrides: Partial<DiscordMessageData> = {}): DiscordMessageData {
  return {
    id: 'm1',
    content: 'hello',
    cleanContent: 'hello',
    authorId: 'u1',
    authorName: 'ra',
    isBot: false,
    channelId: 'c1',
    channelName: 'general',
    guildId: 'g1',
    guildName: 'Test Guild',
    mentions: [],
    attachments: [],
    timestamp: new Date('2026-09-05T18:00:00Z'),
    ...overrides,
  };
}

async function startCcServer(): Promise<{
  client: McplConnection;
  discord: MockDiscordAdapter;
  server: DiscordMcplServer;
}> {
  const { client, serverConn, discord } = await createTestPair();
  const server = new DiscordMcplServer(discord as unknown as DiscordAdapter, { ccMode: true });
  void server.serve(serverConn);
  await mcpHandshake(client);
  return { client, discord, server };
}

type CcNotification = { method: string; params: { content: string; meta: Record<string, string> } };

async function nextCcNotification(client: McplConnection): Promise<CcNotification['params']> {
  const msg = await client.nextMessage();
  assert.equal(msg.type, 'notification');
  const n = (msg as { notification: CcNotification }).notification;
  assert.equal(n.method, 'notifications/claude/channel');
  return n.params;
}

// ── Wake policy (pure) ──

describe('cc wake policy', () => {
  const base = { isDM: false, isExplicitMention: false, isReplyToBot: false, isBot: false };

  it('wakes on DM', () => {
    assert.equal(ccShouldWake({ ...base, isDM: true }), true);
    assert.deepEqual(ccWakeReasons({ ...base, isDM: true }), ['dm']);
  });

  it('wakes on explicit mention from a human', () => {
    assert.equal(ccShouldWake({ ...base, isExplicitMention: true }), true);
  });

  it('wakes on explicit mention from a bot (an @ is deliberate)', () => {
    assert.equal(ccShouldWake({ ...base, isExplicitMention: true, isBot: true }), true);
  });

  it('wakes on reply-to-bot from a human', () => {
    assert.equal(ccShouldWake({ ...base, isReplyToBot: true }), true);
    assert.deepEqual(ccWakeReasons({ ...base, isReplyToBot: true }), ['reply']);
  });

  it('does NOT wake on reply-to-bot from a bot (auto-reply loop break)', () => {
    assert.equal(ccShouldWake({ ...base, isReplyToBot: true, isBot: true }), false);
  });

  it('does NOT wake on ambient', () => {
    assert.equal(ccShouldWake(base), false);
  });
});

// ── Accrual buffer (pure-ish, fake conn) ──

describe('cc ambient accrual', () => {
  function fakeConnCapture(): { conn: McplConnection; sent: CcNotification[] } {
    const sent: CcNotification[] = [];
    const conn = {
      sendNotification(method: string, params: CcNotification['params']) {
        sent.push({ method, params });
      },
    } as unknown as McplConnection;
    return { conn, sent };
  }

  it('folds accrued ambient into the next wake, oldest dropped past the cap', () => {
    const cc = new CcDelivery(3);
    const { conn, sent } = fakeConnCapture();
    cc.conn = conn;

    for (let i = 1; i <= 5; i++) {
      cc.accrue(msgFixture({ id: `a${i}`, cleanContent: `ambient ${i}`, content: `ambient ${i}` }));
    }
    cc.wake(
      msgFixture({ id: 'trig', cleanContent: 'oi weft', content: 'oi weft' }),
      { isDM: false, isExplicitMention: true, isReplyToBot: false, isBot: false },
    );

    assert.equal(sent.length, 1);
    const { content, meta } = sent[0].params;
    // Cap 3: ambient 1-2 dropped with an omission notice, 3-5 folded in.
    assert.match(content, /2 earlier message\(s\) omitted/);
    assert.doesNotMatch(content, /ambient 1\b/);
    assert.match(content, /ambient 3/);
    assert.match(content, /ambient 5/);
    // Trigger is marked and last.
    assert.match(content, /» ra: oi weft {3}⟵ addressed to you/);
    assert.equal(meta.addressed, 'true');
    assert.equal(meta.messageId, 'trig');
    assert.equal(meta.reasons, 'mention');

    // Buffer drains on wake: a second wake carries no stale context.
    cc.wake(
      msgFixture({ id: 'trig2', cleanContent: 'again', content: 'again' }),
      { isDM: false, isExplicitMention: true, isReplyToBot: false, isBot: false },
    );
    assert.doesNotMatch(sent[1].params.content, /ambient/);
    assert.doesNotMatch(sent[1].params.content, /omitted/);
  });

  it('labels sections by channel and renders attachments as text', () => {
    const label = ccChannelLabel(msgFixture({ threadName: 'side quest' }));
    assert.equal(label, '#general › side quest (Test Guild)');
    assert.equal(ccChannelLabel(msgFixture({ guildId: null, guildName: null, channelName: null })), 'DM: ra');

    const line = ccRenderLine(
      msgFixture({
        replyToId: 'x',
        replyToUserName: 'antra',
        attachments: [{ id: '1', name: 'notes.txt', url: 'https://cdn/notes.txt' } as never],
      }),
    );
    assert.match(line, /^\[replying to @antra\] ra: hello/);
    assert.match(line, /\[attachment: notes\.txt — https:\/\/cdn\/notes\.txt\]/);
  });
});

// ── Handshake ──

describe('cc handshake', () => {
  it('advertises claude/channel to a plain-MCP client when --cc is on', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter, { ccMode: true });
    void server.serve(serverConn);
    const result = await mcpHandshake(client);
    const exp = result.capabilities.experimental as Record<string, unknown> | undefined;
    assert.ok(exp && 'claude/channel' in exp, 'claude/channel capability missing');
    assert.ok(!('mcpl' in (exp ?? {})), 'mcpl must not be advertised to an MCP client');
    client.close();
  });

  it('does not advertise claude/channel without --cc', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    void server.serve(serverConn);
    const result = await mcpHandshake(client);
    const exp = result.capabilities.experimental as Record<string, unknown> | undefined;
    assert.ok(!exp || !('claude/channel' in exp));
    client.close();
  });

  it('defers to MCPL when the client is an MCPL host, even with --cc', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter, { ccMode: true });
    void server.serve(serverConn);
    const params: McplInitializeParams = {
      protocolVersion: '2024-11-05',
      capabilities: {
        experimental: {
          mcpl: { version: '0.4', pushEvents: true, channels: true, rollback: true },
        },
      },
      clientInfo: { name: 'mcpl-host', version: '0.1.0' },
    };
    const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
    // Complete the handshake — the server is awaiting `initialized`, and
    // closing mid-handshake turns into an unhandled ConnectionClosedError.
    client.sendNotification('notifications/initialized');
    const exp = result.capabilities.experimental as Record<string, unknown>;
    assert.ok('mcpl' in exp, 'MCPL host must get the mcpl capability block');
    assert.ok(!('claude/channel' in exp), 'cc dialect must defer to MCPL');
    client.close();
  });
});

// ── Live delivery ──

describe('cc live delivery', () => {
  it('wakes on a guild mention with addressed meta', async () => {
    const { client, discord } = await startCcServer();
    discord.simulateMessage(
      msgFixture({ id: 'm42', content: '<@bot_123> ping', cleanContent: '@Weft ping', mentions: ['bot_123'] }),
    );
    const { content, meta } = await nextCcNotification(client);
    assert.match(content, /» ra: @Weft ping {3}⟵ addressed to you/);
    assert.match(content, /— #general \(Test Guild\) —/);
    assert.equal(meta.addressed, 'true');
    assert.equal(meta.messageId, 'm42');
    assert.equal(meta.channelId, 'c1');
    assert.equal(meta.reasons, 'mention');
    client.close();
  });

  it('drops a bot reply but wakes on a bot @mention (loop break)', async () => {
    const { client, discord } = await startCcServer();
    // A bot replying to us: structural, must not wake.
    discord.simulateMessage(
      msgFixture({ id: 'botreply', authorId: 'b9', authorName: 'otherbot', isBot: true, replyToId: 'prev', replyToUserId: 'bot_123' }),
    );
    // A bot explicitly @mentioning us: deliberate, wakes.
    discord.simulateMessage(
      msgFixture({ id: 'botping', authorId: 'b9', authorName: 'otherbot', isBot: true, mentions: ['bot_123'] }),
    );
    const { meta } = await nextCcNotification(client);
    assert.equal(meta.messageId, 'botping', 'first notification must be the @mention, not the reply');
    client.close();
  });

  it('first DM carries the send_dm affordance header and DM meta shape', async () => {
    const { client, discord } = await startCcServer();
    discord.simulateMessage(
      msgFixture({ id: 'dm1', channelId: 'dmc1', channelName: null, guildId: null, guildName: null, cleanContent: 'hey weft' }),
    );
    const { content, meta } = await nextCcNotification(client);
    assert.match(content, /<system>Direct message from @ra \(user id u1\)/);
    assert.match(content, /send_dm\("ra"\)/);
    assert.match(content, /» ra: hey weft {3}⟵ addressed to you/);
    assert.equal(meta.addressed, 'true');
    assert.equal(meta.reasons, 'dm');
    assert.equal(meta.guildId, undefined);
    client.close();
  });

  it('accrues subscribed ambient and folds it into the next wake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-subs-'));
    const subsFile = join(dir, 'subs.json');
    writeFileSync(subsFile, JSON.stringify(['c1']));
    const prev = process.env.DISCORD_SUBSCRIPTIONS_FILE;
    process.env.DISCORD_SUBSCRIPTIONS_FILE = subsFile;
    try {
      const { client, discord } = await startCcServer();
      discord.simulateMessage(
        msgFixture({ id: 'amb1', authorName: 'antra', content: 'ambient chatter', cleanContent: 'ambient chatter' }),
      );
      discord.simulateMessage(
        msgFixture({ id: 'trig1', content: '<@bot_123> hi', cleanContent: '@Weft hi', mentions: ['bot_123'] }),
      );
      const { content, meta } = await nextCcNotification(client);
      assert.equal(meta.messageId, 'trig1', 'ambient alone must not wake');
      assert.match(content, /antra: ambient chatter/);
      assert.match(content, /» ra: @Weft hi/);
      client.close();
    } finally {
      if (prev === undefined) delete process.env.DISCORD_SUBSCRIPTIONS_FILE;
      else process.env.DISCORD_SUBSCRIPTIONS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not deliver unsubscribed ambient at all', async () => {
    const { client, discord } = await startCcServer();
    discord.simulateMessage(msgFixture({ id: 'amb-unsub', cleanContent: 'nothing to see' }));
    discord.simulateMessage(
      msgFixture({ id: 'trig2', content: '<@bot_123> yo', cleanContent: '@Weft yo', mentions: ['bot_123'] }),
    );
    const { content } = await nextCcNotification(client);
    assert.doesNotMatch(content, /nothing to see/);
    client.close();
  });
});

// ── Reconnect catch-up ──

describe('cc reconnect catch-up', () => {
  it('delivers the sweep <missed> block as a catchup notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-marks-'));
    const marksFile = join(dir, 'marks.json');
    writeFileSync(
      marksFile,
      JSON.stringify({ watermarks: { c1: '100' }, dmChannels: [], missed: {} }),
    );
    const prev = process.env.DISCORD_WATERMARK_FILE;
    process.env.DISCORD_WATERMARK_FILE = marksFile;
    try {
      const { client, serverConn, discord } = await createTestPair();
      discord.historyToReturn = [
        {
          id: '101', authorId: 'u1', authorName: 'ra', isBot: false,
          content: '<@bot_123> you there?', cleanContent: '@Weft you there?',
          attachments: [], mentionsBot: true, timestamp: new Date('2026-09-05T12:00:00Z'),
        },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter, { ccMode: true });
      void server.serve(serverConn);
      await mcpHandshake(client);

      const { content, meta } = await nextCcNotification(client);
      assert.match(content, /<missed[^>]*channelId="c1"/);
      assert.match(content, /ra \(mention\): @Weft you there\?/);
      assert.equal(meta.catchup, 'true');
      assert.equal(meta.addressed, 'true');
      client.close();
    } finally {
      if (prev === undefined) delete process.env.DISCORD_WATERMARK_FILE;
      else process.env.DISCORD_WATERMARK_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
