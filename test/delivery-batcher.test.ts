import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeliveryBatchStore } from '../src/delivery-batcher.js';
import type { DiscordMessageData } from '../src/discord-adapter.js';

const GUILD_ID = '1389348213877768416';
const CHANNEL_ID = '1389348216558059523';
const AUTHOR_ID = '379821091570319362';

function fixture(overrides: Partial<DiscordMessageData> = {}): DiscordMessageData {
  return {
    id: '1544493972251082772',
    content: 'hello',
    cleanContent: 'hello',
    authorId: AUTHOR_ID,
    authorName: 'Ian',
    isBot: false,
    channelId: CHANNEL_ID,
    channelName: 'math',
    guildId: GUILD_ID,
    guildName: 'Phenomenology of Counting',
    mentions: [],
    attachments: [],
    timestamp: new Date('2026-09-07T10:00:00Z'),
    ...overrides,
  };
}

function store(
  overrides: Partial<{
    maxMessages: number;
    maxCharacters: number;
    maxLatencyMs: number;
    addressedSettleMs: number;
  }> = {},
): { batch: DeliveryBatchStore; policyPath: string; queuePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'discord-delivery-batch-'));
  const policyPath = join(dir, 'policy.json');
  const queuePath = join(dir, 'queue.json');
  const policy = {
    schema: 'discord-mcpl-delivery-policy/v1',
    channels: {
      [CHANNEL_ID]: {
        guildId: GUILD_ID,
        maxMessages: 15,
        maxCharacters: 12_000,
        maxLatencyMs: 30 * 60_000,
        addressedSettleMs: 5_000,
        imageTriage: true,
        ...overrides,
      },
    },
  };
  writeFileSync(policyPath, JSON.stringify(policy));
  return { batch: new DeliveryBatchStore(policyPath, queuePath), policyPath, queuePath };
}

test('persists each message and restores the queue across process restart', () => {
  const { batch, policyPath, queuePath } = store();
  assert.equal(batch.enqueue(fixture(), false, 1_000), true);

  const restored = new DeliveryBatchStore(policyPath, queuePath);
  const status = restored.statuses()[0]!;
  assert.equal(status.pendingMessages, 1);
  assert.equal(status.pendingCharacters, 5);
  assert.match(readFileSync(queuePath, 'utf8'), /1544493972251082772/);
});

test('wakes at the first of message count, character budget, and maximum latency', () => {
  const byCount = store({ maxMessages: 2 }).batch;
  byCount.enqueue(fixture({ id: '1544493972251082772' }), false, 1_000);
  byCount.enqueue(fixture({ id: '1544493972251082773' }), false, 1_100);
  assert.equal(byCount.snapshotIfDue(CHANNEL_ID, 1_100)?.reason, 'message-count');

  const byCharacters = store({ maxCharacters: 8 }).batch;
  byCharacters.enqueue(fixture({ cleanContent: '12345678' }), false, 2_000);
  assert.equal(byCharacters.snapshotIfDue(CHANNEL_ID, 2_000)?.reason, 'character-budget');

  const byLatency = store({ maxLatencyMs: 1_000 }).batch;
  byLatency.enqueue(fixture(), false, 3_000);
  assert.equal(byLatency.snapshotIfDue(CHANNEL_ID, 3_999), null);
  assert.equal(byLatency.snapshotIfDue(CHANNEL_ID, 4_000)?.reason, 'max-latency');
});

test('direct address waits for fragment grace and same-author fragments extend it', () => {
  const { batch } = store({ addressedSettleMs: 5_000 });
  batch.enqueue(fixture({ id: '1544493972251082772' }), true, 10_000);
  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 14_999), null);

  batch.enqueue(fixture({ id: '1544493972251082773', cleanContent: 'continued' }), false, 14_000);
  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 18_999), null);
  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 19_000)?.reason, 'direct-address');
});

test('direct-address grace outranks ambient count and character thresholds', () => {
  const { batch } = store({ maxMessages: 1, maxCharacters: 1, addressedSettleMs: 5_000 });
  batch.enqueue(fixture(), true, 10_000);

  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 10_000), null);
  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 14_999), null);
  assert.equal(batch.snapshotIfDue(CHANNEL_ID, 15_000)?.reason, 'direct-address');
});

test('stable-prefix acknowledgements never consume later arrivals', () => {
  const { batch } = store({ maxMessages: 2 });
  batch.enqueue(fixture({ id: '1544493972251082772' }), false, 1_000);
  batch.enqueue(fixture({ id: '1544493972251082773' }), false, 1_001);
  const snapshot = batch.snapshotIfDue(CHANNEL_ID, 1_001)!;

  batch.enqueue(fixture({ id: '1544493972251082774' }), false, 1_002);
  batch.acknowledgeHead(CHANNEL_ID, snapshot.messages[0]!.id);
  batch.acknowledgeHead(CHANNEL_ID, snapshot.messages[1]!.id);
  batch.acknowledgeWake(CHANNEL_ID, snapshot.addressedVersion);

  assert.equal(batch.statuses()[0]!.pendingMessages, 1);
});

test('resident tuning changes thresholds but cannot add a room', () => {
  const { batch } = store();
  const updated = batch.updateThresholds(CHANNEL_ID, {
    maxMessages: 20,
    maxCharacters: 20_000,
    maxLatencyMs: 45 * 60_000,
  });
  assert.equal(updated.maxMessages, 20);
  assert.equal(updated.maxCharacters, 20_000);
  assert.equal(updated.maxLatencyMs, 45 * 60_000);
  assert.throws(
    () => batch.updateThresholds('1389348216558059999', { maxMessages: 1 }),
    /cannot add rooms/,
  );
});
