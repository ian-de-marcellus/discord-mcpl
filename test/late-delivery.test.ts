import assert from 'node:assert/strict';
import test from 'node:test';
import { lateDeliveryLine, LATE_DELIVERY_THRESHOLD_MS } from '../src/late-delivery.js';

const sent = new Date('2026-09-13T07:07:00Z');

test('on-time delivery adds nothing', () => {
  const received = new Date(sent.getTime() + LATE_DELIVERY_THRESHOLD_MS);
  assert.equal(lateDeliveryLine(sent, received, 'Europe/Paris', 'full'), '');
});

test('late delivery names both times in the agent time zone', () => {
  const received = new Date('2026-09-24T14:01:40Z');
  const line = lateDeliveryLine(sent, received, 'Europe/Paris', 'full');
  assert.match(line, /^\[delayed delivery · sent 2026-09-13T09:07:00\+02:00.* · received 2026-09-24T16:01:40\+02:00.*\]\n$/);
});

test('falls back to ISO when timestamps are styled off', () => {
  const received = new Date('2026-09-24T14:01:40Z');
  const line = lateDeliveryLine(sent, received, 'UTC', 'none');
  assert.equal(line, '[delayed delivery · sent 2026-09-13T07:07:00.000Z · received 2026-09-24T14:01:40.000Z]\n');
});
