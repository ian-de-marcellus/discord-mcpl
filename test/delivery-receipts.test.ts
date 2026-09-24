import assert from 'node:assert/strict';
import test from 'node:test';
import {
  liveLine,
  parseEmojiList,
  reactionWakes,
  receiptChannelSet,
  receiptEmojis,
  ReceiptQueue,
  RECEIPT_NO_WAKE,
  RECEIPT_STORED,
} from '../src/delivery-receipts.js';

const base = { action: 'add' as const, reactorIsBot: false, onOwnMessage: true, emoji: '🔔', token: '🔔' };

test('reactions never wake without a configured ping emoji', () => {
  assert.equal(reactionWakes({ ...base, pingEmoji: new Set() }), false);
  assert.equal(reactionWakes({ ...base, emoji: '❤️', token: '❤️', pingEmoji: parseEmojiList('🔔') }), false);
});

test('a human ping emoji on our own message wakes; bots, others, removals do not', () => {
  const ping = parseEmojiList('🔔, :bell:');
  assert.equal(reactionWakes({ ...base, pingEmoji: ping }), true);
  assert.equal(reactionWakes({ ...base, reactorIsBot: true, pingEmoji: ping }), false);
  assert.equal(reactionWakes({ ...base, onOwnMessage: false, pingEmoji: ping }), false);
  assert.equal(reactionWakes({ ...base, action: 'remove', pingEmoji: ping }), false);
  assert.equal(reactionWakes({ ...base, emoji: ':bell:', token: '<:bell:1>', pingEmoji: ping }), true);
});

test('receipt channels come from DISCORD_RECEIPT_CHANNELS, else the bot-loop channels', () => {
  assert.deepEqual([...receiptChannelSet({ DISCORD_BOT_LOOP_CHANNELS: '1, 2' })], ['1', '2']);
  assert.deepEqual([...receiptChannelSet({ DISCORD_BOT_LOOP_CHANNELS: '1', DISCORD_RECEIPT_CHANNELS: '9' })], ['9']);
  assert.equal(receiptChannelSet({}).size, 0);
});

test('receipts only for other bots in receipt channels; 💤 when stored without waking', () => {
  const common = { channelId: 'c', authorId: 'fable', authorIsBot: true, selfId: 'me', receiptChannels: new Set(['c']) };
  assert.deepEqual(receiptEmojis({ ...common, suppressWake: false }), [RECEIPT_STORED]);
  assert.deepEqual(receiptEmojis({ ...common, suppressWake: true }), [RECEIPT_STORED, RECEIPT_NO_WAKE]);
  assert.deepEqual(receiptEmojis({ ...common, authorIsBot: false, suppressWake: false }), []);
  assert.deepEqual(receiptEmojis({ ...common, authorId: 'me', suppressWake: false }), []);
  assert.deepEqual(receiptEmojis({ ...common, channelId: 'elsewhere', suppressWake: false }), []);
});

test('receipt queue is sequential, idempotent, and never throws', async () => {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const errors: string[] = [];
  const q = new ReceiptQueue(async (_c, m, e) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (m === 'bad') throw new Error('Missing Permissions');
    calls.push(`${m}:${e}`);
  }, (info) => errors.push(info.error));
  q.enqueue('c', 'm1', ['📥', '💤']);
  q.enqueue('c', 'm1', ['📥']); // replay: no second reaction
  q.enqueue('c', 'bad', ['📥']);
  await q.enqueue('c', 'm2', ['📥']);
  assert.deepEqual(calls, ['m1:📥', 'm1:💤', 'm2:📥']);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(errors, ['Missing Permissions']);
});

test('live line names the place and every part', () => {
  assert.equal(liveLine({ where: '#salon', messageIds: ['1'] }), '✓ live in #salon — 1 part: 1');
  assert.equal(liveLine({ where: 'the DM', messageIds: ['1', '2'] }), '✓ live in the DM — 2 parts: 1, 2');
});
