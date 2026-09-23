import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildCandidates,
  channelLabel,
  isSnowflake,
  parseChannelRef,
  resolveChannelName,
  type ChannelCandidate,
  type GuildLike,
} from '../src/channel-names.js';

const ch = (
  id: string, name: string, guildId: string, guildName: string,
  type: ChannelCandidate['type'] = 'text',
): ChannelCandidate => ({ id, name, guildId, guildName, type });

// Two guilds that both have #general — the case this feature exists for.
const SEPARATRIX_GENERAL = ch('100000000000000001', 'general', 'g1', 'Separatrix');
const ANIMA_GENERAL = ch('100000000000000002', 'general', 'g2', 'Anima Mundi');
const KITCHEN = ch('100000000000000003', 'kitchen-table', 'g1', 'Separatrix');
const CANDIDATES = [SEPARATRIX_GENERAL, ANIMA_GENERAL, KITCHEN];

describe('isSnowflake', () => {
  it('accepts 17-20 digit ids', () => {
    assert.ok(isSnowflake('12345678901234567'));
    assert.ok(isSnowflake('12345678901234567890'));
  });
  it('rejects names, short numbers, and mixed strings', () => {
    for (const v of ['general', '#general', '123', '1234567890123456789a', '']) {
      assert.ok(!isSnowflake(v), v);
    }
  });
});

describe('parseChannelRef', () => {
  it('passes raw snowflakes through unchanged', () => {
    assert.deepEqual(parseChannelRef('100000000000000001'),
      { kind: 'id', id: '100000000000000001' });
  });

  it('passes the existing MCPL composite through, extracting the channel id', () => {
    assert.deepEqual(
      parseChannelRef('discord:200000000000000000:100000000000000001'),
      { kind: 'id', id: '100000000000000001' });
  });

  it('accepts a composite whose ids are not snowflake-shaped', () => {
    // parseMcplChannelId (channels.ts) checks only parts[0] === 'discord'.
    // Being stricter here would reject composites the rest of the codebase
    // accepts -- which is exactly what the test fixtures use.
    assert.deepEqual(parseChannelRef('discord:g1:c1'), { kind: 'id', id: 'c1' });
  });

  it('accepts a bare name with or without the hash', () => {
    assert.deepEqual(parseChannelRef('#general'), { kind: 'name', name: 'general' });
    assert.deepEqual(parseChannelRef('general'), { kind: 'name', name: 'general' });
  });

  it('accepts the label form the system already prints', () => {
    // toDescriptor emits exactly this shape: `#${name} (${guildName})`
    assert.deepEqual(parseChannelRef('#general (Separatrix)'),
      { kind: 'name', name: 'general', guild: 'Separatrix' });
    assert.deepEqual(parseChannelRef('general (Anima Mundi)'),
      { kind: 'name', name: 'general', guild: 'Anima Mundi' });
  });

  it('handles guild names containing punctuation and spaces', () => {
    assert.deepEqual(parseChannelRef("#general (Jai's Lab — v2)"),
      { kind: 'name', name: 'general', guild: "Jai's Lab — v2" });
  });

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseChannelRef('  #kitchen-table (Separatrix)  '),
      { kind: 'name', name: 'kitchen-table', guild: 'Separatrix' });
  });

  it('returns null for empty-ish input', () => {
    for (const v of ['', '   ', '#', '  #  ']) assert.equal(parseChannelRef(v), null, JSON.stringify(v));
  });
});

describe('resolveChannelName', () => {
  it('resolves an unambiguous bare name', () => {
    const r = resolveChannelName({ name: 'kitchen-table' }, CANDIDATES);
    assert.ok(r.ok);
    assert.equal(r.id, KITCHEN.id);
  });

  it('is case-insensitive on both channel and guild', () => {
    const r = resolveChannelName({ name: 'KITCHEN-TABLE', guild: 'sEpArAtRiX' }, CANDIDATES);
    assert.ok(r.ok);
    assert.equal(r.id, KITCHEN.id);
  });

  it('HARD-ERRORS on a cross-guild collision rather than picking one', () => {
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
  });

  it('offers qualified labels when labels alone disambiguate', () => {
    // Cross-guild: the labels differ, so they are sufficient and the message
    // stays short. (Earlier this test also asserted the message contained NO
    // ids at all. That was wrong -- it encoded "ids are shameful" as an
    // invariant, when the problem was ids being the ONLY form. It also would
    // have blocked the fix below.)
    const r = resolveChannelName({ name: 'general' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.match(r.message, /#general \(Separatrix\)/);
    assert.match(r.message, /#general \(Anima Mundi\)/);
  });

  it('resolves a collision when the guild is supplied', () => {
    const a = resolveChannelName({ name: 'general', guild: 'Separatrix' }, CANDIDATES);
    assert.ok(a.ok);
    assert.equal(a.id, SEPARATRIX_GENERAL.id);
    const b = resolveChannelName({ name: 'general', guild: 'Anima Mundi' }, CANDIDATES);
    assert.ok(b.ok);
    assert.equal(b.id, ANIMA_GENERAL.id);
  });

  it('distinguishes wrong-guild from no-such-channel', () => {
    const r = resolveChannelName({ name: 'general', guild: 'Nowhere' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'not-found');
    assert.match(r.message, /exists elsewhere/);
    assert.match(r.message, /Separatrix/);
  });

  it('reports not-found for an unknown name', () => {
    const r = resolveChannelName({ name: 'no-such-room' }, CANDIDATES);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'not-found');
  });

  it('does no fuzzy matching', () => {
    // "kitchen-tables" and "kitchentable" must NOT reach kitchen-table. A
    // did-you-mean would reintroduce silent wrong-room delivery.
    for (const name of ['kitchen-tables', 'kitchentable', 'kitchen table', 'gener']) {
      const r = resolveChannelName({ name }, CANDIDATES);
      assert.ok(!r.ok, name);
      assert.equal(r.reason, 'not-found', name);
    }
  });

  it('treats an allowlist-filtered set as the whole world', () => {
    // Caller filters first. With the Anima copy removed, the bare name is no
    // longer ambiguous -- and a forbidden channel cannot manufacture a
    // spurious collision with a permitted one.
    const permitted = [SEPARATRIX_GENERAL, KITCHEN];
    const r = resolveChannelName({ name: 'general' }, permitted);
    assert.ok(r.ok);
    assert.equal(r.id, SEPARATRIX_GENERAL.id);
  });

  it('handles duplicate names within a single guild -- ACTIONABLY', () => {
    // Discord permits two same-named channels in different categories. The
    // earlier version of this test asserted only reason === 'ambiguous', which
    // passed while the message was a DEAD END: both suggestions rendered
    // identically, so re-sending either returned the same error and the agent
    // had no way forward but a regenerated snowflake. Classification is not
    // usefulness; assert the suggestions can actually be told apart.
    const dupe = ch('100000000000000004', 'general', 'g1', 'Separatrix');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, dupe]);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.message, /100000000000000001/);
    assert.match(r.message, /100000000000000004/);
  });

  it('TIE-BREAKS text over voice -- the stock-Discord collision', () => {
    // Nearly every server ships a VOICE channel named "General" beside text
    // #general, and matching is case-insensitive, so this is the DEFAULT state
    // of an ordinary server -- not an edge case. Without the tie-break the most
    // common configuration on Discord is unaddressable by name.
    const voice = ch('100000000000000005', 'General', 'g1', 'Separatrix', 'voice');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, voice]);
    assert.ok(r.ok, 'text should win over voice');
    assert.equal(r.id, SEPARATRIX_GENERAL.id);
  });

  it('does NOT tie-break when two sendable text channels collide', () => {
    // The tie-break resolves type ambiguity only. Two text channels are a real
    // ambiguity and must still hard-error -- with ids, since labels match.
    const dupe = ch('100000000000000006', 'general', 'g1', 'Separatrix', 'text');
    const r = resolveChannelName({ name: 'general', guild: 'Separatrix' },
      [SEPARATRIX_GENERAL, dupe]);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'ambiguous');
    assert.match(r.message, /id 1000000000000000/);
  });

  it('ambiguity message marks the type when labels collide', () => {
    const voice1 = ch('100000000000000007', 'lounge', 'g1', 'Separatrix', 'voice');
    const voice2 = ch('100000000000000008', 'lounge', 'g1', 'Separatrix', 'voice');
    const r = resolveChannelName({ name: 'lounge' }, [voice1, voice2]);
    assert.ok(!r.ok);
    assert.match(r.message, /\[voice\]/);
  });
});

describe('channelLabel', () => {
  it('round-trips through parseChannelRef', () => {
    // The invariant the whole design rests on: what we print is what we accept.
    for (const c of CANDIDATES) {
      const parsed = parseChannelRef(channelLabel(c));
      assert.deepEqual(parsed, { kind: 'name', name: c.name, guild: c.guildName });
      const r = resolveChannelName({ name: c.name, guild: c.guildName }, CANDIDATES);
      assert.ok(r.ok, channelLabel(c));
      assert.equal(r.id, c.id);
    }
  });
});


// ── buildCandidates: the filter that decides what is addressable at all ──────
// Previously untested, which the review correctly called out as coverage
// inverted relative to risk: the pure matcher is the part least likely to
// break, while THIS is where the allowlist is enforced.

const TYPES: Record<number, string> = {
  0: 'text', 2: 'voice', 4: 'category', 11: 'thread', 12: 'thread',
  13: 'unknown', 15: 'forum', 16: 'unknown',
};
const mapType = (t: number | undefined) => TYPES[t ?? -1] ?? 'unknown';
const chan = (id: string, name: string, type: number, parentId: string | null = null) =>
  ({ id, name, type, parentId });
const guild = (id: string, name: string, channels: ReturnType<typeof chan>[]): GuildLike =>
  ({ id, name, channels });
const allowAll = () => true;

describe('buildCandidates', () => {
  it('keeps only sendable kinds', () => {
    const g = guild('g1', 'Separatrix', [
      chan('1', 'text-room', 0), chan('2', 'voice-room', 2),
      chan('3', 'a-category', 4), chan('4', 'a-thread', 11),
      chan('5', 'a-forum', 15), chan('6', 'a-stage', 13), chan('7', 'media', 16),
    ]);
    const got = buildCandidates([g], { mapType, allowed: allowAll });
    assert.deepEqual(got.map((c) => c.name).sort(), ['text-room', 'voice-room']);
    // Forums 400 on a bare send; stage/media land in 'unknown'. All still
    // reachable by id -- excluded from NAME addressing only.
  });

  it('carries the type through, so the tie-break has something to work with', () => {
    const g = guild('g1', 'S', [chan('1', 'general', 0), chan('2', 'General', 2)]);
    const got = buildCandidates([g], { mapType, allowed: allowAll });
    assert.deepEqual(got.map((c) => c.type).sort(), ['text', 'voice']);
  });

  it('APPLIES THE ALLOWLIST -- an excluded channel is not addressable by name', () => {
    const g = guild('g1', 'S', [chan('1', 'public', 0), chan('2', 'secret', 0)]);
    const got = buildCandidates([g], {
      mapType, allowed: (_gid, cid) => cid !== '2',
    });
    assert.deepEqual(got.map((c) => c.name), ['public']);
    const r = resolveChannelName({ name: 'secret' }, got);
    assert.ok(!r.ok, 'an excluded channel must not resolve by name');
  });

  it('an excluded channel cannot manufacture a spurious collision', () => {
    // Two #general, one forbidden. The permitted one must resolve cleanly
    // rather than being blocked by a collision with a channel the caller is
    // not allowed to reach -- which is why filtering precedes matching.
    const g = guild('g1', 'S', [chan('1', 'general', 0), chan('2', 'general', 0)]);
    const got = buildCandidates([g], { mapType, allowed: (_g, cid) => cid === '1' });
    const r = resolveChannelName({ name: 'general' }, got);
    assert.ok(r.ok);
    assert.equal(r.id, '1');
  });

  it('honours the guild allowlist', () => {
    const gs = [guild('g1', 'A', [chan('1', 'x', 0)]), guild('g2', 'B', [chan('2', 'x', 0)])];
    const all = buildCandidates(gs, { mapType, allowed: allowAll });
    assert.equal(all.length, 2);
    const one = buildCandidates(gs, { mapType, allowed: allowAll, guildIds: ['g2'] });
    assert.deepEqual(one.map((c) => c.guildName), ['B']);
  });

  it('spans guilds and survives null channel entries', () => {
    const gs: GuildLike[] = [
      { id: 'g1', name: 'A', channels: [chan('1', 'x', 0), null] },
      guild('g2', 'B', [chan('2', 'y', 0)]),
    ];
    assert.equal(buildCandidates(gs, { mapType, allowed: allowAll }).length, 2);
  });
});

// ── Integration: the handleToolCall chokepoint ───────────────────────────────
// Sol's review: the resolver suite is strong but proves nothing about the
// SAFETY BOUNDARY — that resolution happens exactly once, before any side
// effect. These exercise the real DiscordMcplServer against a structural mock,
// asserting on what the adapter actually received.

import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter } from '../src/discord-adapter.js';
import { looksLikeExplicitName } from '../src/channel-names.js';

const SNOWFLAKE = '100000000000000001';

/** Minimal adapter recording what it was asked to do. `withResolver: false`
 *  models an adapter predating name addressing. */
function mockAdapter(withResolver: boolean) {
  const sent: Array<{ channelId: string; content: string }> = [];
  const base = {
    sent,
    async sendMessage(channelId: string, content: string) {
      sent.push({ channelId, content });
      return { messageId: 'm1' };
    },
    onMessage() {}, onChannelCreate() {}, onChannelDelete() {},
    onGuildCreate() {}, onReaction() {}, onSessionRestored() {},
    isConnected: true,
  };
  if (!withResolver) return base;
  return Object.assign(base, {
    resolveChannelRef(ref: string) {
      // Delegate id/composite handling to the real parser, as the real adapter
      // does — otherwise the mock quietly diverges from the thing under test.
      const parsed = parseChannelRef(ref);
      if (parsed?.kind === 'id') return { ok: true as const, id: parsed.id };
      if (/^#?general \(Separatrix\)$/i.test(ref)) {
        return { ok: true as const, id: SNOWFLAKE };
      }
      if (/^#?general$/i.test(ref)) {
        return {
          ok: false as const, reason: 'ambiguous' as const,
          message: '#general is ambiguous — 2 channels match.',
        };
      }
      return { ok: false as const, reason: 'not-found' as const, message: 'nope' };
    },
  });
}

const callTool = (adapter: unknown, args: Record<string, unknown>) => {
  const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
    handleToolCall(n: string, a: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  };
  return server.handleToolCall('send_message', { content: 'hi', ...args });
};

describe('handleToolCall chokepoint', () => {
  it('a qualified name reaches the adapter as a RESOLVED SNOWFLAKE', async () => {
    const a = mockAdapter(true);
    await callTool(a, { channelId: '#general (Separatrix)' });
    assert.deepEqual(a.sent.map((s) => s.channelId), [SNOWFLAKE],
      'adapter must never see the name');
  });

  it('an ambiguous name errors AND the send is never attempted', async () => {
    // The ordering proof: resolution precedes side effects. If this ever sends,
    // an ambiguous address has already left the building.
    const a = mockAdapter(true);
    const r = await callTool(a, { channelId: '#general' });
    assert.equal(r.isError, true);
    assert.equal(a.sent.length, 0, 'NOTHING may be sent on an ambiguous address');
    assert.match(r.content[0].text ?? '', /ambiguous/i);
  });

  it('a raw snowflake passes through untouched', async () => {
    const a = mockAdapter(true);
    await callTool(a, { channelId: SNOWFLAKE });
    assert.deepEqual(a.sent.map((s) => s.channelId), [SNOWFLAKE]);
  });

  it('the discord:<guild>:<channel> composite normalizes to the bare id', async () => {
    // Undocumented positive change: previously this reached channels.fetch()
    // verbatim and failed. Now it normalizes -- which also means downstream
    // state (sticky reply, mute sets) keys on the bare id rather than being
    // poisoned by a composite.
    const a = mockAdapter(true);
    await callTool(a, { channelId: `discord:200000000000000000:${SNOWFLAKE}` });
    assert.deepEqual(a.sent.map((s) => s.channelId), [SNOWFLAKE]);
  });

  it('a legacy adapter REFUSES explicit name syntax rather than passing it on', async () => {
    // "It probably bounces at Discord" is not the guarantee this feature is
    // for. Where we know a name was meant, fail here, where we can say why.
    const a = mockAdapter(false);
    const r = await callTool(a, { channelId: '#general (Separatrix)' });
    assert.equal(r.isError, true);
    assert.equal(a.sent.length, 0);
    assert.match(r.content[0].text ?? '', /no channel resolver|numeric channel id/i);
  });

  it('a legacy adapter still passes an OPAQUE id through unchanged', async () => {
    // Bare tokens are ambiguous between "name" and "opaque id from a
    // non-Discord adapter". Passing through is exactly the pre-feature
    // behaviour, so adapters that were valid yesterday keep working.
    const a = mockAdapter(false);
    await callTool(a, { channelId: 'c1' });
    assert.deepEqual(a.sent.map((s) => s.channelId), ['c1']);
  });
});

describe('looksLikeExplicitName', () => {
  it('recognises only unambiguous name syntax', () => {
    for (const v of ['#general', '#general (Separatrix)', 'general (Separatrix)']) {
      assert.ok(looksLikeExplicitName(v), v);
    }
    for (const v of ['c1', 'chan1', SNOWFLAKE, `discord:g1:${SNOWFLAKE}`, '']) {
      assert.ok(!looksLikeExplicitName(v), v);
    }
  });
});

// ── Regression: channel-type classification ─────────────────────────────────
// The announcement bug lived in mapChannelType, not in the matcher, and every
// existing candidate test supplies its OWN mapType — so none of them could see
// it. These drive the real mapping against the real addressability predicate.

import { mapChannelType } from '../src/discord-adapter.js';
import { isNameAddressableKind, formatChannelLabel } from '../src/channel-names.js';
import { toDescriptor } from '../src/channels.js';

describe('channel type classification', () => {
  // Discord's documented channel types, and what each should mean for us.
  const TYPES: Array<[number, string, boolean]> = [
    // type, kind, name-addressable?
    [0,  'text',         true],   // GuildText
    [2,  'voice',        true],   // GuildVoice — has text chat
    [4,  'category',     false],  // not sendable
    [5,  'announcement', true],   // GuildAnnouncement — REGRESSION GUARD
    [10, 'thread',       false],  // AnnouncementThread — names not unique
    [11, 'thread',       false],  // PublicThread
    [12, 'thread',       false],  // PrivateThread
    [13, 'unknown',      false],  // Stage — not sendable
    [15, 'forum',        false],  // Forum root — a bare send 400s
    [16, 'unknown',      false],  // Media — forum-like
  ];

  for (const [type, kind, addressable] of TYPES) {
    it(`type ${type} -> '${kind}', name-addressable: ${addressable}`, () => {
      assert.equal(mapChannelType(type), kind);
      assert.equal(isNameAddressableKind(mapChannelType(type)), addressable);
    });
  }

  it('an ANNOUNCEMENT channel is reachable by name', () => {
    // The regression: #announcements is about as common a channel name as
    // exists, and it silently fell out of name addressing while list_channels
    // kept printing a pasteable label for it.
    const guild: GuildLike = {
      id: 'g1', name: 'Separatrix',
      channels: [
        { id: '100000000000000001', name: 'general', type: 0, parentId: null },
        { id: '100000000000000002', name: 'announcements', type: 5, parentId: null },
      ],
    };
    const cands = buildCandidates([guild], { mapType: mapChannelType, allowed: () => true });
    const r = resolveChannelName({ name: 'announcements' }, cands);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.id, '100000000000000002');
  });

  it('tie-breaks an announcement channel against a same-named voice channel', () => {
    // Same stock-layout collision as text-vs-voice; announcement is textlike.
    const guild: GuildLike = {
      id: 'g1', name: 'Separatrix',
      channels: [
        { id: '100000000000000001', name: 'updates', type: 5, parentId: null },
        { id: '100000000000000002', name: 'Updates', type: 2, parentId: null },
      ],
    };
    const cands = buildCandidates([guild], { mapType: mapChannelType, allowed: () => true });
    const r = resolveChannelName({ name: 'updates' }, cands);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.id, '100000000000000001', 'the announcement channel must win');
  });

  it('an unclassified future type defaults to id-only, not to sendable', () => {
    // SENDABLE is an allowlist of named kinds on purpose: failing closed costs
    // a bounce, failing open costs a send to something that cannot receive it.
    assert.equal(mapChannelType(9999), 'unknown');
    assert.equal(isNameAddressableKind('unknown'), false);
  });
});

// ── The invariant, across module boundaries ─────────────────────────────────

describe('display form == address form', () => {
  it("toDescriptor's label parses back as a channel ref", () => {
    // The claim the whole feature rests on. These live in different modules
    // (channels.ts vs channel-names.ts) and previously built the string
    // independently, so nothing stopped them drifting apart.
    const desc = toDescriptor('g1', 'Separatrix', {
      id: '100000000000000001', name: 'kitchen-table', type: 'text',
      label: formatChannelLabel('kitchen-table', 'Separatrix'),
    });
    assert.deepEqual(parseChannelRef(desc.label!), {
      kind: 'name', name: 'kitchen-table', guild: 'Separatrix',
    });
  });

  it('every label a listing can emit is a parseable address', () => {
    for (const [name, guildName] of [
      ['general', 'Separatrix'],
      ['kitchen-table', 'Anima Mundi'],
      ['general', "Jai's Lab — v2"],
    ]) {
      const parsed = parseChannelRef(formatChannelLabel(name, guildName));
      assert.deepEqual(parsed, { kind: 'name', name, guild: guildName },
        formatChannelLabel(name, guildName));
    }
  });
});
