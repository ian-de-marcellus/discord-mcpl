import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingReplayRequests, selectReplayMessages } from '../src/replay-requests.js';

test('pending requests skip done and malformed entries and clamp limits', () => {
  const pending = pendingReplayRequests([
    { channelId: '1', afterMessageId: '10' },
    { channelId: '2', afterMessageId: '20', done: true },
    { channelId: 'x', afterMessageId: '30' },
    { channelId: '3', afterMessageId: '40', limit: 5000, wake: true },
    'nonsense',
  ]);
  assert.deepEqual(pending.map((p) => p.index), [0, 3]);
  assert.equal(pending[0]!.request.limit, 100);
  assert.equal(pending[1]!.request.limit, 300);
  assert.equal(pending[1]!.request.wake, true);
  assert.deepEqual(pendingReplayRequests({ not: 'an array' }), []);
});

test('selection is oldest-first, drops the bot, honours through and skip', () => {
  const m = (id: string, authorId: string, t: number) => ({ id, authorId, timestamp: new Date(t), content: '' });
  const history = [m('14', 'fable', 4), m('11', 'fable', 1), m('12', 'me', 2), m('13', 'ian', 3), m('15', 'fable', 5)];
  const picked = selectReplayMessages(history, { botId: 'me', throughMessageId: '14', skip: (x) => x.id === '13' });
  assert.deepEqual(picked.map((x) => x.id), ['11', '14']);
});
