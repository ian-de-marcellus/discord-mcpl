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

test('a tripped run starts over after the channel goes quiet', () => {
  const path = statePath();
  const t0 = new Date('2026-09-13T07:00:00Z');
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  for (let turn = 1; turn <= 8; turn += 1) {
    applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: turn % 2 ? 'fable' : 'nom', isBot: true, maxTurns: 6, now: at(turn) });
  }
  // Still rapid: held.
  const soon = applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: 'nom', isBot: true, maxTurns: 6, now: at(30) });
  assert.equal(soon.allow, false);
  // An hour and change of quiet after the last turn: fresh run.
  const later = applyBotLoopGuard({ statePath: path, channelId: 'salon', authorId: 'fable', isBot: true, maxTurns: 6, now: at(30 + 61) });
  assert.equal(later.allow, true);
  assert.equal(later.expired, true);
  assert.equal(later.consecutiveTurns, 1);
});

test('a sustained rapid loop never goes quiet and stays capped', () => {
  const path = statePath();
  const t0 = new Date('2026-09-24T12:00:00Z');
  let last;
  for (let turn = 1; turn <= 500; turn += 1) {
    last = applyBotLoopGuard({ statePath: path, channelId: 'room', authorId: turn % 2 ? 'a' : 'b', isBot: true, maxTurns: 15, now: new Date(t0.getTime() + turn * 5_000) });
  }
  assert.equal(last!.allow, false);
  assert.equal(last!.consecutiveTurns, 500);
});

test('quietMs can be tuned', () => {
  const path = statePath();
  const t0 = new Date('2026-09-24T12:00:00Z');
  for (let turn = 1; turn <= 3; turn += 1) {
    applyBotLoopGuard({ statePath: path, channelId: 'r', authorId: turn % 2 ? 'a' : 'b', isBot: true, maxTurns: 2, now: new Date(t0.getTime() + turn * 1000), quietMs: 10_000 });
  }
  const d = applyBotLoopGuard({ statePath: path, channelId: 'r', authorId: 'a', isBot: true, maxTurns: 2, now: new Date(t0.getTime() + 20_000), quietMs: 10_000 });
  assert.equal(d.allow, true);
  assert.equal(d.consecutiveTurns, 1);
});
