/**
 * Login retry after an outage at boot (2026-09-25, 2026-09-26: six residents
 * booted while DNS was down). discord.js destroys the client when login()
 * fails, and `destroyed` is never cleared, so a later successful login on the
 * SAME client receives messages but reports isReady() === false forever:
 * every send waited 60 s and failed "Discord is not connected right now".
 * The destroyed manager also refuses to reconnect its shards after a later
 * drop, and destroy() stops the cache sweepers.
 *
 * Fix: probe the gateway endpoint before any login (an unreachable network
 * never touches the client), and if a login fails anyway, replace the client.
 * whenReady() is owned by the adapter, so waiters survive a replacement.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Client, GatewayIntentBits, Status } from 'discord.js';

const { DiscordAdapter } = await import('../src/discord-adapter.js');

describe('the library behaviour behind the bug', () => {
  it('a failed login leaves the client destroyed: isReady() stays false even at status Ready', async () => {
    // Refused connection = "network down" for the REST call login() makes first.
    const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: 'http://127.0.0.1:9', retries: 0, timeout: 2_000 } });
    await assert.rejects(client.login('not-a-real-token'));
    assert.equal((client.ws as unknown as { destroyed: boolean }).destroyed, true);
    (client.ws as unknown as { status: Status }).status = Status.Ready; // what a later successful login sets
    assert.equal(client.isReady(), false, 'the flag the connector trusted can never recover');
    await client.destroy();
  });
});

/** A stand-in for discord.js Client with the same lifecycle rules:
 *  a failed login destroys it for good. */
class FakeClient extends EventEmitter {
  static made: FakeClient[] = [];
  destroyed = false;
  ready = false;
  logins = 0;
  constructor(private readonly plan: { failLogin: boolean }) {
    super();
    FakeClient.made.push(this);
  }
  isReady(): boolean { return !this.destroyed && this.ready; }
  async login(): Promise<string> {
    this.logins++;
    if (this.plan.failLogin) { this.destroyed = true; throw new Error('getaddrinfo ENOTFOUND discord.com'); }
    queueMicrotask(() => { this.ready = true; this.emit('ready', this); });
    return 'token';
  }
  async destroy(): Promise<void> { this.destroyed = true; }
  // setupEvents() reads a few client fields when handlers fire; none fire here.
  get ws() { return { status: 0, ping: -1 }; }
  get guilds() { return { cache: new Map() }; }
}

/** Fail (not hang) if a connect never completes. */
function within<T>(p: Promise<T>, ms = 3_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms).unref())]);
}

function adapterWith(opts: { probe: () => Promise<void>; failLogins: number }) {
  FakeClient.made = [];
  let built = 0;
  const adapter = new DiscordAdapter({
    token: 'not-used',
    clientFactory: () => new FakeClient({ failLogin: built++ < opts.failLogins }) as unknown as Client,
    probeGateway: opts.probe,
  });
  return adapter;
}

describe('connectWithRetry', () => {
  it('network down at boot: never logs in until the gateway is reachable, then connects cleanly', async () => {
    let probes = 0;
    const adapter = adapterWith({
      probe: async () => { if (++probes < 3) throw new Error('getaddrinfo ENOTFOUND discord.com'); },
      failLogins: 0,
    });
    const waiter = adapter.whenReady(); // registered while down, as index.ts does
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(waiter);
    assert.equal(probes, 3);
    assert.equal(FakeClient.made.length, 1, 'the client was never destroyed, so never replaced');
    assert.equal(FakeClient.made[0]!.logins, 1, 'no login while the network was down');
    assert.equal(adapter.isConnected, true);
  });

  it('a login that fails anyway gets a fresh client; waiters from before the swap still resolve', async () => {
    const adapter = adapterWith({ probe: async () => {}, failLogins: 1 });
    const waiter = adapter.whenReady();
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(waiter);
    assert.equal(FakeClient.made.length, 2);
    assert.equal(FakeClient.made[0]!.destroyed, true);
    assert.equal(adapter.isConnected, true, 'the connected check reads the live client, not the destroyed one');
    assert.equal((adapter as unknown as { rawClient: unknown }).rawClient, FakeClient.made[1]);
  });

  it('whenReady() after connecting resolves immediately', async () => {
    const adapter = adapterWith({ probe: async () => {}, failLogins: 0 });
    await within(adapter.connectWithRetry({ initialDelayMs: 1, maxDelayMs: 2 }));
    await within(adapter.whenReady());
  });
});
