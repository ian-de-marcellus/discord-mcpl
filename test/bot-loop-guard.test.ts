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
