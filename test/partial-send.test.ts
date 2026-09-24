/**
 * A long message goes out as several Discord messages. If Discord stalls
 * partway, the host's MCPL request times out and the agent hears only "timed
 * out" — which reads as "nothing was sent", so it resends everything and the
 * posted parts appear twice (Librarian, 2026-09-23). sendMessage now stops
 * before the host's timeout and reports exactly what was posted, quoting the
 * split points the agent can't otherwise see.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordAdapter, PartialSendError, isPreConnectError } from '../src/discord-adapter.js';

function adapterWithChannel(send: (payload: { content?: string }) => Promise<{ id: string }>) {
  const adapter = new DiscordAdapter({ token: 'not-used' });
  (adapter as unknown as { client: unknown }).client = {
    user: { id: 'bot' },
    channels: { fetch: async () => ({ send }) },
  };
  return adapter;
}

const para = (label: string) => `${label} ` + 'lorem ipsum dolor sit amet '.repeat(60).trim();

describe('sendMessage partial-send reporting', () => {
  it('reports posted parts, the stalled part, and the unsent remainder with boundary quotes', async () => {
    const text = [para('FIRST'), para('SECOND'), para('THIRD')].join('\n');
    let calls = 0;
    const adapter = adapterWithChannel(() => {
      calls++;
      return calls === 1 ? Promise.resolve({ id: 'm1' }) : new Promise(() => {}); // part 2 hangs
    });

    await assert.rejects(
      adapter.sendMessage('c1', text, { deadlineMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof PartialSendError);
        assert.deepEqual(err.sentIds, ['m1']);
        assert.equal(err.stalledIndex, 1);
        assert.match(err.message, /POSTED: part 1 of 3 \(message id m1\), ending with …"/);
        assert.match(err.message, /IN FLIGHT: part 2 of 3, starting "SECOND lorem/);
        assert.match(err.message, /NOT SENT: the remaining 1 part, starting "THIRD lorem/);
        assert.match(err.message, /Do not resend what was posted/);
        assert.ok(err.unsentText.startsWith('THIRD'));
        return true;
      },
    );
    assert.equal(calls, 2, 'no further parts are attempted after the stall');
  });

  it('a send that finishes in time is unchanged', async () => {
    let n = 0;
    const adapter = adapterWithChannel(async () => ({ id: `m${++n}` }));
    const res = await adapter.sendMessage('c1', [para('A'), para('B')].join('\n'), { deadlineMs: 5_000 });
    assert.equal(res.messageId, 'm2');
  });
});

describe('sendMessage connect-failure retries', () => {
  const connectTimeout = () =>
    Object.assign(new Error('Connect Timeout Error (attempted addresses: 162.159.128.233:443, timeout: 10000ms)'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });

  it('retries a part that never reached Discord, then delivers it', async () => {
    let calls = 0;
    const adapter = adapterWithChannel(async () => {
      calls++;
      if (calls <= 2) throw connectTimeout();
      return { id: 'm1' };
    });
    const res = await adapter.sendMessage('c1', 'hello', { deadlineMs: 20_000 });
    assert.equal(res.messageId, 'm1');
    assert.equal(calls, 3);
  });

  it('does not retry errors that may have reached Discord', async () => {
    let calls = 0;
    const adapter = adapterWithChannel(async () => {
      calls++;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    await assert.rejects(adapter.sendMessage('c1', 'hello', { deadlineMs: 20_000 }), /socket hang up/);
    assert.equal(calls, 1);
  });

  it('classifies pre-connect failures', () => {
    assert.equal(isPreConnectError(connectTimeout()), true);
    assert.equal(isPreConnectError(Object.assign(new Error('x'), { cause: { code: 'EAI_AGAIN' } })), true);
    assert.equal(isPreConnectError(new Error('getaddrinfo ENOTFOUND discord.com')), true);
    assert.equal(isPreConnectError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), false);
    assert.equal(isPreConnectError(new Error('Missing Permissions')), false);
  });
});
