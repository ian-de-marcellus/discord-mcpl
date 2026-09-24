import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Client } from 'discord.js';

const { DiscordAdapter } = await import('../src/discord-adapter.js');

// Discord also sends MESSAGE_UPDATE when it attaches a link preview (embed
// unfurl) to a message nobody edited. Residents were seeing every posted link
// twice, the second time as "[message edited]" (Ian, 2026-09-24).
describe('messageUpdate: only real edits surface as edits', () => {
  let adapter: InstanceType<typeof DiscordAdapter>;
  let client: Client;
  let emit: (event: string, ...args: unknown[]) => boolean;
  const edits: string[] = [];

  before(() => {
    adapter = new DiscordAdapter({ token: 'not-used', guildIds: ['g'] });
    client = (adapter as unknown as { client: Client }).client;
    emit = client.emit.bind(client) as unknown as (event: string, ...args: unknown[]) => boolean;
    adapter.onMessageEdit((_channelId, messageId) => { edits.push(messageId); });
  });

  after(() => { client.destroy(); });

  const msg = (id: string, content: string, editedTimestamp: number | null, partial = false) => ({
    id, content, editedTimestamp, partial, guildId: 'g', channelId: 'c', channel: { parentId: null },
    author: { id: 'someone-else', bot: false },
  });

  it('ignores an embed-only update of a cached, never-edited message', () => {
    emit('messageUpdate', msg('m1', 'look https://youtu.be/x', null), msg('m1', 'look https://youtu.be/x', null));
    assert.deepEqual(edits, []);
  });

  it('ignores an embed-only update of an uncached message', () => {
    emit('messageUpdate', msg('m2', '', null, true), msg('m2', 'look https://youtu.be/y', null));
    assert.deepEqual(edits, []);
  });

  it('ignores an embed-only update of a message that was edited earlier', () => {
    emit('messageUpdate', msg('m3', 'fixed text', 1000), msg('m3', 'fixed text', 1000));
    assert.deepEqual(edits, []);
  });

  it('passes a real edit through, cached or not', () => {
    emit('messageUpdate', msg('m4', 'typo', null), msg('m4', 'fixed', 2000));
    emit('messageUpdate', msg('m5', '', null, true), msg('m5', 'fixed', 3000));
    assert.deepEqual(edits, ['m4', 'm5']);
  });
});
