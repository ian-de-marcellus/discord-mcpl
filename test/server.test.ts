/**
 * Integration tests for DiscordMcplServer.
 * Uses a mock Discord adapter (no real Discord connection).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';

import type {
  McplInitializeParams,
  McplInitializeResult,
  McplCapabilities,
  ChannelsRegisterParams,
  ChannelsIncomingParams,
  PushEventParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsListResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
} from '@animalabs/mcpl-core';

import { DiscordMcplServer } from '../src/server.js';
import { applyMentionCandidates } from '../src/discord-adapter.js';
import type {
  DiscordAdapter,
  DiscordMessageData,
  DiscordChannelInfo,
  MentionCandidate,
} from '../src/discord-adapter.js';

// ── Mock Discord Adapter ──

class MockDiscordAdapter {
  private _messageHandler?: (msg: DiscordMessageData) => void;
  private _channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private _channelDeleteHandler?: (guildId: string, channelId: string) => void;
  private _guildCreateHandler?: (
    guildId: string,
    guildName: string,
    channels: DiscordChannelInfo[],
  ) => void;
  private _channelAvailableHandler?: (guildId: string, channel: DiscordChannelInfo) => void;

  sentMessages: Array<{ channelId: string; content: string; replyTo?: string }> = [];
  deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  removedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  private nextMessageId = 1;

  get isConnected(): boolean { return true; }
  get botUserId(): string | null { return 'bot_123'; }

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this._messageHandler = handler;
  }
  onMessageEdit(): void {}
  onMessageDelete(): void {}
  onReaction(): void {}
  onReady(): void {}
  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelCreateHandler = handler;
  }
  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this._channelDeleteHandler = handler;
  }
  onGuildCreate(
    handler: (guildId: string, guildName: string, channels: DiscordChannelInfo[]) => void,
  ): void {
    this._guildCreateHandler = handler;
  }
  onChannelAvailable(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelAvailableHandler = handler;
  }
  getGuildName(guildId: string): string {
    return guildId === 'g1' ? 'Test Guild' : guildId;
  }

  async sendMessage(channelId: string, content: string, options?: { replyTo?: string }): Promise<{ messageId: string }> {
    const id = `msg_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId, content, replyTo: options?.replyTo });
    return { messageId: id };
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string }> {
    const id = `dm_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId: `dm:${userId}`, content });
    return { messageId: id };
  }

  async editMessage(): Promise<void> {}

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.deletedMessages.push({ channelId, messageId });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ channelId, messageId, emoji });
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.removedReactions.push({ channelId, messageId, emoji });
  }

  /** Messages the next fetchHistory/fetchAround call should return. Tests set
   *  this to drive the reconnect catch-up sweep. */
  historyToReturn: Array<{
    id: string; authorId: string; authorName: string; isBot: boolean;
    content: string; cleanContent: string; attachments: never[]; mentionsBot: boolean; timestamp: Date;
    reactions?: Array<{ emoji: string; emojiId: string | null; token: string; count: number; me: boolean }>;
  }> = [];
  channelMeta = { name: 'general', guildId: 'g1', guildName: 'Test Guild', isDM: false };

  /** Every fetchHistory call's arguments, oldest first — lets a test assert
   *  which anchor a sweep or gap fetch used. */
  historyCalls: Array<{ channelId: string; opts: Record<string, unknown> | undefined }> = [];

  async fetchHistory(channelId?: string, opts?: Record<string, unknown>): Promise<MockDiscordAdapter['historyToReturn']> {
    this.historyCalls.push({ channelId: channelId ?? '', opts });
    return this.historyToReturn;
  }

  async fetchAround(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  async getChannelMeta(): Promise<MockDiscordAdapter['channelMeta']> {
    return this.channelMeta;
  }

  /** Gateway-cache metadata by raw channel id. Empty by default so tests of
   *  the REST fallback keep exercising getChannelMeta. */
  cachedChannelMeta: Record<string, MockDiscordAdapter['channelMeta']> = {};

  getCachedChannelMeta(channelId: string): MockDiscordAdapter['channelMeta'] | null {
    return this.cachedChannelMeta[channelId] ?? null;
  }

  async listGuilds(): Promise<Array<{ id: string; name: string; memberCount: number }>> {
    return [{ id: 'g1', name: 'Test Guild', memberCount: 10 }];
  }

  async listChannels(): Promise<DiscordChannelInfo[]> {
    return [
      { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' },
      { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' },
    ];
  }

  /** Channel-members fixture; tests may reassign. */
  channelMembersToReturn = {
    channelId: 'c1',
    channelName: 'general',
    scope: 'guild-channel' as const,
    total: 3,
    members: [
      { id: 'u1', username: 'ra', displayName: 'Ra', isBot: false },
      { id: 'u2', username: 'tessera', displayName: 'Tessera', isBot: false },
      { id: 'b1', username: 'connectome', displayName: 'Connectome', isBot: true },
    ],
    truncated: false,
  };

  async listChannelMembers(channelId: string): Promise<MockDiscordAdapter['channelMembersToReturn']> {
    return { ...this.channelMembersToReturn, channelId };
  }

  async createTextChannel(): Promise<DiscordChannelInfo> {
    return { id: 'c_new', name: 'new-channel', type: 'text', label: '#new-channel (TestGuild)' };
  }

  async deleteChannel(): Promise<void> {}

  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    return [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' } },
    ];
  }

  /** Simulate an incoming Discord message (for push event / channels/incoming tests). */
  simulateMessage(msg: DiscordMessageData): void {
    this._messageHandler?.(msg);
  }

  /** Simulate the bot joining a new guild after startup. */
  simulateGuildCreate(guildId: string, guildName: string, channels: DiscordChannelInfo[]): void {
    this._guildCreateHandler?.(guildId, guildName, channels);
  }

  /** Simulate the bot being granted access to a pre-existing channel. */
  simulateChannelAvailable(guildId: string, channel: DiscordChannelInfo): void {
    this._channelAvailableHandler?.(guildId, channel);
  }
}

// ── Test Helpers ──

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

/** Perform MCPL handshake from client side with MCPL capabilities. */
async function mcplHandshake(client: McplConnection, inferenceLifecycle = false): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {
      experimental: {
        mcpl: {
          version: '0.4',
          pushEvents: true,
          channels: true,
          rollback: true,
          ...(inferenceLifecycle ? { inferenceLifecycle: true } : {}),
        },
      },
    },
    clientInfo: { name: 'test-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  // 0.5 host behavior: settle the §5.3 initial policy right after
  // initialize. This is also what releases the server's policy-gated channel
  // registration + reconnect sweep (see serve()) — without it every test
  // sits out the 20s pre-0.5 grace before channels/register arrives.
  const receipt = (await client.sendRequest('featureSets/update', {
    enabled: ['discord.messaging', 'discord.channels', 'discord.history', 'discord.subscriptions'],
  })) as { accepted: boolean };
  assert.equal(receipt.accepted, true);
  return result;
}

/** Perform MCP-only handshake (no MCPL capabilities). */
async function mcpHandshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

// ── Tests ──

describe('DiscordMcplServer', () => {
  it('MCPL handshake exposes feature sets and channels', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);

    // Start server in background
    const serverPromise = server.serve(serverConn);

    // Client: handshake + accept channel registration
    const initResult = await mcplHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    const mcpl = initResult.capabilities.experimental?.mcpl as McplCapabilities;
    assert.ok(mcpl);
    assert.equal(mcpl.pushEvents, true);
    assert.equal(mcpl.channels, true);
    assert.equal(mcpl.rollback, true);
    assert.ok(mcpl.featureSets);
    // This server advertises the legacy ARRAY form (hashed verbatim per the
    // conformance corpus; hosts normalize it — af feature-set-manager). The
    // 0.5 core type is `Record<string, FeatureSetDeclaration> | boolean`, so
    // narrow explicitly to the wire shape actually sent.
    const declaredSets = mcpl.featureSets as unknown as Array<{ name: string }>;
    assert.equal(declaredSets.length, 4);
    assert.equal(declaredSets[0].name, 'discord.messaging');
    assert.ok(
      declaredSets.some((fs) => fs.name === 'discord.subscriptions'),
      'discord.subscriptions feature set should be declared',
    );

    // Server should register channels — accept the request
    const regMsg = await client.nextMessage();
    assert.equal(regMsg.type, 'request');
    if (regMsg.type === 'request') {
      assert.equal(regMsg.request.method, 'channels/register');
      const p = regMsg.request.params as ChannelsRegisterParams;
      assert.equal(p.channels.length, 2);
      assert.equal(p.channels[0].type, 'discord');
      client.sendResponse(regMsg.request.id, {});
    }

    client.close();
    await serverPromise;
  });

  it('MCP-only handshake omits MCPL extensions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    const initResult = await mcpHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    // No MCPL capabilities in MCP mode
    assert.equal(initResult.capabilities.experimental, undefined);
    // But tools should be declared
    assert.ok(initResult.capabilities.tools);

    client.close();
    await serverPromise;
  });

  it('tools/list returns tool definitions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/list', {})) as { tools: Array<{ name: string }> };
    assert.ok(result.tools.length > 0);
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('send_message'));
    assert.ok(names.includes('list_channels'));
    assert.ok(names.includes('fetch_history'));

    client.close();
    await serverPromise;
  });

  it('tools/call list_channel_members returns the membership snapshot', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'list_channel_members',
      arguments: { channelId: 'c1' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.ok(!result.isError);
    const payload = JSON.parse(result.content[0]?.text ?? 'null');
    assert.equal(payload.channelId, 'c1');
    assert.equal(payload.scope, 'guild-channel');
    assert.equal(payload.total, 3);
    assert.equal(payload.members.length, 3);
    assert.equal(payload.members[0].username, 'ra');
    assert.equal(payload.truncated, false);

    client.close();
    await serverPromise;
  });

  it('tools/call send_message works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'send_message',
      arguments: { channelId: 'c1', content: 'Hello from test!' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.ok(!result.isError);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].channelId, 'c1');
    assert.equal(discord.sentMessages[0].content, 'Hello from test!');

    client.close();
    await serverPromise;
  });

  it('tools/call remove_reaction removes only this bot reaction through the adapter', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'remove_reaction',
      arguments: { channelId: 'c1', messageId: 'm1', emoji: '🫥' },
    })) as { isError?: boolean };

    assert.ok(!result.isError);
    assert.deepEqual(discord.removedReactions, [
      { channelId: 'c1', messageId: 'm1', emoji: '🫥' },
    ]);

    client.close();
    await serverPromise;
  });

  it('/undo leaves awareness reactions to the host durable ledger', async () => {
    const discord = new MockDiscordAdapter();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter) as any;
    server.conn = {
      sendRequest: async () => ({
        ok: true,
        messagesRemoved: 1,
        removedRefs: [
          { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' },
        ],
        lastVisible: null,
      }),
    };
    let reply = '';
    const interaction = {
      commandName: 'undo',
      user: { id: 'admin-1', username: 'Admin' },
      channelId: 'c1',
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async (content: string) => { reply = content; },
      reply: async () => {},
    };
    const previousAdmins = process.env.DISCORD_ADMIN_USERS;
    process.env.DISCORD_ADMIN_USERS = 'admin-1';
    try {
      await server.handleSlashCommand(interaction);
    } finally {
      if (previousAdmins === undefined) delete process.env.DISCORD_ADMIN_USERS;
      else process.env.DISCORD_ADMIN_USERS = previousAdmins;
    }

    assert.equal(discord.reactions.length, 0);
    assert.match(reply, /old branch preserved/);
  });

  it('tools/call list_guilds works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'list_guilds',
      arguments: {},
    })) as { content: Array<{ type: string; text?: string }> };

    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('Test Guild'));

    client.close();
    await serverPromise;
  });

  it('push event from Discord message (non-open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate a Discord message (mentioning the bot so it passes the filter)
    discord.simulateMessage({
      id: 'dm1',
      content: 'Hello agent!',
      cleanContent: 'Hello agent!',
      authorId: 'u1',
      authorName: 'Alice',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      replyToId: 'parent-closed-42',
      replyToUserId: 'u_fable',
      replyToUserName: 'Fable',
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive push/event (channel not open)
    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      assert.equal(p.featureSet, 'discord.messaging');
      assert.ok(p.payload.content[0].type === 'text');
      const rendered = (p.payload.content[0] as { text?: string }).text ?? '';
      assert.ok(!rendered.includes('<backscroll'), 'a closed-channel mention must not auto-fetch history');
      assert.ok(rendered.includes('[replying to @Fable]'));
      const origin = p.origin as Record<string, unknown>;
      assert.equal(origin.replyTo, 'parent-closed-42');
      assert.equal(origin.replyToAuthorId, 'u_fable');
      assert.equal(origin.replyToAuthorName, 'Fable');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('first inbound DM carries a reply affordance (send_dm by sender name/id)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate an inbound DM (guildId null → DM; needs no mention to forward).
    discord.simulateMessage({
      id: 'dmmsg1',
      content: 'hey, can you help?',
      cleanContent: 'hey, can you help?',
      authorId: 'u_alice',
      authorName: 'Alice',
      isBot: false,
      channelId: 'dmchan1',
      channelName: undefined,
      guildId: null,
      guildName: undefined,
      mentions: [],
      attachments: [],
      timestamp: new Date(),
    } as unknown as DiscordMessageData);

    // The first inbound DM registers the channel as a real descriptor and
    // announces it via channels/changed BEFORE the push/event — that's what
    // lets channel_open/isOpen resolve DM ids so open state sticks
    // (the Mythos reopen-every-message complaint, 2026-07-18/24).
    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string; label?: string }> };
      assert.ok(p.added?.some((d) => d.id === 'discord:dm:dmchan1'), 'DM channel should be announced');
      assert.ok(
        p.added?.some((d) => d.id === 'discord:dm:dmchan1' && d.label === 'DM: Alice'),
        'DM descriptor should be labeled with the sender',
      );
    }

    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      const text = (p.payload.content[0] as { text?: string }).text ?? '';
      // The bare body is still there…
      assert.ok(text.includes('Alice: hey, can you help?'), 'DM body should render the sender');
      // …plus an explicit, in-context reply affordance so the agent knows it can
      // reply by name/id rather than needing the bot's own user id (the complaint).
      assert.ok(text.includes('Direct message from @Alice'), 'DM should announce the sender');
      assert.ok(text.includes('send_dm("Alice")'), 'DM should suggest replying by sender name');
      assert.ok(text.includes('send_dm("u_alice")'), 'DM should offer the id fallback');
      // The chat:dm tags still ride along for the host gate.
      assert.ok(p.tags?.includes('chat:dm'), 'DM should carry the chat:dm tag');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('first-DM backscroll lines carry current reaction state (issue #31)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    // One earlier message in the DM, with a live reaction on it.
    discord.historyToReturn = [
      {
        id: 'old1', authorId: 'u_bob', authorName: 'Bob', isBot: false,
        content: 'earlier note', cleanContent: 'earlier note', attachments: [],
        mentionsBot: false, timestamp: new Date(1700000000000),
        reactions: [{ emoji: '😀', emojiId: null, token: '😀', count: 3, me: false }],
      },
    ];
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    discord.simulateMessage({
      id: 'dmmsg2', content: 'hi again', cleanContent: 'hi again',
      authorId: 'u_bob', authorName: 'Bob', isBot: false,
      channelId: 'dmchan2', channelName: undefined, guildId: null, guildName: undefined,
      mentions: [], attachments: [], timestamp: new Date(),
    } as unknown as DiscordMessageData);

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');

    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      const p = pushMsg.request.params as PushEventParams;
      const text = (p.payload.content[0] as { text?: string }).text ?? '';
      assert.ok(text.includes('<backscroll'), 'first DM renders backscroll');
      const line = text.split('\n').find((l) => l.includes('earlier note'));
      assert.ok(line?.includes('[reactions: 😀 x3]'), `backscroll line shows current reaction state: ${line}`);
      // The triggering message itself has no fetched reaction state and no
      // suffix — absence must honestly mean "none", not "unknown".
      const trigger = text.split('\n').find((l) => l.includes('hi again'));
      assert.ok(trigger && !trigger.includes('[reactions:'), 'no suffix on the live triggering message');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('channels/incoming from Discord message (open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Open a channel
    const openResult = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
    })) as ChannelsOpenResult;
    assert.ok(openResult.channel.id.includes('c1'));

    // Simulate a Discord message on the open channel (mentioning bot)
    discord.simulateMessage({
      id: 'dm2',
      content: 'Message on open channel',
      cleanContent: 'Message on open channel',
      authorId: 'u1',
      authorName: 'Bob',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive channels/incoming (not push/event)
    const inMsg = await client.nextMessage();
    assert.equal(inMsg.type, 'request');
    if (inMsg.type === 'request') {
      assert.equal(inMsg.request.method, 'channels/incoming');
      const p = inMsg.request.params as ChannelsIncomingParams;
      assert.equal(p.messages.length, 1);
      assert.equal(p.messages[0].author.name, 'Bob');
      client.sendResponse(inMsg.request.id, { results: [{ messageId: 'dm2', accepted: true }] });
    }

    client.close();
    await serverPromise;
  });

  it('renders reply target visibly and carries standard metadata on open channels', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});
    await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
    });

    discord.simulateMessage({
      id: 'reply1', content: 'go ahead', cleanContent: 'go ahead',
      authorId: 'u_antra', authorName: 'Antra', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      replyToId: 'parent42', replyToUserId: 'u_fable', replyToUserName: 'Fable',
      mentions: [], attachments: [], timestamp: new Date(),
    });

    const incoming = await client.nextMessage();
    assert.equal(incoming.type, 'request');
    if (incoming.type === 'request') {
      const p = incoming.request.params as ChannelsIncomingParams;
      const msg = p.messages[0];
      const text = (msg.content[0] as { text?: string }).text ?? '';
      assert.ok(text.includes('[replying to @Fable]'));
      assert.ok(text.includes('Antra: go ahead'));
      const metadata = (msg.metadata ?? {}) as Record<string, unknown>;
      assert.equal(metadata.replyTo, 'parent42');
      assert.equal(metadata.replyToAuthorId, 'u_fable');
      assert.equal(metadata.replyToAuthorName, 'Fable');
      client.sendResponse(incoming.request.id, { results: [{ messageId: 'reply1', accepted: true }] });
    }

    client.close();
    await serverPromise;
  });

  it('open/close own Discord subscription lifecycle, history, and acknowledgment', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    discord.historyToReturn = [{
      id: 'old1', authorId: 'u1', authorName: 'Alice', isBot: false,
      content: 'prior context', cleanContent: 'prior context', attachments: [],
      mentionsBot: false, timestamp: new Date('2026-01-01T00:00:00Z'),
    }];
    const opened = await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1',
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
      history: { limit: 10, beforeMessageId: 'trigger1' },
    }) as ChannelsOpenResult & { history?: ChannelsIncomingParams['messages'] };
    assert.equal(opened.channel.id, 'discord:g1:c1');
    assert.equal(opened.history?.length, 1);
    assert.equal(opened.history?.[0].messageId, 'old1');

    const ack = await client.sendRequest('channels/acknowledge', {
      channelId: 'discord:g1:c1',
      messageId: 'trigger1',
      intent: 'seen-not-opening',
      value: '👀',
    }) as { acknowledged: boolean; representation?: string };
    assert.equal(ack.acknowledged, true);
    assert.equal(ack.representation, '👀');
    assert.deepEqual(discord.reactions, [{ channelId: 'c1', messageId: 'trigger1', emoji: '👀' }]);

    const closed = await client.sendRequest('channels/close', {
      channelId: 'discord:g1:c1',
    }) as { closed: boolean };
    assert.equal(closed.closed, true);

    discord.simulateMessage({
      id: 'after-close', content: 'still there?', cleanContent: 'still there?',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Guild',
      mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    const pushed = await client.nextMessage();
    assert.equal(pushed.type, 'request');
    if (pushed.type === 'request') {
      assert.equal(pushed.request.method, 'push/event');
      client.sendResponse(pushed.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('channels/publish sends Discord message', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    const pubResult = (await client.sendRequest(method.CHANNELS_PUBLISH, {
      conversationId: 'conv_1',
      channelId: 'discord:g1:c1',
      content: [{ type: 'text', text: 'Published message!' }],
    })) as ChannelsPublishResult;

    assert.ok(pubResult.delivered);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].content, 'Published message!');

    client.close();
    await serverPromise;
  });

  it('guildCreate registers new guild channels via channels/changed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept the initial channel registration.
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot joins a new guild after startup.
    discord.simulateGuildCreate('g2', 'Second Guild', [
      { id: 'c10', name: 'lobby', type: 'text', label: '#lobby (TestGuild)' },
      { id: 'c11', name: 'random', type: 'text', label: '#random (TestGuild)' },
    ]);

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 2);
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c10'));
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c11'));
    }

    client.close();
    await serverPromise;
  });

  it('channelAvailable registers a newly-permitted channel', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot granted access to a pre-existing private channel in g1.
    discord.simulateChannelAvailable('g1', { id: 'c-private', name: 'secret', type: 'text', label: '#secret (TestGuild)' });

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c-private');
    }

    client.close();
    await serverPromise;
  });

  it('refresh_channels registers channels visible after startup', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // The bot's view now includes a channel not present at boot.
    discord.getTextChannels = () => [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text', label: '#general (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text', label: '#dev (TestGuild)' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c3', name: 'new-room', type: 'text', label: '#new-room (TestGuild)' } },
    ];

    const callP = client.sendRequest('tools/call', {
      name: 'refresh_channels',
      arguments: {},
    });

    // The refresh emits a channels/changed notification for the new channel.
    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c3');
    }

    const result = (await callP) as { content: Array<{ type: string; text?: string }> };
    const payload = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(payload.visible, 3);
    assert.equal(payload.added.length, 1);
    assert.equal(payload.added[0].id, 'discord:g1:c3');

    client.close();
    await serverPromise;
  });

  it('reconnect sweep delivers missed mentions with nearby context from a non-subscribed channel', async () => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      // Two messages arrived while offline: one plain, one @mentioning the bot.
      // Channel c1 is NOT subscribed, so the mention and its bounded vicinity
      // should be delivered, while the mention count remains one.
      const t = new Date();
      discord.historyToReturn = [
        { id: '101', authorId: 'u1', authorName: 'Alice', isBot: false, content: 'just chatting', cleanContent: 'just chatting', attachments: [], mentionsBot: false, timestamp: t, reactions: [] },
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: t, reactions: [
          { emoji: '👍', emojiId: null, token: '👍', count: 2, me: true },
          { emoji: ':blob:', emojiId: '333444555666777888', token: '<:blob:333444555666777888>', count: 1, me: false },
        ] },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);

      await mcplHandshake(client);

      // Accept channel registration.
      const regMsg = await client.nextMessage();
      assert.equal(regMsg.type, 'request');
      if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

      // Next: the catch-up push/event for the missed mention.
      const missed = await client.nextMessage();
      assert.equal(missed.type, 'request');
      if (missed.type === 'request') {
        assert.equal(missed.request.method, method.PUSH_EVENT);
        const p = missed.request.params as PushEventParams;
        assert.equal(p.eventId, 'discord_missed_c1_102');
        const origin = p.origin as Record<string, unknown>;
        assert.equal(origin.isMention, true);
        assert.equal(origin.isDM, false);
        const text = (p.payload.content[0] as { text: string }).text;
        assert.ok(text.includes('count="1"'), 'only one delivered line is a mention');
        assert.ok(text.includes('lines="2"'), 'the nearby context line is included');
        assert.ok(text.includes('reason="mention"'));
        assert.ok(text.includes('Bob'), 'mention author present');
        assert.ok(text.includes('just chatting'), 'nearby non-mention context included');
        // Current NET reaction state rides along on missed lines (issue #31):
        // aggregate + count (+ bot-self), never an add/remove event replay.
        assert.ok(text.includes('[reactions: 👍 x2 (incl. me), :blob: x1]'), 'current reaction state on the mention line');
        const contextLine = text.split('\n').find((l) => l.includes('just chatting'));
        assert.ok(contextLine && !contextLine.includes('[reactions:'), 'no suffix on a reaction-less message — absence means none');
        client.sendResponse(missed.request.id, {});
      }

      client.close();
      await serverPromise;
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  });

  it('tracks missed ambient after unsubscribe and reports via channel_missed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.sendRequest('tools/call', { name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = r.content[0]?.text ?? '';
      // Object-returning tools (channel_missed) serialize as JSON; string-
      // returning tools (subscribe/unsubscribe) come through as plain text.
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };

    // Open then close c1 — this anchors a missed-ambient tally.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    await client.sendRequest('channels/close', { channelId: 'discord:g1:c1' });

    // Ambient message in c1 (not a mention, not a DM, now unsubscribed) → dropped + tallied.
    discord.simulateMessage({
      id: 'm100', content: 'hello world', cleanContent: 'hello world',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: [], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    // Let the floating async message handler run.
    await new Promise((r) => setTimeout(r, 20));

    const missed = await call('channel_missed', { channelId: 'c1' });
    assert.equal(missed.subscribed, false);
    assert.equal(missed.tracked, true);
    assert.equal(missed.missedMessages, 1);
    assert.equal(missed.missedCharacters, 'hello world'.length);
    // Issue #28: raw id stays load-bearing, labels + composite id resolved
    // from local metadata (registered descriptor here — no REST).
    assert.equal(missed.channelId, 'c1');
    assert.equal(missed.mcplChannelId, 'discord:g1:c1');
    assert.equal(missed.channelName, 'general');
    assert.equal(missed.guildName, 'Test Guild');
    assert.equal(missed.metadataResolved, true);

    // A mention while closed+tracked: the push/event origin must carry the
    // tally, so the host's closed-channel invitation can show the agent what
    // staying out has cost (2026-08-05 — informed reply-without-joining).
    discord.simulateMessage({
      id: 'm101', content: '<@bot_123> you there?', cleanContent: '@bot you there?',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: ['bot_123'], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    const mentionPush = await client.nextMessage();
    assert.equal(mentionPush.type, 'request');
    if (mentionPush.type === 'request') {
      assert.equal(mentionPush.request.method, 'push/event');
      const p = mentionPush.request.params as PushEventParams;
      const origin = p.origin as Record<string, unknown>;
      assert.equal(origin.missedMessages, 1);
      assert.equal(origin.missedCharacters, 'hello world'.length);
      client.sendResponse(mentionPush.request.id, { accepted: true });
    }
    // The mention itself is delivered, never "missed" — tally unchanged.
    const still = await call('channel_missed', { channelId: 'c1' });
    assert.equal(still.missedMessages, 1);

    // Reopening clears the tally.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    const after = await call('channel_missed', { channelId: 'c1' });
    assert.equal(after.subscribed, true);
    assert.equal(after.missedMessages, 0);

    client.close();
    await serverPromise;
  });

  it('labels list_subscriptions backlog rows and flags unresolvable lookups (issue #28)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.sendRequest('tools/call', { name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      return JSON.parse(r.content[0]?.text ?? '{}');
    };

    // Anchor a tally on c1, then let an ambient message accrue.
    await client.sendRequest('channels/open', {
      channelId: 'discord:g1:c1', type: 'discord', address: { guildId: 'g1', channelId: 'c1' },
    });
    await client.sendRequest('channels/close', { channelId: 'discord:g1:c1' });
    discord.simulateMessage({
      id: 'm200', content: 'ambient', cleanContent: 'ambient',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: [], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    await new Promise((r) => setTimeout(r, 20));

    const subs = await call('list_subscriptions', {});
    assert.equal(subs.unsubscribedWithBacklog.length, 1);
    const row = subs.unsubscribedWithBacklog[0];
    assert.equal(row.channelId, 'c1');
    assert.equal(row.mcplChannelId, 'discord:g1:c1');
    assert.equal(row.channelName, 'general');
    assert.equal(row.guildId, 'g1');
    assert.equal(row.guildName, 'Test Guild');
    assert.equal(row.metadataResolved, true);
    assert.equal(row.missedMessages, 1);

    // The gateway cache wins over the descriptor when present (fresher name).
    discord.cachedChannelMeta['c1'] = {
      name: 'general-renamed', guildId: 'g1', guildName: 'Test Guild', isDM: false,
    };
    const renamed = await call('channel_missed', { channelId: 'c1' });
    assert.equal(renamed.channelName, 'general-renamed');
    assert.equal(renamed.metadataResolved, true);

    // Unknown channel: failure is explicit, not an indistinguishable omission,
    // and the raw id survives.
    const unknown = await call('channel_missed', { channelId: 'c_ghost' });
    assert.equal(unknown.tracked, false);
    assert.equal(unknown.channelId, 'c_ghost');
    assert.equal(unknown.mcplChannelId, null);
    assert.equal(unknown.channelName, null);
    assert.equal(unknown.metadataResolved, false);

    client.close();
    await serverPromise;
  });
});

describe('applyMentionCandidates', () => {
  const cands: MentionCandidate[] = [
    { id: 'u_alice', aliases: ['Alice', 'alice_g'], kind: 'user' },
    { id: 'r_mods', aliases: ['Moderators'], kind: 'role' },
    { id: 'u_mods', aliases: ['Moderators'], kind: 'user' }, // name collision w/ role
    { id: 'r_team', aliases: ['Team'], kind: 'role' },
  ];

  it('resolves a role mention to <@&id>', () => {
    assert.equal(applyMentionCandidates('ping @Team please', cands), 'ping <@&r_team> please');
  });

  it('resolves a user mention to <@id>', () => {
    assert.equal(applyMentionCandidates('hi @Alice', cands), 'hi <@u_alice>');
  });

  it('is case-insensitive for roles', () => {
    assert.equal(applyMentionCandidates('@team', cands), '<@&r_team>');
  });

  it('prefers a user over a role on a name collision', () => {
    // Both u_mods (user) and r_mods (role) are named "Moderators" → user wins.
    assert.equal(applyMentionCandidates('@Moderators', cands), '<@u_mods>');
  });

  it('leaves @everyone / @here untouched', () => {
    assert.equal(applyMentionCandidates('@everyone @here', cands), '@everyone @here');
  });

  it('leaves unknown handles untouched', () => {
    assert.equal(applyMentionCandidates('@nobody', cands), '@nobody');
  });

  it('falls through to a role only when no user matches', () => {
    const roleOnly: MentionCandidate[] = [{ id: 'r_x', aliases: ['Ops'], kind: 'role' }];
    assert.equal(applyMentionCandidates('@Ops', roleOnly), '<@&r_x>');
  });

  it('does not resolve when a role name is ambiguous', () => {
    const ambiguous: MentionCandidate[] = [
      { id: 'r_a', aliases: ['Dup'], kind: 'role' },
      { id: 'r_b', aliases: ['Dup'], kind: 'role' },
    ];
    assert.equal(applyMentionCandidates('@Dup', ambiguous), '@Dup');
  });
});


// ── Read anchor: forwarded vs seen, driven by inference/lifecycle ──

describe('lifecycle-driven seen anchor', () => {
  const guildMsg = (id: string, text: string, mention = true): DiscordMessageData => ({
    id,
    content: mention ? `<@bot_123> ${text}` : text,
    cleanContent: mention ? `@bot ${text}` : text,
    authorId: 'u1',
    authorName: 'Alice',
    isBot: false,
    channelId: 'c1',
    channelName: 'general',
    guildId: 'g1',
    guildName: 'Test Server',
    mentions: mention ? ['bot_123'] : [],
    attachments: [],
    timestamp: new Date(),
  });

  const readFile = (path: string): { watermarks?: Record<string, string>; seen?: Record<string, string> } =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};

  /** Poll the watermark file until `pred` holds (lifecycle commits are async). */
  async function waitForFile(path: string, pred: (f: ReturnType<typeof readFile>) => boolean, ms = 1500): Promise<ReturnType<typeof readFile>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const f = readFile(path);
      if (pred(f)) return f;
      if (Date.now() > deadline) return f;
      await new Promise((r) => setTimeout(r, 25));
    }
  }


  /** Notifications are fire-and-forget; a round-trip on the same connection
   *  guarantees the server has processed everything sent before it. */
  async function lifecycle(client: McplConnection, phase: 'started' | 'completed' | 'aborted', turn: number): Promise<void> {
    client.sendNotification('inference/lifecycle', { inferenceId: `t${turn}`, conversationId: 'x', turnIndex: turn, phase });
    await client.sendRequest('tools/call', { name: 'list_guilds', arguments: {} });
  }

  async function acceptRegistration(client: McplConnection): Promise<void> {
    const regMsg = await client.nextMessage();
    assert.equal(regMsg.type, 'request');
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});
  }

  /** Accept the push/event for a forwarded message and return its rendered text. */
  async function acceptPush(client: McplConnection): Promise<string> {
    const push = await client.nextMessage();
    assert.equal(push.type, 'request');
    if (push.type !== 'request') return '';
    assert.equal(push.request.method, method.PUSH_EVENT);
    client.sendResponse(push.request.id, { accepted: true });
    const p = push.request.params as PushEventParams;
    return (p.payload.content[0] as { text: string }).text;
  }

  async function withWatermarkFile<T>(tag: string, initial: unknown, body: (path: string) => Promise<T>): Promise<T> {
    const path = join(tmpdir(), `discord-mcpl-wm-${process.pid}-${tag}.json`);
    if (initial !== undefined) writeFileSync(path, JSON.stringify(initial));
    else if (existsSync(path)) unlinkSync(path);
    const prev = process.env.DISCORD_WATERMARK_FILE;
    process.env.DISCORD_WATERMARK_FILE = path;
    try {
      return await body(path);
    } finally {
      if (prev === undefined) delete process.env.DISCORD_WATERMARK_FILE;
      else process.env.DISCORD_WATERMARK_FILE = prev;
      if (existsSync(path)) unlinkSync(path);
    }
  }

  it('advertises inferenceLifecycle at initialize', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);
    const init = await mcplHandshake(client);
    const mcpl = init.capabilities?.experimental?.mcpl as Record<string, unknown> | undefined;
    assert.equal(mcpl?.inferenceLifecycle, true);
    await acceptRegistration(client);
    client.close();
    await serverPromise;
  });

  it('anchors move in lockstep until the host has reported a turn', async () => {
    await withWatermarkFile('lockstep', undefined, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client);
      await acceptRegistration(client);

      discord.simulateMessage(guildMsg('101', 'first'));
      await acceptPush(client);
      const f = await waitForFile(path, (f) => f.watermarks?.c1 === '101');
      assert.equal(f.watermarks?.c1, '101');
      assert.equal(f.seen?.c1, '101', 'no lifecycle yet: seen follows forwarded');

      client.close();
      await serverPromise;
    });
  });

  it('once the host reports turns, seen waits for completed', async () => {
    await withWatermarkFile('completed', undefined, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client, true);
      await acceptRegistration(client);

      // Production order: the trigger is forwarded before inference starts.
      discord.simulateMessage(guildMsg('101', 'first'));
      await acceptPush(client);
      let f = await waitForFile(path, (f) => f.watermarks?.c1 === '101');
      await lifecycle(client, 'started', 1)
      assert.equal(f.watermarks?.c1, '101', 'forwarded advances on forward');
      assert.equal(f.seen?.c1, '100', 'seen seeded just before the first forward, not at it');

      await lifecycle(client, 'completed', 1)
      f = await waitForFile(path, (f) => f.seen?.c1 === '101');
      assert.equal(f.seen?.c1, '101', 'completed commits everything forwarded during the turn');

      client.close();
      await serverPromise;
    });
  });

  it('a forward arriving after started is NOT committed by that turn', async () => {
    await withWatermarkFile('after-start', undefined, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client, true);
      await acceptRegistration(client);

      // 101 triggers turn 1 and is snapshotted at started.
      discord.simulateMessage(guildMsg('101', 'first'));
      await acceptPush(client);
      await lifecycle(client, 'started', 1);
      // 102 arrives while turn 1 is already running: it belongs to a successor.
      discord.simulateMessage(guildMsg('102', 'second'));
      await acceptPush(client);
      await lifecycle(client, 'completed', 1);
      let f = await waitForFile(path, (f) => f.seen?.c1 === '101');
      assert.equal(f.watermarks?.c1, '102');
      assert.equal(f.seen?.c1, '101', 'turn 1 cannot claim a post-start forward');

      await lifecycle(client, 'started', 2);
      await lifecycle(client, 'completed', 2);
      f = await waitForFile(path, (f) => f.seen?.c1 === '102');
      assert.equal(f.seen?.c1, '102', 'the successor commits its own snapshot');

      client.close();
      await serverPromise;
    });
  });

  it('an aborted turn leaves seen where it was', async () => {
    await withWatermarkFile('aborted', undefined, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client, true);
      await acceptRegistration(client);

      discord.simulateMessage(guildMsg('101', 'first'));
      await acceptPush(client);
      await waitForFile(path, (f) => f.watermarks?.c1 === '101');
      await lifecycle(client, 'started', 1)
      await lifecycle(client, 'aborted', 1)
      // A later completed (of an unrelated, empty turn) must not sweep the
      // discarded forward into seen.
      await lifecycle(client, 'completed', 2)
      await new Promise((r) => setTimeout(r, 150));
      const f = readFile(path);
      assert.equal(f.watermarks?.c1, '101');
      assert.equal(f.seen?.c1, '100', 'aborted: the forward was never read');

      client.close();
      await serverPromise;
    });
  });

  it('after an abort, the next addressed forward carries the unread gap', async () => {
    await withWatermarkFile('gap', undefined, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client, true);
      await acceptRegistration(client);

      discord.simulateMessage(guildMsg('101', 'first'));
      await acceptPush(client);
      await waitForFile(path, (f) => f.watermarks?.c1 === '101');
      await lifecycle(client, 'started', 1)
      await lifecycle(client, 'aborted', 1)
      await new Promise((r) => setTimeout(r, 100));

      // The gap fetch returns the message that fell into the aborted turn.
      discord.historyCalls = [];
      discord.historyToReturn = [
        { id: '101', authorId: 'u1', authorName: 'Alice', isBot: false, content: '<@bot_123> first', cleanContent: '@bot first', attachments: [], mentionsBot: true, timestamp: new Date(), reactions: [] },
      ];
      discord.simulateMessage(guildMsg('102', 'second'));
      const text = await acceptPush(client);
      await lifecycle(client, 'started', 2)
      assert.ok(text.includes('<unacknowledged channelId="c1" count="1" since="100">'), `gap block present: ${text}`);
      assert.ok(text.includes('id=101] Alice: @bot first'), 'the aborted-turn message is in the gap');
      assert.ok(text.includes('Alice: @bot second'), 'followed by the message that woke us');
      const gapFetch = discord.historyCalls.find((c) => c.channelId === 'c1');
      assert.equal(gapFetch?.opts?.after, '100', 'gap fetched from the seen anchor');
      assert.equal(gapFetch?.opts?.before, '102', 'up to (excluding) the waking message');

      await lifecycle(client, 'completed', 2)
      const f = await waitForFile(path, (f) => f.seen?.c1 === '102');
      assert.equal(f.seen?.c1, '102', 'the completed turn covered the gap and the new message');

      client.close();
      await serverPromise;
    });
  });

  it('the boot sweep anchors on seen, not forwarded', async () => {
    await withWatermarkFile('sweep-seen', { watermarks: { c1: '102' }, seen: { c1: '100' }, dmChannels: [] }, async () => {
      const { client, serverConn, discord } = await createTestPair();
      const t = new Date();
      discord.historyToReturn = [
        { id: '101', authorId: 'u1', authorName: 'Alice', isBot: false, content: '<@bot_123> lost one', cleanContent: '@bot lost one', attachments: [], mentionsBot: true, timestamp: t, reactions: [] },
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> lost two', cleanContent: '@bot lost two', attachments: [], mentionsBot: true, timestamp: t, reactions: [] },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client);
      await acceptRegistration(client);

      const text = await acceptPush(client);
      assert.ok(text.includes('<missed'), `sweep re-delivered the unread tail: ${text}`);
      assert.ok(text.includes('lost one') && text.includes('lost two'));
      const sweepFetch = discord.historyCalls.find((c) => c.channelId === 'c1');
      assert.equal(sweepFetch?.opts?.after, '100', 'scanned from seen, though forwarded was already 102');

      client.close();
      await serverPromise;
    });
  });

  it('a pre-split watermark file seeds seen from forwarded (no replay on upgrade)', async () => {
    await withWatermarkFile('upgrade', { watermarks: { c1: '102' }, dmChannels: [] }, async (path) => {
      const { client, serverConn, discord } = await createTestPair();
      discord.historyToReturn = [];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);
      await mcplHandshake(client);
      await acceptRegistration(client);
      // Let the sweep run (it fetches, finds nothing, delivers nothing).
      await new Promise((r) => setTimeout(r, 150));
      const sweepFetch = discord.historyCalls.find((c) => c.channelId === 'c1');
      assert.equal(sweepFetch?.opts?.after, '102', 'anchored on the old forward mark, not the beginning of time');

      // First forward under a turn-reporting host: seen is persisted alongside.
      await lifecycle(client, 'started', 1)
      discord.simulateMessage(guildMsg('103', 'after upgrade'));
      await acceptPush(client);
      const f = await waitForFile(path, (f) => f.watermarks?.c1 === '103');
      assert.equal(f.seen?.c1, '102', 'seeded seen survives; new forward pending until completed');

      client.close();
      await serverPromise;
    });
  });
});
