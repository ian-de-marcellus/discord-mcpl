import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ImageAttachmentStore } from '../src/image-attachment-store.js';
import type { DiscordAttachment } from '../src/discord-adapter.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function attachment(id = '1544493972251082772'): DiscordAttachment {
  return {
    id,
    name: 'page.png',
    url: `data:image/png;base64,${PNG.toString('base64')}`,
    contentType: 'image/png',
    size: PNG.length,
  };
}

function provenance(messageId = '1544493972251082773') {
  return {
    messageId,
    channelId: '1389348216558059523',
    guildId: '1389348213877768416',
    authorId: '379821091570319362',
    timestamp: '2026-09-07T10:00:00.000Z',
  };
}

test('preserves immutable original and normalized bytes with provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'discord-image-store-'));
  const images = new ImageAttachmentStore(root, async (bytes) => ({
    bytes,
    mimeType: 'image/png',
  }));

  const first = await images.preserve(attachment(), provenance());
  assert.equal(first.originalBytes, PNG.length);
  assert.equal(first.normalizedBytes, PNG.length);
  assert.equal(first.contentSha256, first.normalizedSha256);
  assert.equal(first.sources.length, 1);
  assert.deepEqual(images.loadNormalized(first.attachmentId).image.bytes, PNG);

  // Re-presenting the same immutable Discord attachment does not redownload;
  // a distinct provenance edge is retained exactly once.
  await images.preserve(attachment(), provenance('1544493972251082774'));
  await images.preserve(attachment(), provenance('1544493972251082774'));
  assert.equal(images.get(first.attachmentId)!.sources.length, 2);
});

test('caches marked model testimony by content, prompt, model, and kind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'discord-image-cache-'));
  const images = new ImageAttachmentStore(root, async (bytes) => ({ bytes, mimeType: 'image/png' }));
  const record = await images.preserve(attachment(), provenance());
  const promptSha256 = ImageAttachmentStore.promptSha256('Carefully describe this image.');
  const key = images.inferenceKey('description', record, promptSha256, 'claude-haiku-4-5-20251001');

  images.saveInference(key, {
    schema: 'discord-mcpl-image-inference/v1',
    kind: 'description',
    contentSha256: record.contentSha256,
    promptSha256,
    model: 'claude-haiku-4-5-20251001',
    createdAt: '2026-09-07T10:01:00.000Z',
    output: 'TYPE: screenshot\nTEXT: sparse\nSUBJECT: test\nUNCERTAINTY: none',
  });

  assert.equal(images.getInference(key)?.kind, 'description');
  assert.match(images.getInference(key)!.output, /TYPE: screenshot/);
  assert.notEqual(
    images.inferenceKey('ocr', record, promptSha256, 'claude-haiku-4-5-20251001'),
    key,
  );
});

test('rejects a declared source over the preservation ceiling before fetching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'discord-image-cap-'));
  const images = new ImageAttachmentStore(root, async (bytes) => ({ bytes, mimeType: 'image/png' }));
  await assert.rejects(
    images.preserve({ ...attachment(), size: 26 * 1024 * 1024 }, provenance()),
    /preservation cap/,
  );
});
