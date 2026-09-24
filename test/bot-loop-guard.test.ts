import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyBotLoopGuard } from '../src/bot-loop-guard.js';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'discord-bot-loop-')), 'state.json');
}

test('holds the seventh alternating bot turn and resets on a human message', () => {
  const path = statePath();
  for (let turn = 1; turn <= 6; turn += 1) {
    const decision = applyBotLoopGuard({
      statePath: path,
      channelId: 'courrier',
      authorId: turn % 2 === 0 ? 'fable' : 'neighbor',
      isBot: true,
      maxTurns: 6,
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.consecutiveTurns, turn);
  }

  const held = applyBotLoopGuard({
    statePath: path,
    channelId: 'courrier',
    authorId: 'neighbor',
    isBot: true,
    maxTurns: 6,
  });
  assert.equal(held.allow, false);
  assert.equal(held.consecutiveTurns, 7);

  const human = applyBotLoopGuard({
    statePath: path,
    channelId: 'courrier',
    authorId: 'ian',
    isBot: false,
    maxTurns: 6,
  });
  assert.equal(human.allow, true);
  assert.equal(human.reset, true);

  const restarted = applyBotLoopGuard({
    statePath: path,
    channelId: 'courrier',
    authorId: 'fable',
    isBot: true,
    maxTurns: 6,
  });
  assert.equal(restarted.allow, true);
  assert.equal(restarted.consecutiveTurns, 1);
});

test('treats consecutive Discord chunks from one bot as one turn', () => {
  const path = statePath();
  const first = applyBotLoopGuard({
    statePath: path,
    channelId: 'courrier',
    authorId: 'fable',
    isBot: true,
    maxTurns: 1,
  });
  const secondChunk = applyBotLoopGuard({
    statePath: path,
    channelId: 'courrier',
    authorId: 'fable',
    isBot: true,
    maxTurns: 1,
  });

  assert.equal(first.consecutiveTurns, 1);
  assert.equal(secondChunk.consecutiveTurns, 1);
  assert.equal(secondChunk.sameTurn, true);
  assert.equal(secondChunk.allow, true);
});

test('a tripped run starts over once it is more than a day old', () => {
  const path = statePath();
  const t0 = new Date('2026-09-13T07:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  for (let turn = 1; turn <= 8; turn += 1) {
    applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: turn % 2 ? 'fable' : 'nom', isBot: true, maxTurns: 6, now: at(turn) });
  }
  // Same day, rapid follow-ups are still held.
  const sameDay = applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: 'fable', isBot: true, maxTurns: 6, now: at(60) });
  assert.equal(sameDay.allow, false);
  // Next morning (run began > 24h ago): delivered, fresh run.
  const nextDay = applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: 'fable', isBot: true, maxTurns: 6, now: at(24 * 60 + 5) });
  assert.equal(nextDay.allow, true);
  assert.equal(nextDay.expired, true);
  assert.equal(nextDay.consecutiveTurns, 1);
});

test('a burst within one day is still capped even when it started long after the last run', () => {
  const path = statePath();
  const t0 = new Date('2026-09-24T12:00:00Z');
  let last;
  for (let turn = 1; turn <= 7; turn += 1) {
    last = applyBotLoopGuard({ statePath: path, channelId: 'room', authorId: turn % 2 ? 'a' : 'b', isBot: true, maxTurns: 6, now: new Date(t0.getTime() + turn * 1000) });
  }
  assert.equal(last!.allow, false);
  assert.equal(last!.consecutiveTurns, 7);
});

test('state files without runStartedAt age out from updatedAt', async () => {
  const path = statePath();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, JSON.stringify({ version: 1, channels: { salon: { consecutiveTurns: 8, lastBotAuthorId: 'fable', updatedAt: '2026-09-13T07:07:00.000Z' } } }));
  const d = applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: 'fable', isBot: true, maxTurns: 6, now: new Date('2026-09-24T07:00:00Z') });
  assert.equal(d.allow, true);
  assert.equal(d.consecutiveTurns, 1);
});
