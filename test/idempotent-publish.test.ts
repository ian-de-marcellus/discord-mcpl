/**
 * Idempotent channels/publish: a host retry of the same speech (same
 * idempotencyKey) never posts twice, whether the first attempt is still
 * running, finished in this process, or posted before a restart. Late
 * deliveries carry a small marker with the original time.
 *
 * The fake channel behaves like Discord where it matters: real snowflake
 * ids, history fetch by `after`, and nonce enforcement only within a window
 * (Discord's is "a few minutes"), so the history check is proven on its own.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter, PartialSendError } from '../src/discord-adapter.js';
import { DiscordMcplServer } from '../src/server.js';
import { LATE_AFTER_MS, lateMarker, nonceFor, snowflakeAt, stripLateMarker } from '../src/late-delivery.js';

interface Posted { id: string; content: string; nonce?: string; createdTimestamp: number; author: { id: string } }

function fakeChannel(opts: { nonceWindowMs?: number; hangOn?: (n: number) => boolean; failFetch?: boolean } = {}) {
  const posted: Posted[] = [];
  const sends: Array<{ content?: string; nonce?: string; enforceNonce?: boolean }> = [];
  let clock = Date.now();
  const channel = {
    send: (payload: { content?: string; nonce?: string; enforceNonce?: boolean }) => {
      sends.push(payload);
      const now = (clock += 1000);
      if (payload.enforceNonce && payload.nonce) {
        const prior = posted.find((p) => p.nonce === payload.nonce && now - p.createdTimestamp <= (opts.nonceWindowMs ?? 180_000));
        if (prior) return Promise.resolve({ id: prior.id });
      }
      const msg: Posted = { id: snowflakeAt(now), content: payload.content ?? '', nonce: payload.nonce, createdTimestamp: now, author: { id: 'bot' } };
      posted.push(msg);
      // Posted on Discord, but the answer never arrives.
      if (opts.hangOn?.(sends.length)) return new Promise<{ id: string }>(() => {});
      return Promise.resolve({ id: msg.id });
    },
    messages: {
      fetch: async ({ after }: { after: string; limit: number }) => {
        if (opts.failFetch) throw new Error('Missing Access');
        return new Map(posted.filter((p) => BigInt(p.id) > BigInt(after)).map((p) => [p.id, p]));
      },
    },
  };
  return { channel, posted, sends, advance: (ms: number) => { clock += ms; } };
}

function adapterFor(channel: unknown) {
  const adapter = new DiscordAdapter({ token: 'not-used' });
  (adapter as unknown as { client: unknown }).client = {
    user: { id: 'bot' },
    channels: { fetch: async () => channel },
  };
  return adapter;
}

const para = (label: string) => `${label} ` + 'lorem ipsum dolor sit amet '.repeat(60).trim();
const LONG = [para('FIRST'), para('SECOND'), para('THIRD')].join('\n');

describe('sendMessage with an idempotencyKey', () => {
  it('every part carries its own nonce with enforce_nonce; no key, no nonce', async () => {
    const f = fakeChannel();
    await adapterFor(f.channel).sendMessage('c1', LONG, { idempotencyKey: 'k1' });
    assert.deepEqual(f.sends.map((s) => s.nonce), [0, 1, 2].map((i) => nonceFor('k1', i)));
    assert.ok(f.sends.every((s) => s.enforceNonce === true));
    assert.ok(f.sends.every((s) => (s.nonce ?? '').length <= 25));
    const g = fakeChannel();
    await adapterFor(g.channel).sendMessage('c1', 'plain');
    assert.equal(g.sends[0]!.nonce, undefined);
  });

  it('within the nonce window, Discord itself returns the original', async () => {
    const f = fakeChannel();
    const a = adapterFor(f.channel);
    const first = await a.sendMessage('c1', 'hello', { idempotencyKey: 'k2' });
    const again = await a.sendMessage('c1', 'hello', { idempotencyKey: 'k2' });
    assert.equal(again.messageId, first.messageId);
    assert.equal(f.posted.length, 1);
  });

  it('after a restart and past the nonce window, history finds posted parts and only the rest is sent', async () => {
    // Part 2 posts but its answer never comes: a partial send.
    const f = fakeChannel({ nonceWindowMs: 0, hangOn: (n) => n === 2 });
    const writtenAt = Date.now();
    await assert.rejects(
      adapterFor(f.channel).sendMessage('c1', LONG, { idempotencyKey: 'k3', deadlineMs: 50 }),
      PartialSendError,
    );
    assert.equal(f.posted.length, 2, 'parts 1 and 2 are on Discord');

    // A fresh adapter (the connector restarted), minutes later.
    f.advance(10 * 60_000);
    const res = await adapterFor(f.channel).sendMessage('c1', LONG, { idempotencyKey: 'k3', resumeSince: writtenAt });
    assert.equal(res.resumed, 2);
    assert.equal(f.posted.length, 3, 'only part 3 was sent');
    assert.ok(f.posted[2]!.content.startsWith('THIRD'));
    assert.deepEqual(res.messageIds, f.posted.map((p) => p.id));
  });

  it('everything already posted: nothing is sent', async () => {
    const f = fakeChannel({ nonceWindowMs: 0 });
    const writtenAt = Date.now();
    await adapterFor(f.channel).sendMessage('c1', 'short reply', { idempotencyKey: 'k4' });
    f.advance(10 * 60_000);
    const res = await adapterFor(f.channel).sendMessage('c1', 'short reply', { idempotencyKey: 'k4', resumeSince: writtenAt });
    assert.equal(f.posted.length, 1);
    assert.equal(res.messageId, f.posted[0]!.id);
  });

  it('the late marker goes on the first part only, and the history check sees past it', async () => {
    const f = fakeChannel({ nonceWindowMs: 0, hangOn: (n) => n === 2 });
    const writtenAt = Date.now() - 20 * 60_000;
    await assert.rejects(
      adapterFor(f.channel).sendMessage('c1', LONG, { idempotencyKey: 'k5', deadlineMs: 50, lateWrittenAt: writtenAt, lateReason: 'disconnected' }),
      PartialSendError,
    );
    assert.ok(f.posted[0]!.content.startsWith(lateMarker(writtenAt, 'disconnected')));
    assert.ok(!f.posted[1]!.content.startsWith('-#'));
    assert.equal(stripLateMarker(f.posted[0]!.content).slice(0, 5), 'FIRST');

    f.advance(10 * 60_000);
    await adapterFor(f.channel).sendMessage('c1', LONG, { idempotencyKey: 'k5', resumeSince: writtenAt, lateWrittenAt: writtenAt });
    assert.equal(f.posted.length, 3);
  });

  it('a history fetch failure falls back to sending (nonces still guard)', async () => {
    const f = fakeChannel({ failFetch: true });
    const res = await adapterFor(f.channel).sendMessage('c1', 'x', { idempotencyKey: 'k6', resumeSince: Date.now() });
    assert.equal(res.resumed, 0);
    assert.equal(f.posted.length, 1);
  });
});

describe('late marker', () => {
  it('records the composition time and why, not a "late" judgement', () => {
    const t = Date.UTC(2026, 8, 25, 13, 10);
    assert.equal(lateMarker(t, 'disconnected'), `-# written <t:${t / 1000}:t> · connection was down\n`);
    assert.equal(lateMarker(t, 'unanswered'), `-# written <t:${t / 1000}:t> · a send timed out\n`);
    assert.equal(lateMarker(t), `-# written <t:${t / 1000}:t>\n`);
    for (const r of ['disconnected', 'unanswered', undefined] as const) {
      assert.equal(stripLateMarker(lateMarker(t, r) + 'body'), 'body');
    }
    assert.equal(stripLateMarker('-# a user subtext line\nbody'), '-# a user subtext line\nbody');
  });
});

describe('handlePublish with an idempotencyKey', () => {
  function serverWith(sendMessage: (...args: unknown[]) => Promise<{ messageId: string; messageIds: string[]; resumed: number }>) {
    const calls: unknown[][] = [];
    const discord = new Proxy({}, {
      get: (_t, prop) => prop === 'sendMessage'
        ? (...args: unknown[]) => { calls.push(args); return sendMessage(...args); }
        : () => undefined,
    });
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const publish = (params: Record<string, unknown>) =>
      (server as unknown as { handlePublish(p: unknown): Promise<Record<string, unknown>> }).handlePublish({
        conversationId: 'a', channelId: 'discord:g1:c1', content: [{ type: 'text', text: 'hi' }], ...params,
      });
    return { publish, calls };
  }

  it('a retry while the first attempt is still running joins it; a later retry hits the cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = serverWith(async () => { await gate; return { messageId: 'm1', messageIds: ['m1'], resumed: 0 }; });
    const first = s.publish({ idempotencyKey: 'k', writtenAt: new Date().toISOString() });
    const retry = s.publish({ idempotencyKey: 'k', writtenAt: new Date().toISOString() });
    release();
    assert.deepEqual(await first, { delivered: true, messageId: 'm1', idempotencyKey: 'k' });
    assert.deepEqual(await retry, { delivered: true, messageId: 'm1', idempotencyKey: 'k' });
    assert.deepEqual(await s.publish({ idempotencyKey: 'k' }), { delivered: true, messageId: 'm1', idempotencyKey: 'k' });
    assert.equal(s.calls.length, 1, 'one send for three publishes');
  });

  it('fresh publish: no resume check, no marker; old writtenAt: both', async () => {
    const s = serverWith(async () => ({ messageId: 'm', messageIds: ['m'], resumed: 0 }));
    await s.publish({ idempotencyKey: 'fresh', writtenAt: new Date().toISOString() });
    const old = Date.now() - LATE_AFTER_MS - 60_000;
    await s.publish({ idempotencyKey: 'old', writtenAt: new Date(old).toISOString(), delayReason: 'disconnected' });
    await s.publish({ idempotencyKey: 'odd', writtenAt: new Date(old).toISOString(), delayReason: 'gremlins' });
    const opts = s.calls.map((c) => c[2] as Record<string, unknown>);
    assert.deepEqual(opts[0], { idempotencyKey: 'fresh' });
    assert.deepEqual(opts[1], { idempotencyKey: 'old', resumeSince: old, lateWrittenAt: old, lateReason: 'disconnected' });
    assert.deepEqual(opts[2], { idempotencyKey: 'odd', resumeSince: old, lateWrittenAt: old }, 'unknown reasons are not shown');
  });

  it('without a key: unchanged, and the key is not echoed', async () => {
    const s = serverWith(async () => ({ messageId: 'm', messageIds: ['m'], resumed: 0 }));
    assert.deepEqual(await s.publish({}), { delivered: true, messageId: 'm' });
    assert.deepEqual(s.calls[0]![2] ?? {}, {}, 'no idempotency options');
  });
});

describe('send tools with an idempotencyKey in tools/call _meta', () => {
  function server() {
    const sends: unknown[][] = [];
    const discord = new Proxy({}, {
      get: (_t, prop) => prop === 'sendMessage'
        ? async (...args: unknown[]) => { sends.push(args); return { messageId: `m${sends.length}`, messageIds: [`m${sends.length}`], resumed: 0 }; }
        : () => undefined,
    });
    const s = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const call = (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
      (s as unknown as { handleToolCall(n: string, a: unknown, m?: unknown): Promise<Record<string, unknown>> })
        .handleToolCall(name, args, meta);
    return { call, sends };
  }
  const CH = '123456789012345678';

  it('send_message: a repeated key posts once and echoes the key', async () => {
    const s = server();
    const meta = { idempotencyKey: 'tk', writtenAt: new Date().toISOString() };
    const a = await s.call('send_message', { channelId: CH, content: 'hello' }, meta);
    const b = await s.call('send_message', { channelId: CH, content: 'hello' }, meta);
    assert.equal(s.sends.length, 1);
    assert.deepEqual(a._meta, { idempotencyKey: 'tk' });
    assert.deepEqual(b._meta, { idempotencyKey: 'tk' });
    assert.equal((s.sends[0]![2] as Record<string, unknown>).idempotencyKey, 'tk');
  });

  it('reply_message honours the key too; the reply target is kept', async () => {
    const s = server();
    await s.call('reply_message', { channelId: CH, messageId: '223456789012345678', content: 'yes' }, { idempotencyKey: 'rk' });
    const opts = s.sends[0]![2] as Record<string, unknown>;
    assert.equal(opts.idempotencyKey, 'rk');
    assert.equal(opts.replyTo, '223456789012345678');
  });

  it('no key: no echo; other tools never echo', async () => {
    const s = server();
    const plain = await s.call('send_message', { channelId: CH, content: 'x' });
    assert.equal(plain._meta, undefined);
    const other = await s.call('send_dm', { userId: '323456789012345678', content: 'x' }, { idempotencyKey: 'dk' });
    assert.equal(other._meta, undefined, 'send_dm does not dedupe yet, so it must not claim to');
  });
});
