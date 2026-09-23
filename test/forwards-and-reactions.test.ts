/**
 * Unit tests for forwarded-message rendering and reaction snippets
 * (pure helpers in discord-adapter.ts — no Discord connection).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  DiscordAdapter,
  buildForwardedContent,
  buildReactionSnippet,
  mapAllAttachments,
  resolveVisibleContent,
} from '../src/discord-adapter.js';

/** Fake discord.js attachment Collection over raw attachment records. */
function attachmentColl(
  atts: Array<{ id: string; name?: string | null; url?: string; contentType?: string | null; size?: number }>,
) {
  return {
    size: atts.length,
    values: () =>
      atts
        .map((a) => ({
          id: a.id,
          name: a.name ?? null,
          url: a.url ?? `https://cdn.discordapp.example/${a.id}`,
          contentType: a.contentType ?? null,
          size: a.size ?? 0,
        }))
        .values(),
  };
}

/** Minimal stand-in for a discord.js Message with forwarded snapshots. */
function fakeMessage(opts: {
  content?: string;
  cleanContent?: string | null;
  snapshots?: Array<{ content?: string | null; attachments?: { size: number } }>;
}) {
  const snaps = opts.snapshots ?? [];
  return {
    content: opts.content ?? '',
    cleanContent: opts.cleanContent,
    messageSnapshots: { size: snaps.length, values: () => snaps },
  };
}

describe('buildReactionSnippet', () => {
  it('returns null for empty / missing / whitespace-only text', () => {
    assert.equal(buildReactionSnippet(null), null);
    assert.equal(buildReactionSnippet(undefined), null);
    assert.equal(buildReactionSnippet(''), null);
    assert.equal(buildReactionSnippet('   \n\t '), null);
  });

  it('passes short text through, trimmed', () => {
    assert.equal(buildReactionSnippet('  hello world  '), 'hello world');
  });

  it('collapses internal whitespace and newlines to single spaces', () => {
    assert.equal(
      buildReactionSnippet('first line\nsecond   line\n\nthird'),
      'first line second line third',
    );
  });

  it('caps long text at 80 chars with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const snippet = buildReactionSnippet(long);
    assert.ok(snippet);
    assert.equal(snippet.length, 80);
    assert.ok(snippet.endsWith('…'));
    assert.equal(snippet, 'a'.repeat(79) + '…');
  });

  it('renders custom-emoji tokens down to :name:', () => {
    assert.equal(
      buildReactionSnippet('nice <:blobheart:12345> work'),
      'nice :blobheart: work',
    );
  });
});

describe('buildForwardedContent', () => {
  it('returns the base content untouched when there are no snapshots', () => {
    assert.equal(buildForwardedContent('hi', []), 'hi');
    assert.equal(buildForwardedContent('', []), '');
  });

  it('renders a bare forward (no outer content) from its snapshot', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'the original text' }]),
      '[forwarded message] the original text',
    );
  });

  it('appends the forward below outer content when both exist', () => {
    assert.equal(
      buildForwardedContent('look at this:', [{ content: 'original' }]),
      'look at this:\n[forwarded message] original',
    );
  });

  it('notes attachments on an attachment-only forward', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '', attachments: { size: 2 } }]),
      '[forwarded message] [2 attachments]',
    );
    assert.equal(
      buildForwardedContent('', [{ content: null, attachments: { size: 1 } }]),
      '[forwarded message] [1 attachment]',
    );
  });

  it('notes an embed-only forward instead of rendering silence', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '', embeds: { length: 1 } }]),
      '[forwarded message] [embed]',
    );
  });

  it('keeps text AND attachment note when a forward has both', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'caption', attachments: { size: 1 } }]),
      '[forwarded message] caption [1 attachment]',
    );
  });

  it('falls back to an explicit no-content marker', () => {
    assert.equal(
      buildForwardedContent('', [{ content: '' }]),
      '[forwarded message] [no text content]',
    );
  });

  it('renders multiple snapshots one per line', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'one' }, { content: 'two' }]),
      '[forwarded message] one\n[forwarded message] two',
    );
  });

  it('renders custom-emoji tokens in the forwarded body down to :name:', () => {
    assert.equal(
      buildForwardedContent('', [{ content: 'so true <:blobheart:12345>' }]),
      '[forwarded message] so true :blobheart:',
    );
  });
});

describe('resolveVisibleContent (shared by live + history paths)', () => {
  it('renders a bare forward from its snapshot — the history-path regression', () => {
    // fetchHistory/fetchAround build HistoryMessages through this helper; a
    // bare forward must not come back as an empty message on backscroll or
    // the reconnect catch-up sweep.
    const m = fakeMessage({ content: '', cleanContent: '', snapshots: [{ content: 'origin text' }] });
    assert.equal(resolveVisibleContent(m), '[forwarded message] origin text');
  });

  it('prefers cleanContent, falling back to raw content when empty', () => {
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: '<@1> hi', cleanContent: '@ra hi' })),
      '@ra hi',
    );
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: 'dm text', cleanContent: undefined })),
      'dm text',
    );
  });

  it('passes non-forward messages through untouched', () => {
    assert.equal(
      resolveVisibleContent(fakeMessage({ content: 'plain', cleanContent: 'plain' })),
      'plain',
    );
  });

  it('appends the forward below outer commentary', () => {
    const m = fakeMessage({
      content: 'check this',
      cleanContent: 'check this',
      snapshots: [{ content: 'forwarded body', attachments: { size: 1 } }],
    });
    assert.equal(
      resolveVisibleContent(m),
      'check this\n[forwarded message] forwarded body [1 attachment]',
    );
  });

  it('tolerates a missing messageSnapshots collection (older gateway shapes)', () => {
    assert.equal(
      resolveVisibleContent({ content: 'hi', cleanContent: 'hi' }),
      'hi',
    );
  });
});

describe('mapAllAttachments (forwarded media rides the normal delivery path)', () => {
  it('maps a forwarded snapshot\'s attachments — previously only a count note', () => {
    const m = {
      attachments: attachmentColl([]),
      messageSnapshots: {
        size: 1,
        values: () => [
          {
            content: 'look at this cat',
            attachments: attachmentColl([
              { id: '111', name: 'cat.png', contentType: 'image/png', size: 12345 },
            ]),
          },
        ],
      },
    };
    const mapped = mapAllAttachments(m);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].name, 'cat.png');
    assert.equal(mapped[0].contentType, 'image/png');
    assert.equal(mapped[0].size, 12345);
  });

  it('merges outer + snapshot attachments, outer first', () => {
    const m = {
      attachments: attachmentColl([{ id: '1', name: 'outer.txt', size: 10 }]),
      messageSnapshots: {
        size: 2,
        values: () => [
          { attachments: attachmentColl([{ id: '2', name: 'snap-a.png', size: 20 }]) },
          { attachments: attachmentColl([{ id: '3', name: 'snap-b.md', size: 30 }]) },
        ],
      },
    };
    assert.deepEqual(
      mapAllAttachments(m).map((a) => a.name),
      ['outer.txt', 'snap-a.png', 'snap-b.md'],
    );
  });

  it('handles snapshots without a real collection (bare size, null, absent)', () => {
    const m = {
      attachments: attachmentColl([{ id: '1', name: 'outer.txt', size: 10 }]),
      messageSnapshots: {
        size: 3,
        values: () => [
          { content: 'count-only shape', attachments: { size: 2 } },
          { content: 'null attachments', attachments: null },
          { content: 'no attachments field' },
        ],
      },
    };
    assert.deepEqual(mapAllAttachments(m).map((a) => a.name), ['outer.txt']);
  });

  it('is mapAttachments-compatible for non-forward messages', () => {
    const m = { attachments: attachmentColl([{ id: '9', size: 5 }]) };
    const mapped = mapAllAttachments(m);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].name, '9'); // name falls back to id
    assert.equal(mapAllAttachments({ content: 'no attachments at all' } as never).length, 0);
  });

  it('dedups attachment ids across outer message and snapshots — first wins', () => {
    const m = {
      attachments: attachmentColl([{ id: 'dup', name: 'outer-copy.png', size: 10 }]),
      messageSnapshots: {
        size: 2,
        values: () => [
          // A re-forwarded forward can repeat the same attachment.
          { attachments: attachmentColl([{ id: 'dup', name: 'snap-copy.png', size: 10 }]) },
          { attachments: attachmentColl([
            { id: 'dup', name: 'snap-copy-again.png', size: 10 },
            { id: 'fresh', name: 'unique.md', size: 20 },
          ]) },
        ],
      },
    };
    const mapped = mapAllAttachments(m);
    assert.deepEqual(mapped.map((a) => a.name), ['outer-copy.png', 'unique.md']);
  });

  it('tags snapshot-sourced attachments with a 1-based snapshot index; outer stays untagged', () => {
    const m = {
      attachments: attachmentColl([{ id: '1', name: 'outer.txt', size: 10 }]),
      messageSnapshots: {
        size: 2,
        values: () => [
          { attachments: attachmentColl([{ id: '2', name: 'snap-a.png', size: 20 }]) },
          { attachments: attachmentColl([{ id: '3', name: 'snap-b.md', size: 30 }]) },
        ],
      },
    };
    const mapped = mapAllAttachments(m);
    assert.equal(mapped[0].forwardedSnapshotIndex, undefined);
    assert.equal(mapped[1].forwardedSnapshotIndex, 1);
    assert.equal(mapped[2].forwardedSnapshotIndex, 2);
  });

  it('works against a real discord.js Collection snapshot shape', async () => {
    const { Collection } = await import('discord.js');
    const atts = new Collection<string, unknown>();
    atts.set('c1', {
      id: 'c1', name: 'real.png',
      url: 'https://cdn.discordapp.example/real.png',
      contentType: 'image/png', size: 4321,
    });
    const snapshots = new Collection<string, unknown>();
    snapshots.set('s1', { content: 'forwarded body', attachments: atts });
    const m = {
      attachments: new Collection<string, unknown>() as never,
      messageSnapshots: snapshots as never,
    };
    const mapped = mapAllAttachments(m as never);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].name, 'real.png');
    assert.equal(mapped[0].contentType, 'image/png');
    assert.equal(mapped[0].forwardedSnapshotIndex, 1);
  });
});

describe('forwarded mentions and origin', () => {
  it('labels the origin and applies the mention renderer to snapshot text', () => {
    const out = buildForwardedContent('', [{ content: 'hi <@111111111111111111>' }], {
      origin: '#math (Other Guild)',
      renderMentions: (t) => t.replace('<@111111111111111111>', '@alice'),
    });
    assert.equal(out, '[forwarded message from #math (Other Guild)] hi @alice');
  });

  it('adapter resolves users, roles and channels from cache; unknown ids stay raw', () => {
    const adapter = new DiscordAdapter({ token: 'not-used' });
    const map = <V>(entries: Array<[string, V]>) => new Map(entries);
    (adapter as unknown as { client: unknown }).client = {
      channels: { cache: map([['333333333333333333', { name: 'math', guild: { id: 'g2', name: 'Other Guild' } }]]) },
      users: { cache: map([['222222222222222222', { username: 'bob', globalName: 'Bob B' }]]) },
    };
    const message = {
      channelId: '444444444444444444',
      guildId: 'g1',
      guild: {
        roles: { cache: map([['555555555555555555', { name: 'tutors' }]]) },
        members: { cache: map([['111111111111111111', { displayName: 'Alice' }]]) },
      },
      reference: { channelId: '333333333333333333', guildId: 'g2', type: 1 },
    };
    const opts = (adapter as unknown as { forwardRendering(m: unknown): Parameters<typeof buildForwardedContent>[2] })
      .forwardRendering(message);
    const out = buildForwardedContent('', [{
      content: '<@111111111111111111> <@!222222222222222222> <@&555555555555555555> <#333333333333333333> <@999999999999999999>',
    }], opts);
    assert.equal(
      out,
      '[forwarded message from #math (Other Guild)] @Alice @Bob B @tutors #math <@999999999999999999>',
    );
  });
});
