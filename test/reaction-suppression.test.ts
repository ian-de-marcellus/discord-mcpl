/**
 * Tests for the Discord filters plane state + reaction suppression
 * (issue #21, folded per PR #13's architecture review).
 *
 * The invariant: a suppressed reaction leaves no glyph, name, or token in
 * any model-visible output — event text, event ids, history snapshots,
 * status, warnings, logs — while raw Discord state is untouched.
 *
 * Staleness is a property of the PLANE, not of any one key: guild/DM
 * whitelists and the suppression key go stale together when the desired
 * state on disk is unparseable or missing, and the plane status reports
 * desired-vs-effective for all of them. The deprecated
 * DISCORD_SUPPRESS_REACTION_EMOJIS env is process-static (snapshotted at
 * construction; changing a running process's environment from outside is
 * not a thing, so no hot-apply is claimed).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DiscordFiltersState,
  FiltersFilePollTracker,
  resolveStartupFilters,
  normalizeFilters,
  loadFiltersFile,
  parseSuppressionEnvTokens,
  type DiscordFilters,
} from '../src/filters.js';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, ReactionSummary } from '../src/discord-adapter.js';

const SUPPRESSED_UNICODE = '🛑';
const SUPPRESSED_VARIANT = '☣️'; // VS-16 form; bare '☣' must match too
const SUPPRESSED_BARE = '☣';
const SUPPRESSED_CUSTOM_ID = '111222333444555666';
const ENV_ONLY_GLYPH = '🧪';
const HARMLESS = '😀';

const FILE_TOKENS = [SUPPRESSED_UNICODE, SUPPRESSED_VARIANT, `:sigil:`, SUPPRESSED_CUSTOM_ID];

function withKey(tokens: string[] = FILE_TOKENS): DiscordFilters {
  return { guildIds: ['999888777666555444'], suppressedReactionEmojis: tokens };
}

function fileState(opts?: { legacyEnv?: string }): DiscordFiltersState {
  return new DiscordFiltersState({ fileConfigured: true, legacyEnv: opts?.legacyEnv });
}

function summary(emoji: string, emojiId: string | null = null): ReactionSummary {
  return { emoji, emojiId, token: emojiId ? `<:x:${emojiId}>` : emoji, count: 2, me: false };
}

/** Capture console.error lines for glyph-leak assertions. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: () => (console.error = orig) };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'filters-plane-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DISCORD_FILTERS_FILE;
  delete process.env.DISCORD_SUPPRESS_REACTION_EMOJIS;
  delete process.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE;
});

describe('DiscordFiltersState — plane status', () => {
  it('env-static when no filters file is configured', () => {
    const st = new DiscordFiltersState({ fileConfigured: false });
    st.applyParsed({ guildIds: ['999888777666555444'] });
    const plane = st.planeStatus();
    assert.equal(plane.status, 'env-static');
    assert.equal(plane.desiredState, undefined);
    assert.match(plane.effectiveDigest!, /^sha256:[0-9a-f]{64}$/);
  });

  it('live after a good parse, with a full plane digest and load time', () => {
    const st = fileState();
    st.applyParsed(withKey());
    const plane = st.planeStatus();
    assert.equal(plane.status, 'live');
    assert.equal(plane.desiredState, 'ok');
    assert.match(plane.effectiveDigest!, /^sha256:[0-9a-f]{64}$/, 'full machine digest, not shortened');
    assert.ok(plane.loadedAt);
    assert.equal(plane.staleSince, undefined);
  });

  it('the plane digest covers the whole filters object, not just suppression', () => {
    const st = fileState();
    st.applyParsed(withKey());
    const d1 = st.planeStatus().effectiveDigest;
    st.applyParsed({ ...withKey(), dmUsers: ['123456789012345678'] });
    const d2 = st.planeStatus().effectiveDigest;
    assert.notEqual(d1, d2, 'a whitelist-only change must change the plane digest');
  });

  it('invalid rewrite: whole plane goes stale — whitelists and suppression together', () => {
    const st = fileState();
    st.applyParsed(withKey());
    assert.equal(st.markBroken('invalid'), true, 'first transition reports true (callers log once)');
    assert.equal(st.markBroken('invalid'), false, 'repeat polls do not re-log');
    const plane = st.planeStatus();
    assert.equal(plane.status, 'stale');
    assert.equal(plane.desiredState, 'invalid');
    assert.ok(plane.staleSince);
    assert.ok(plane.effectiveDigest, 'the last-known-good plane is still reported');
    assert.deepEqual(st.effectiveFilters()?.guildIds, ['999888777666555444'], 'LKG whitelists retained');
  });

  it('missing file: plane reports desiredState missing, LKG retained', () => {
    const st = fileState();
    st.applyParsed(withKey());
    st.markBroken('missing');
    const plane = st.planeStatus();
    assert.equal(plane.status, 'stale');
    assert.equal(plane.desiredState, 'missing');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true, 'suppression LKG still enforced');
  });

  it('broken before any good parse: plane unavailable', () => {
    const st = fileState();
    st.markBroken('invalid');
    const plane = st.planeStatus();
    assert.equal(plane.status, 'unavailable');
    assert.equal(plane.effectiveDigest, null);
  });

  it('recovery: a good reload returns the plane to live', () => {
    const st = fileState();
    st.applyParsed(withKey());
    st.markBroken('missing');
    st.applyParsed(withKey());
    assert.equal(st.planeStatus().status, 'live');
    assert.equal(st.planeStatus().desiredState, 'ok');
  });
});

describe('DiscordFiltersState — suppression', () => {
  it('not-configured: no key, no env — honest status, nothing suppressed', () => {
    const st = fileState();
    st.applyParsed({});
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'not-configured');
    assert.equal(rs.protectionActive, false);
    assert.equal(rs.source, 'none');
    assert.equal(rs.effectiveDigest, null);
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false);
    assert.equal(st.suppressAll(), false);
  });

  it('file key active: matches VS-16 variants, colon-stripped names, and custom ids', () => {
    const st = fileState();
    st.applyParsed(withKey());
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_BARE }), true, 'bare form of a VS-16 entry matches');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_VARIANT }), true);
    assert.equal(st.isSuppressed({ emoji: 'sigil' }), true, 'colon-configured name matches bare');
    assert.equal(st.isSuppressed({ emoji: ':whatever:', emojiId: SUPPRESSED_CUSTOM_ID }), true, 'snowflake entry matches by id');
    assert.equal(st.isSuppressed({ emoji: HARMLESS }), false);
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'active');
    assert.equal(rs.protectionActive, true);
    assert.equal(rs.source, 'file');
    assert.match(rs.effectiveDigest!, /^sha256:[0-9a-f]{64}$/);
  });

  it('configured-empty is distinct from not-configured and from active', () => {
    const st = fileState();
    st.applyParsed({ suppressedReactionEmojis: [] });
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'configured-empty');
    assert.equal(rs.protectionActive, false);
    assert.equal(rs.source, 'file');
    assert.equal(rs.effectiveDigest, null);
  });

  it('file precedence: key present means env is ignored, never unioned', () => {
    const cap = captureStderr();
    try {
      const st = fileState({ legacyEnv: ENV_ONLY_GLYPH });
      st.applyParsed(withKey());
      assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), false, 'env entry must NOT be unioned in');
      assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
      const rs = st.suppressionStatus();
      assert.equal(rs.source, 'file');
      assert.equal(rs.legacyEnvIgnored, true);
      const warnings = cap.lines.filter((l) => l.includes('IGNORED'));
      assert.equal(warnings.length, 1, 'ignored-env warning fires once');
      assert.ok(!warnings[0].includes(ENV_ONLY_GLYPH), 'warning is glyph-free');
      st.suppressionStatus(); // repeated status must not re-warn
      assert.equal(cap.lines.filter((l) => l.includes('IGNORED')).length, 1);
    } finally {
      cap.restore();
    }
  });

  it('legacy env source: emergency-filter matching, deprecated status', () => {
    const st = fileState({ legacyEnv: `${ENV_ONLY_GLYPH}, ${SUPPRESSED_CUSTOM_ID}` });
    st.applyParsed({ guildIds: ['999888777666555444'] }); // file exists, no key
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    assert.equal(st.isSuppressed({ emoji: ':x:', emojiId: SUPPRESSED_CUSTOM_ID }), true, 'numeric token matches by id');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_CUSTOM_ID }), true, 'numeric token keeps its literal match');
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'active');
    assert.equal(rs.source, 'legacy-env');
    assert.equal(rs.deprecated, true);
    assert.equal(rs.protectionActive, true);
  });

  it('legacy env is process-static: a post-construction env change has no effect', () => {
    process.env.DISCORD_SUPPRESS_REACTION_EMOJIS = ENV_ONLY_GLYPH;
    const st = new DiscordFiltersState({ fileConfigured: true });
    st.applyParsed({});
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    // Mutating the process env after construction changes nothing — the
    // source is a startup snapshot, exactly like a real external edit to
    // the environment of a running process (which cannot happen at all).
    process.env.DISCORD_SUPPRESS_REACTION_EMOJIS = HARMLESS;
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true, 'snapshot still enforced');
    assert.equal(st.isSuppressed({ emoji: HARMLESS }), false, 'new env value not picked up');
  });

  it('key deletion falls back to the env snapshot (compat), or to off', () => {
    const st = fileState({ legacyEnv: ENV_ONLY_GLYPH });
    st.applyParsed(withKey());
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), false);
    st.applyParsed({ guildIds: ['999888777666555444'] }); // operator removed the key
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true, 'env resumes when the key is gone');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'file entries no longer enforced');
    assert.equal(st.suppressionStatus().source, 'legacy-env');

    const stOff = fileState();
    stOff.applyParsed(withKey());
    stOff.applyParsed({});
    assert.equal(stOff.suppressionStatus().status, 'not-configured');
    assert.equal(stOff.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false);
  });

  it('broken plane after a good load: suppression stale, LKG still enforced', () => {
    const st = fileState();
    st.applyParsed(withKey());
    const activeDigest = st.suppressionStatus().effectiveDigest;
    st.markBroken('invalid');
    assert.equal(st.suppressAll(), false, 'a usable LKG must not escalate to withhold-everything');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true, 'LKG still enforced');
    assert.equal(st.isSuppressed({ emoji: HARMLESS }), false);
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'stale');
    assert.equal(rs.protectionActive, true, 'stale must not hide an active LKG');
    assert.equal(rs.effectiveDigest, activeDigest);
    assert.ok(rs.effectiveCount > 0);
  });

  it('broken before any good parse: unavailable, everything withheld', () => {
    const st = fileState();
    st.markBroken('invalid');
    assert.equal(st.suppressAll(), true);
    const proj = st.project([summary(HARMLESS)]);
    assert.deepEqual(proj.reactions, []);
    assert.equal(proj.unavailable, true, 'empty must not read as "none"');
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'unavailable');
    assert.equal(rs.protectionActive, true);
    assert.equal(rs.suppressingAllReactions, true);
  });

  it('configured-empty then broken fails closed, not open', () => {
    const st = fileState();
    st.applyParsed({ suppressedReactionEmojis: [] });
    st.markBroken('invalid');
    assert.equal(st.suppressAll(), true, 'an empty LKG is not a fallback — the typo-in-first-real-entries case');
    assert.equal(st.suppressionStatus().status, 'unavailable');
  });

  it('known key-absence + broken plane: live sources continue, plane carries the fact', () => {
    const stEnv = fileState({ legacyEnv: ENV_ONLY_GLYPH });
    stEnv.applyParsed({ guildIds: ['999888777666555444'] });
    stEnv.markBroken('invalid');
    assert.equal(stEnv.suppressAll(), false, 'file never carried suppression; env snapshot is unaffected');
    assert.equal(stEnv.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    assert.equal(stEnv.suppressionStatus().source, 'legacy-env');
    assert.equal(stEnv.planeStatus().desiredState, 'invalid', 'the broken fact lives on the plane');

    const stOff = fileState();
    stOff.applyParsed({});
    stOff.markBroken('invalid');
    assert.equal(stOff.suppressAll(), false, 'known absence of any suppression must not blank reactions');
    assert.equal(stOff.suppressionStatus().status, 'not-configured');
  });

  it('plane and suppression status never contain a configured glyph or id', () => {
    const cap = captureStderr();
    try {
      const st = fileState({ legacyEnv: ENV_ONLY_GLYPH });
      st.applyParsed(withKey());
      st.markBroken('invalid');
      const blobs = [JSON.stringify(st.suppressionStatus()), JSON.stringify(st.planeStatus()), cap.lines.join('\n')];
      for (const blob of blobs) {
        for (const secret of [SUPPRESSED_UNICODE, SUPPRESSED_BARE, 'sigil', SUPPRESSED_CUSTOM_ID, ENV_ONLY_GLYPH]) {
          assert.ok(!blob.includes(secret), 'no configured value in status/logs');
        }
      }
    } finally {
      cap.restore();
    }
  });

  it('normalizeFilters dedupes suppression variants and preserves an explicit empty list', () => {
    const n = normalizeFilters({
      suppressedReactionEmojis: [SUPPRESSED_VARIANT, SUPPRESSED_BARE, ':sigil:', 'sigil', '  '],
    });
    assert.equal(n.suppressedReactionEmojis!.length, 2, 'VS-16 variants and colon forms collapse');
    const empty = normalizeFilters({ suppressedReactionEmojis: [] });
    assert.deepEqual(empty.suppressedReactionEmojis, [], 'explicit empty is preserved, not collapsed to unset');
    const unset = normalizeFilters({});
    assert.equal(unset.suppressedReactionEmojis, undefined);
  });

  it('parseSuppressionEnvTokens: unset/empty/separator-only stay honestly off', () => {
    assert.deepEqual(parseSuppressionEnvTokens(undefined), []);
    assert.deepEqual(parseSuppressionEnvTokens(''), []);
    assert.deepEqual(parseSuppressionEnvTokens(' , ,, '), []);
    assert.deepEqual(parseSuppressionEnvTokens(`${HARMLESS}, x`), [HARMLESS, 'x']);
  });
});

describe('DiscordFiltersState — host-injected protective baseline', () => {
  const BASELINE = `${SUPPRESSED_UNICODE},${SUPPRESSED_CUSTOM_ID}`;

  function baselineState(opts?: { legacyEnv?: string }): DiscordFiltersState {
    return new DiscordFiltersState({ fileConfigured: true, legacyEnv: opts?.legacyEnv, baselineEnv: BASELINE });
  }

  it('absent key → baseline applies, source baseline-default, not deprecated', () => {
    const st = baselineState();
    st.applyParsed({ guildIds: ['999888777666555444'] }); // file exists, no key
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
    assert.equal(st.isSuppressed({ emoji: ':x:', emojiId: SUPPRESSED_CUSTOM_ID }), true);
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'active');
    assert.equal(rs.source, 'baseline-default');
    assert.equal(rs.deprecated, undefined, 'the baseline is the intended path, not a deprecation');
    assert.equal(rs.protectionActive, true);
  });

  it('explicit [] → operator chose none; the baseline is overridden, not merged back', () => {
    const st = baselineState();
    st.applyParsed({ suppressedReactionEmojis: [] });
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'explicit empty beats the default');
    const rs = st.suppressionStatus();
    assert.equal(rs.status, 'configured-empty');
    assert.equal(rs.source, 'file');
  });

  it('explicit nonempty key → exact operator set, baseline entries not unioned in', () => {
    const st = baselineState();
    st.applyParsed({ suppressedReactionEmojis: [HARMLESS] }); // operator set ≠ baseline
    assert.equal(st.isSuppressed({ emoji: HARMLESS }), true, 'operator entries enforced exactly');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'baseline entry must NOT ride along');
    assert.equal(st.suppressionStatus().source, 'file');
  });

  it('operator-explicit legacy env beats the injected baseline', () => {
    const st = baselineState({ legacyEnv: ENV_ONLY_GLYPH });
    st.applyParsed({});
    assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'baseline yields to explicit operator config');
    assert.equal(st.suppressionStatus().source, 'legacy-env');
  });

  it('legacy env PRESENCE beats the baseline even when its parsed list is empty', () => {
    // The emergency filter treated an explicitly-empty env as OFF; the
    // baseline must not reappear underneath an operator's off switch —
    // presence is tested separately from token count (Sol's edge).
    for (const emptyish of ['', ' , ,, ']) {
      const st = baselineState({ legacyEnv: emptyish });
      st.applyParsed({});
      assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, `baseline suppressed nothing under legacyEnv=${JSON.stringify(emptyish)}`);
      const rs = st.suppressionStatus();
      assert.equal(rs.status, 'configured-empty', 'an explicit off overriding a default reports as deliberate');
      assert.equal(rs.source, 'legacy-env');
      assert.equal(rs.deprecated, true);
      assert.equal(rs.protectionActive, false);
    }
    // Present-but-empty with no baseline to override: historically
    // identical to unset, and reported that way.
    const stNoBaseline = new DiscordFiltersState({ fileConfigured: true, legacyEnv: '', baselineEnv: undefined });
    stNoBaseline.applyParsed({});
    assert.equal(stNoBaseline.suppressionStatus().status, 'not-configured');
  });

  it('lost configuration never silently degrades back to baseline', () => {
    // A file that HAD a key and broke: stale LKG, not baseline.
    const st = baselineState();
    st.applyParsed({ suppressedReactionEmojis: [HARMLESS] });
    st.markBroken('missing');
    assert.equal(st.isSuppressed({ emoji: HARMLESS }), true, 'LKG enforced');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false, 'baseline does NOT resurrect');
    assert.equal(st.suppressionStatus().status, 'stale');

    // A file whose operator explicitly chose none, then broke: fail
    // closed — the baseline must not un-choose that either.
    const stEmpty = baselineState();
    stEmpty.applyParsed({ suppressedReactionEmojis: [] });
    stEmpty.markBroken('invalid');
    assert.equal(stEmpty.suppressAll(), true, 'configured-empty then broken stays fail-closed, not baseline-again');
  });

  it('baseline continues under a broken plane when it was already the source', () => {
    const st = baselineState();
    st.applyParsed({ guildIds: ['999888777666555444'] }); // running on baseline
    st.markBroken('invalid');
    assert.equal(st.suppressAll(), false);
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true, 'the process-static baseline is unaffected by file failures');
    assert.equal(st.planeStatus().desiredState, 'invalid', 'the plane still carries the broken fact');
  });

  it('first materialization seeds the baseline durably; legacy env wins the seed when both are set', () => {
    const cap = captureStderr();
    try {
      const p1 = join(dir, 'seed-baseline.json');
      const r1 = resolveStartupFilters(p1, {
        DISCORD_SUPPRESSED_REACTIONS_BASELINE: BASELINE,
      } as NodeJS.ProcessEnv);
      assert.deepEqual(r1.filters.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID]);
      assert.deepEqual(loadFiltersFile(p1)!.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID],
        'restart with absent desired config re-seeds the baseline durably');

      const p2 = join(dir, 'seed-both.json');
      const r2 = resolveStartupFilters(p2, {
        DISCORD_SUPPRESS_REACTION_EMOJIS: ENV_ONLY_GLYPH,
        DISCORD_SUPPRESSED_REACTIONS_BASELINE: BASELINE,
      } as NodeJS.ProcessEnv);
      assert.deepEqual(r2.filters.suppressedReactionEmojis, [ENV_ONLY_GLYPH],
        'operator-explicit legacy env wins the seed; never unioned with the baseline');

      const p3 = join(dir, 'seed-empty-legacy.json');
      const r3 = resolveStartupFilters(p3, {
        DISCORD_SUPPRESS_REACTION_EMOJIS: '',
        DISCORD_SUPPRESSED_REACTIONS_BASELINE: BASELINE,
      } as NodeJS.ProcessEnv);
      assert.deepEqual(r3.filters.suppressedReactionEmojis, [],
        'present-but-empty legacy env seeds an explicit [] — the off becomes durable, the baseline does not claim the slot');
      assert.deepEqual(loadFiltersFile(p3)!.suppressedReactionEmojis, [],
        'the explicit empty key is on disk, so the off survives env cleanup and future baseline injection');
      assert.ok(!cap.lines.join('\n').includes(SUPPRESSED_UNICODE), 'seed logs stay glyph-free');
    } finally {
      cap.restore();
    }
  });

  it('an existing file without the key still uses the baseline — but is not rewritten', () => {
    const path = join(dir, 'existing.json');
    writeFileSync(path, JSON.stringify({ guildIds: ['999888777666555444'] }));
    const before = readFileSync(path, 'utf8');
    const cap = captureStderr();
    try {
      const { filters } = resolveStartupFilters(path, {
        DISCORD_SUPPRESSED_REACTIONS_BASELINE: BASELINE,
      } as NodeJS.ProcessEnv);
      assert.equal(readFileSync(path, 'utf8'), before, 'no surprise rewrite');
      const st = new DiscordFiltersState({ fileConfigured: true, baselineEnv: BASELINE });
      st.applyParsed(filters);
      assert.equal(st.suppressionStatus().source, 'baseline-default');
      assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), true);
    } finally {
      cap.restore();
    }
  });

  it('baseline status and logs never contain a baseline glyph or id', () => {
    const cap = captureStderr();
    try {
      const st = baselineState();
      st.applyParsed({});
      const blobs = [JSON.stringify(st.suppressionStatus()), JSON.stringify(st.planeStatus()), cap.lines.join('\n')];
      for (const blob of blobs) {
        for (const secret of [SUPPRESSED_UNICODE, SUPPRESSED_BARE, SUPPRESSED_CUSTOM_ID]) {
          assert.ok(!blob.includes(secret), 'no baseline value in status/logs');
        }
      }
    } finally {
      cap.restore();
    }
  });

  it('standalone (no baseline injected) honestly reports not-configured', () => {
    const st = new DiscordFiltersState({ fileConfigured: true, baselineEnv: undefined });
    st.applyParsed({});
    assert.equal(st.suppressionStatus().status, 'not-configured');
    assert.equal(st.isSuppressed({ emoji: SUPPRESSED_UNICODE }), false);
  });
});

describe('loadFiltersFile — strict typing for the safety-bearing key', () => {
  function writeJson(content: unknown): string {
    const p = join(dir, 'filters.json');
    writeFileSync(p, JSON.stringify(content));
    return p;
  }

  it('a wrong-typed suppressedReactionEmojis invalidates the whole load', () => {
    assert.equal(loadFiltersFile(writeJson({ suppressedReactionEmojis: 'oops' })), null, 'string value');
    assert.equal(loadFiltersFile(writeJson({ suppressedReactionEmojis: { a: 1 } })), null, 'object value');
    assert.equal(loadFiltersFile(writeJson({ suppressedReactionEmojis: [HARMLESS, 42] })), null, 'non-string member');
    assert.equal(loadFiltersFile(writeJson({ suppressedReactionEmojis: null })), null, 'null value');
  });

  it('a valid string[] (including empty) parses; loose whitelist shapes stay tolerated', () => {
    const ok = loadFiltersFile(writeJson({ suppressedReactionEmojis: [HARMLESS], guildIds: 'not-an-array' }));
    assert.ok(ok, 'wrong-typed whitelist fails toward unrestricted, not toward invalid');
    assert.equal(ok!.guildIds, undefined);
    assert.deepEqual(ok!.suppressedReactionEmojis, [HARMLESS]);
    const empty = loadFiltersFile(writeJson({ suppressedReactionEmojis: [] }));
    assert.deepEqual(empty!.suppressedReactionEmojis, []);
  });
});

describe('FiltersFilePollTracker', () => {
  it('unchanged mtime is quiet; a change reloads', () => {
    const t = new FiltersFilePollTracker(1000);
    assert.equal(t.observe(1000), 'none');
    assert.equal(t.observe(2000), 'reload');
    assert.equal(t.observe(2000), 'none');
  });

  it('one missing poll is grace; two consecutive is a real deletion', () => {
    const t = new FiltersFilePollTracker(1000);
    assert.equal(t.observe(null), 'none', 'one poll of grace for non-atomic editors');
    assert.equal(t.observe(null), 'missing');
    assert.equal(t.observe(null), 'missing', 'stays missing while absent (markBroken dedupes logging)');
  });

  it('a reappearing file force-reloads even with a preserved mtime', () => {
    const t = new FiltersFilePollTracker(1000);
    assert.equal(t.observe(null), 'none');
    assert.equal(t.observe(null), 'missing');
    assert.equal(t.observe(1000), 'reload', 'restored backups can carry different bytes under identical mtimes');
  });

  it('a blink shorter than the grace still forces a reload on reappearance', () => {
    const t = new FiltersFilePollTracker(1000);
    assert.equal(t.observe(null), 'none');
    assert.equal(t.observe(1000), 'reload', 'the file was gone at least once — reload rather than trust the mtime');
  });
});

describe('startup resolution (resolveStartupFilters)', () => {
  it('absent file: seeds whitelists AND the suppression key from the emergency env', () => {
    const path = join(dir, 'filters.json');
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
        DISCORD_SUPPRESS_REACTION_EMOJIS: `${SUPPRESSED_UNICODE},${SUPPRESSED_CUSTOM_ID}`,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, false);
      assert.deepEqual(filters.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID]);
      const onDisk = loadFiltersFile(path)!;
      assert.deepEqual(onDisk.suppressedReactionEmojis, [SUPPRESSED_UNICODE, SUPPRESSED_CUSTOM_ID]);
      assert.ok(!cap.lines.join('\n').includes(SUPPRESSED_UNICODE), 'seed log is glyph-free');
    } finally {
      cap.restore();
    }
  });

  it('absent file + no suppression env: seeds without the key', () => {
    const path = join(dir, 'filters.json');
    const cap = captureStderr();
    try {
      const { filters } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
      } as NodeJS.ProcessEnv);
      assert.equal(filters.suppressedReactionEmojis, undefined);
      assert.equal(loadFiltersFile(path)!.suppressedReactionEmojis, undefined);
    } finally {
      cap.restore();
    }
  });

  it('existing file without the key is NOT rewritten; env stays the compat source', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ guildIds: ['999888777666555444'] }));
    const before = readFileSync(path, 'utf8');
    const mtimeBefore = statSync(path).mtimeMs;
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_SUPPRESS_REACTION_EMOJIS: ENV_ONLY_GLYPH,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, false);
      assert.equal(filters.suppressedReactionEmojis, undefined, 'no surprise key injection');
      assert.equal(readFileSync(path, 'utf8'), before, 'file bytes untouched');
      assert.equal(statSync(path).mtimeMs, mtimeBefore, 'file not rewritten');
      const st = new DiscordFiltersState({ fileConfigured: true, legacyEnv: ENV_ONLY_GLYPH });
      st.applyParsed(filters);
      assert.equal(st.suppressionStatus().source, 'legacy-env');
      assert.equal(st.isSuppressed({ emoji: ENV_ONLY_GLYPH }), true);
    } finally {
      cap.restore();
    }
  });

  it('existing malformed file: untouched, reported broken, env whitelists in force', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, '{broken');
    const cap = captureStderr();
    try {
      const { filters, fileBroken } = resolveStartupFilters(path, {
        DISCORD_GUILD_ID: '999888777666555444',
        DISCORD_SUPPRESS_REACTION_EMOJIS: SUPPRESSED_UNICODE,
      } as NodeJS.ProcessEnv);
      assert.equal(fileBroken, true);
      assert.equal(readFileSync(path, 'utf8'), '{broken', 'malformed file is never overwritten');
      assert.deepEqual(filters.guildIds, ['999888777666555444']);
      assert.equal(filters.suppressedReactionEmojis, undefined, 'no key claimed without a readable file');
    } finally {
      cap.restore();
    }
  });

  it('wrong-typed suppression key at startup counts as broken, not as key-absent', () => {
    const path = join(dir, 'filters.json');
    writeFileSync(path, JSON.stringify({ suppressedReactionEmojis: 'oops' }));
    const cap = captureStderr();
    try {
      const { fileBroken } = resolveStartupFilters(path, {} as NodeJS.ProcessEnv);
      assert.equal(fileBroken, true, 'strict typing routes wrong-typed keys to the fail-safe path');
      assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ suppressedReactionEmojis: 'oops' }));
    } finally {
      cap.restore();
    }
  });
});

describe('server integration', () => {
  function makeServer(): DiscordMcplServer {
    // The server's filters state reads DISCORD_FILTERS_FILE at
    // construction to know a file plane is configured.
    process.env.DISCORD_FILTERS_FILE ??= join(dir, 'filters.json');
    return new DiscordMcplServer({} as DiscordAdapter);
  }

  it('projects suppressed reactions out of history messages', () => {
    const server = makeServer();
    server.filtersState.applyParsed(withKey());
    const s = server as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        id: string;
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = s.projectHistoryReactions([
      { id: 'm1', reactions: [summary(SUPPRESSED_UNICODE), summary(HARMLESS), summary(':x:', SUPPRESSED_CUSTOM_ID)] },
      { id: 'm2' },
    ]);
    assert.deepEqual(out[0].reactions?.map((r) => r.emoji), [HARMLESS]);
    assert.equal(out[0].reactionsUnavailable, undefined);
    assert.equal(out[1].reactions?.length ?? 0, 0);
    assert.ok(!JSON.stringify(out).includes(SUPPRESSED_UNICODE), 'no glyph anywhere in projected output');
  });

  it('withhold-everything posture blanks history reactions with an unavailable marker', () => {
    const server = makeServer();
    server.filtersState.markBroken('invalid');
    const s = server as unknown as {
      projectHistoryReactions(msgs: Array<{ id: string; reactions?: ReactionSummary[] }>): Array<{
        reactions?: ReactionSummary[];
        reactionsUnavailable?: true;
      }>;
    };
    const out = s.projectHistoryReactions([{ id: 'm1', reactions: [summary(HARMLESS)] }]);
    assert.deepEqual(out[0].reactions, []);
    assert.equal(out[0].reactionsUnavailable, true, 'empty must not read as "none"');
  });

  function wireReactionHandler(server: DiscordMcplServer): {
    handler: (ev: Record<string, unknown>) => void;
    sent: unknown[];
  } {
    const s = server as unknown as Record<string, unknown>;
    let reactionHandler: ((ev: Record<string, unknown>) => void) | undefined;
    const noop = () => {};
    s.discord = {
      onMessage: noop, onMessageEdit: noop, onMessageDelete: noop,
      onChannelCreate: noop, onChannelDelete: noop, onGuildCreate: noop,
      onChannelAvailable: noop, onSessionRestored: noop,
      onReaction: (h: (ev: Record<string, unknown>) => void) => { reactionHandler = h; },
    };
    const sent: unknown[] = [];
    s.conn = { sendRequest: (method: string, params: unknown) => { sent.push({ method, params }); return Promise.resolve({}); } };
    s.mcplEnabled = true;
    (s.enabledFeatureSets as Set<string>).add('discord.messaging');
    (s.reactionChannels as Set<string>).add('chan1');
    s.reactionChannelsLoaded = true;
    (s.setupDiscordForwarding as () => void).call(server);
    assert.ok(reactionHandler, 'reaction handler registered');
    return { handler: reactionHandler!, sent };
  }

  const baseEvent = {
    channelId: 'chan1', messageId: 'msg1', guildId: 'g1',
    userId: 'u1', userName: 'alice', action: 'add',
    onOwnMessage: false, messageSnippet: 'hello', timestamp: new Date(1700000000000),
  };

  it('drops suppressed live reaction add AND remove before text or event id exists', () => {
    const server = makeServer();
    server.filtersState.applyParsed(withKey());
    const { handler, sent } = wireReactionHandler(server);

    handler({ ...baseEvent, emoji: SUPPRESSED_UNICODE, emojiId: null, token: SUPPRESSED_UNICODE });
    handler({ ...baseEvent, emoji: SUPPRESSED_BARE, emojiId: null, token: SUPPRESSED_BARE });
    handler({ ...baseEvent, action: 'remove', emoji: ':sus:', emojiId: SUPPRESSED_CUSTOM_ID, token: `<:sus:${SUPPRESSED_CUSTOM_ID}>` });
    assert.equal(sent.length, 0, 'suppressed reactions must produce no push event at all');

    handler({ ...baseEvent, emoji: HARMLESS, emojiId: null, token: HARMLESS });
    assert.equal(sent.length, 1);
    const wire = JSON.stringify(sent);
    assert.ok(wire.includes(HARMLESS));
    assert.ok(!wire.includes(SUPPRESSED_UNICODE), 'no suppressed glyph on the wire');
    assert.ok(!wire.includes(SUPPRESSED_BARE), 'no bare-variant glyph on the wire');
    assert.ok(!wire.includes(SUPPRESSED_CUSTOM_ID), 'no suppressed custom id on the wire');
  });

  it('withhold-everything posture drops every live reaction event', () => {
    const server = makeServer();
    server.filtersState.markBroken('invalid');
    const { handler, sent } = wireReactionHandler(server);
    handler({ ...baseEvent, emoji: HARMLESS, emojiId: null, token: HARMLESS });
    assert.equal(sent.length, 0);
  });

  it('filters_get reports plane + redacted suppression state and distinguishes the nothings', async () => {
    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    s.discord = { getFilters: () => ({}) };
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);

    // not-configured
    server.filtersState.applyParsed({});
    let res = (await call('filters_get', {})) as {
      plane: Record<string, unknown>;
      reactionSuppression: Record<string, unknown>;
    };
    assert.equal(res.plane.status, 'live');
    assert.equal(res.reactionSuppression.status, 'not-configured');
    assert.equal(res.reactionSuppression.writable, false);
    assert.ok(String(res.reactionSuppression.whyNotWritable).length > 0, 'observe-only says why and what changes it');

    // configured-empty ≠ not-configured
    server.filtersState.applyParsed({ suppressedReactionEmojis: [] });
    res = (await call('filters_get', {})) as typeof res;
    assert.equal(res.reactionSuppression.status, 'configured-empty');

    // active, redacted
    server.filtersState.applyParsed(withKey());
    res = (await call('filters_get', {})) as typeof res;
    assert.equal(res.reactionSuppression.status, 'active');
    const blob = JSON.stringify(res);
    for (const secret of [SUPPRESSED_UNICODE, SUPPRESSED_BARE, 'sigil', SUPPRESSED_CUSTOM_ID]) {
      assert.ok(!blob.includes(secret), 'filters_get never echoes a suppressed entry');
    }

    // stale ≠ unavailable, and the plane carries the desired-state fact
    server.filtersState.markBroken('invalid');
    res = (await call('filters_get', {})) as typeof res;
    assert.equal(res.plane.status, 'stale');
    assert.equal(res.plane.desiredState, 'invalid');
    assert.equal(res.reactionSuppression.status, 'stale');
    assert.equal(res.reactionSuppression.protectionActive, true);
  });

  function stubAdapter(s: Record<string, unknown>): void {
    s.discord = {
      getFilters: () => ({}),
      updateFilters: () => ({ addedGuilds: [], removedGuilds: [] }),
      listGuilds: async () => [],
    };
  }

  it('guild/DM filters_update preserves the operator-owned suppression key (round trip)', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    server.filtersState.applyParsed(loadFiltersFile(path)!);
    const digestBefore = server.filtersState.suppressionStatus().effectiveDigest;

    stubAdapter(s);
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await call('filters_update', { setDmUsers: ['123456789012345678'] });

    const onDisk = loadFiltersFile(path)!;
    assert.deepEqual(onDisk.dmUsers, ['123456789012345678'], 'the whitelist change landed');
    assert.ok(onDisk.suppressedReactionEmojis?.length, 'suppression key survived the rewrite');
    assert.equal(
      server.filtersState.suppressionStatus().effectiveDigest,
      digestBefore,
      'effective suppression digest unchanged by a resident whitelist update',
    );
  });

  it('filters_update uses fresh file entries (operator edit inside the poll window survives)', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    server.filtersState.applyParsed(loadFiltersFile(path)!);

    // Operator adds an entry on disk; the 3s poller hasn't fired yet.
    const grown = [...FILE_TOKENS, ENV_ONLY_GLYPH];
    writeFileSync(path, JSON.stringify(withKey(grown)));

    stubAdapter(s);
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await call('filters_update', { setDmUsers: ['123456789012345678'] });

    const onDisk = loadFiltersFile(path)!;
    assert.equal(
      onDisk.suppressedReactionEmojis!.length,
      normalizeFilters({ suppressedReactionEmojis: grown }).suppressedReactionEmojis!.length,
      'the operator\'s fresh entry survives, not the process\'s stale copy',
    );
  });

  it('filters_update REFUSES when the filters file is malformed — bytes untouched', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    server.filtersState.applyParsed(loadFiltersFile(path)!);

    // The operator's file breaks (or a bad deploy corrupts it):
    writeFileSync(path, '{broken');
    stubAdapter(s);
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await assert.rejects(
      () => call('filters_update', { setDmUsers: ['123456789012345678'] }),
      /cannot be parsed.*Refusing to overwrite/s,
    );
    assert.equal(readFileSync(path, 'utf8'), '{broken', 'the malformed operator file was not touched');
  });

  it('filters_update REFUSES when the filters file is missing — nothing recreated from memory', async () => {
    const path = join(dir, 'filters.json');
    process.env.DISCORD_FILTERS_FILE = path;
    writeFileSync(path, JSON.stringify(withKey()));

    const server = makeServer();
    const s = server as unknown as Record<string, unknown>;
    server.filtersState.applyParsed(loadFiltersFile(path)!);

    rmSync(path);
    stubAdapter(s);
    const call = (s.executeToolCall as (name: string, args: Record<string, unknown>) => Promise<unknown>).bind(server);
    await assert.rejects(
      () => call('filters_update', { setDmUsers: ['123456789012345678'] }),
      /MISSING on disk.*Refusing to recreate/s,
    );
    assert.equal(existsSync(path), false, 'no file was recreated from process memory');
  });

  // Shared line-transcript renderer (issue #31): the missed sweep and the
  // first-interaction backscroll render current NET state through the same
  // projection as every other surface.

  function renderer(server: DiscordMcplServer): (r?: ReactionSummary[]) => string {
    const s = server as unknown as { renderReactionState(r?: ReactionSummary[]): string };
    return s.renderReactionState.bind(s);
  }

  it('line renderer shows net state and filters suppressed reactions', () => {
    const server = makeServer();
    server.filtersState.applyParsed(withKey());
    const out = renderer(server)([
      summary(SUPPRESSED_UNICODE),
      { ...summary(HARMLESS), me: true },
      summary(':sus:', SUPPRESSED_CUSTOM_ID),
    ]);
    assert.equal(out, ` [reactions: ${HARMLESS} x2 (incl. me)]`);
    assert.ok(
      !out.includes(SUPPRESSED_UNICODE) && !out.includes(SUPPRESSED_CUSTOM_ID),
      'no suppressed glyph or id in the suffix',
    );
  });

  it('line renderer: all-suppressed renders as no suffix, same as none', () => {
    const server = makeServer();
    server.filtersState.applyParsed(withKey());
    const render = renderer(server);
    // Projection policy: the model must not learn these exist — indistinguishable from "no reactions".
    assert.equal(render([summary(SUPPRESSED_UNICODE)]), '');
    assert.equal(render([]), '');
  });

  it('line renderer: unknown state and withhold-everything posture both render the unavailable marker', () => {
    const server = makeServer();
    server.filtersState.applyParsed(withKey());
    assert.equal(renderer(server)(undefined), ' [reactions: unavailable]');

    const broken = makeServer();
    broken.filtersState.markBroken('invalid');
    assert.equal(
      renderer(broken)([summary(HARMLESS)]),
      ' [reactions: unavailable]',
      'may not show what we have; may not claim none',
    );
  });
});
