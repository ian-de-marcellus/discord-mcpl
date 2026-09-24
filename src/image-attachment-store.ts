/** Durable, content-addressed storage for Discord image attachments. */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { DiscordAttachment } from './discord-adapter.js';

export interface ImageSourceProvenance {
  messageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  timestamp: string;
}

export interface StoredImageAttachment {
  schema: 'discord-mcpl-image-attachment/v1';
  attachmentId: string;
  originalName: string;
  declaredContentType: string | null;
  contentSha256: string;
  originalBytes: number;
  normalizedSha256: string;
  normalizedBytes: number;
  normalizedMimeType: string;
  storedAt: string;
  sources: ImageSourceProvenance[];
}

export interface StoredImageInference {
  schema: 'discord-mcpl-image-inference/v1';
  kind: 'description' | 'ocr';
  contentSha256: string;
  promptSha256: string;
  model: string;
  createdAt: string;
  output: string;
}

export interface NormalizedStoredImage {
  bytes: Buffer;
  mimeType: string;
}

type ImageNormalizer = (
  bytes: Buffer,
  declaredContentType: string | null,
) => Promise<NormalizedStoredImage | null>;

const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

function safeId(id: string, label: string): string {
  if (!/^\d{1,32}$/.test(id)) throw new Error(`${label} must be a numeric Discord id`);
  return id;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function writePrivate(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseRecord(raw: string, path: string): StoredImageAttachment {
  const record = JSON.parse(raw) as StoredImageAttachment;
  if (
    record?.schema !== 'discord-mcpl-image-attachment/v1' ||
    typeof record.attachmentId !== 'string' ||
    typeof record.contentSha256 !== 'string' ||
    typeof record.normalizedSha256 !== 'string' ||
    typeof record.normalizedMimeType !== 'string' ||
    !Array.isArray(record.sources)
  ) {
    throw new Error(`Malformed image attachment record: ${path}`);
  }
  return record;
}

async function fetchCapped(url: string, declaredSize: number, timeoutMs = 20_000): Promise<Buffer> {
  if (declaredSize > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`declared image size ${declaredSize} exceeds ${MAX_SOURCE_IMAGE_BYTES}-byte preservation cap`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('image response had no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_SOURCE_IMAGE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error(`image exceeded ${MAX_SOURCE_IMAGE_BYTES}-byte preservation cap while downloading`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Original bytes are addressed by SHA-256; inference-safe renderings are
 * stored separately. Attachment-id records provide the stable Discord lookup
 * and retain every message provenance edge that presented the same id.
 */
export class ImageAttachmentStore {
  constructor(
    readonly root: string,
    private readonly normalize: ImageNormalizer,
  ) {
    mkdirSync(this.recordsDir(), { recursive: true, mode: 0o700 });
    mkdirSync(this.originalsDir(), { recursive: true, mode: 0o700 });
    mkdirSync(this.normalizedDir(), { recursive: true, mode: 0o700 });
    mkdirSync(this.inferencesDir(), { recursive: true, mode: 0o700 });
  }

  async preserve(
    attachment: DiscordAttachment,
    provenance: ImageSourceProvenance,
  ): Promise<StoredImageAttachment> {
    const attachmentId = safeId(attachment.id, 'attachmentId');
    const existing = this.get(attachmentId);
    if (existing) {
      const duplicateSource = existing.sources.some(
        (source) => source.messageId === provenance.messageId && source.channelId === provenance.channelId,
      );
      if (!duplicateSource) {
        existing.sources.push(provenance);
        this.writeRecord(existing);
      }
      return existing;
    }

    const original = await fetchCapped(attachment.url, attachment.size);
    const normalized = await this.normalize(original, attachment.contentType);
    if (!normalized) throw new Error('image could not be normalized to a model-supported format');

    const contentSha256 = sha256(original);
    const normalizedSha256 = sha256(normalized.bytes);
    const originalPath = join(this.originalsDir(), `${contentSha256}.bin`);
    const normalizedPath = join(this.normalizedDir(), `${normalizedSha256}.bin`);
    if (!existsSync(originalPath)) writePrivate(originalPath, original);
    if (!existsSync(normalizedPath)) writePrivate(normalizedPath, normalized.bytes);

    const record: StoredImageAttachment = {
      schema: 'discord-mcpl-image-attachment/v1',
      attachmentId,
      originalName: attachment.name,
      declaredContentType: attachment.contentType,
      contentSha256,
      originalBytes: original.length,
      normalizedSha256,
      normalizedBytes: normalized.bytes.length,
      normalizedMimeType: normalized.mimeType,
      storedAt: new Date().toISOString(),
      sources: [provenance],
    };
    this.writeRecord(record);
    return record;
  }

  get(attachmentId: string): StoredImageAttachment | null {
    const path = this.recordPath(safeId(attachmentId, 'attachmentId'));
    if (!existsSync(path)) return null;
    const record = parseRecord(readFileSync(path, 'utf8'), path);
    const originalPath = join(this.originalsDir(), `${record.contentSha256}.bin`);
    const normalizedPath = join(this.normalizedDir(), `${record.normalizedSha256}.bin`);
    if (!existsSync(originalPath) || !existsSync(normalizedPath)) {
      throw new Error(`Image attachment ${attachmentId} metadata exists but a content blob is missing`);
    }
    return record;
  }

  loadNormalized(attachmentId: string): { record: StoredImageAttachment; image: NormalizedStoredImage } {
    const record = this.get(attachmentId);
    if (!record) throw new Error(`Unknown preserved image attachment: ${attachmentId}`);
    return {
      record,
      image: {
        bytes: readFileSync(join(this.normalizedDir(), `${record.normalizedSha256}.bin`)),
        mimeType: record.normalizedMimeType,
      },
    };
  }

  inferenceKey(
    kind: StoredImageInference['kind'],
    record: StoredImageAttachment,
    promptSha256: string,
    model: string,
  ): string {
    const modelHash = sha256(model).slice(0, 16);
    return `${kind}-${record.contentSha256}-${promptSha256}-${modelHash}`;
  }

  getInference(key: string): StoredImageInference | null {
    if (!/^[a-z]+-[a-f0-9-]+$/.test(key)) throw new Error('Invalid image inference cache key');
    const path = join(this.inferencesDir(), `${key}.json`);
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as StoredImageInference;
    if (value?.schema !== 'discord-mcpl-image-inference/v1' || typeof value.output !== 'string') {
      throw new Error(`Malformed image inference record: ${path}`);
    }
    return value;
  }

  saveInference(key: string, value: StoredImageInference): void {
    if (!/^[a-z]+-[a-f0-9-]+$/.test(key)) throw new Error('Invalid image inference cache key');
    writePrivate(join(this.inferencesDir(), `${key}.json`), JSON.stringify(value, null, 2) + '\n');
  }

  static promptSha256(prompt: string): string {
    return sha256(prompt);
  }

  private recordsDir(): string { return join(this.root, 'records'); }
  private originalsDir(): string { return join(this.root, 'originals'); }
  private normalizedDir(): string { return join(this.root, 'normalized'); }
  private inferencesDir(): string { return join(this.root, 'inferences'); }
  private recordPath(attachmentId: string): string { return join(this.recordsDir(), `${attachmentId}.json`); }

  private writeRecord(record: StoredImageAttachment): void {
    writePrivate(this.recordPath(record.attachmentId), JSON.stringify(record, null, 2) + '\n');
  }
}

