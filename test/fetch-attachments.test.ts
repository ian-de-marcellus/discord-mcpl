/**
 * fetch_attachments: an agent can load the files of a specific message it
 * didn't receive them with (a caption and its images sent as two messages, an
 * image dropped from context, an expired CDN link).
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { DiscordMcplServer } from '../src/server.js';
import type { DiscordAdapter, DiscordAttachment } from '../src/discord-adapter.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);

type Result = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };

function serverWith(attachments: DiscordAttachment[]) {
  const calls: Array<[string, string]> = [];
  const adapter = {
    isConnected: true,
    async fetchMessageAttachments(channelId: string, messageId: string) {
      calls.push([channelId, messageId]);
      return { attachments, authorName: 'ian', content: 'here are the scans' };
    },
  };
  const server = new DiscordMcplServer(adapter as unknown as DiscordAdapter) as unknown as {
    handleToolCall(name: string, args: Record<string, unknown>): Promise<Result>;
  };
  return { server, calls };
}

describe('fetch_attachments', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('loads a message’s image and text attachments as native blocks', async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      new Response(String(url).endsWith('.png') ? PNG : 'page one notes')) as typeof fetch;
    const { server, calls } = serverWith([
      { id: 'a1', name: 'scan.png', url: 'https://cdn.example/a1/scan.png', contentType: 'image/png', size: PNG.length },
      { id: 'a2', name: 'notes.txt', url: 'https://cdn.example/a2/notes.txt', contentType: 'text/plain', size: 14 },
    ]);

    const res = await server.handleToolCall('fetch_attachments', {
      channelId: '100000000000000001',
      messageId: '200000000000000002',
    });

    assert.equal(res.isError, undefined, JSON.stringify(res));
    assert.deepEqual(calls, [['100000000000000001', '200000000000000002']]);
    assert.match(res.content[0].text ?? '', /Attachments of message 200000000000000002 from ian — 2 files\. Its text: "here are the scans"/);
    assert.ok(res.content.some((b) => b.type === 'image'), 'image delivered as an image block');
    assert.ok(res.content.some((b) => (b.text ?? '').includes('page one notes')), 'text file inlined');
  });

  it('says so plainly when the message has no attachments', async () => {
    const { server } = serverWith([]);
    const res = await server.handleToolCall('fetch_attachments', {
      channelId: '100000000000000001',
      messageId: '200000000000000002',
    });
    assert.match(res.content[0].text ?? '', /has no attachments/);
  });
});
