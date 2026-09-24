/**
 * Durable threshold batching for high-traffic Discord rooms.
 *
 * The bridge records each normalized gateway message before doing any slow
 * attachment/model work.  A caller can then drain a stable prefix in order,
 * suppressing wake on every item except the final one.  This keeps Chronicle
 * provenance message-granular while producing one resident activation for a
 * burst of room traffic.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { DiscordMessageData } from './discord-adapter.js';

export interface DeliveryChannelPolicy {
  guildId: string;
  maxMessages: number;
  maxCharacters: number;
  maxLatencyMs: number;
  addressedSettleMs: number;
  imageTriage?: boolean;
}

interface DeliveryPolicyDocument {
  schema: 'discord-mcpl-delivery-policy/v1';
  channels: Record<string, DeliveryChannelPolicy>;
}

type SerializedDiscordMessageData = Omit<DiscordMessageData, 'timestamp'> & {
  timestamp: string;
};

interface BufferedMessage {
  message: SerializedDiscordMessageData;
  enqueuedAt: number;
}

interface BufferedChannel {
  pending: BufferedMessage[];
  addressedDeadlineAt?: number;
  addressedAuthorId?: string;
  addressedVersion: number;
}

interface DeliveryQueueDocument {
  schema: 'discord-mcpl-delivery-queue/v1';
  channels: Record<string, BufferedChannel>;
}

export interface DeliveryBatchSnapshot {
  channelId: string;
  messages: DiscordMessageData[];
  wakeThroughMessageId: string;
  addressedVersion: number;
  reason: 'message-count' | 'character-budget' | 'direct-address' | 'max-latency';
}

export interface DeliveryPolicyStatus extends DeliveryChannelPolicy {
  channelId: string;
  pendingMessages: number;
  pendingCharacters: number;
  oldestPendingAt: string | null;
  nextWakeAt: string | null;
}

function assertInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function validatePolicy(raw: unknown, path: string): DeliveryPolicyDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Delivery policy ${path} must be a JSON object`);
  }
  const doc = raw as Partial<DeliveryPolicyDocument>;
  if (doc.schema !== 'discord-mcpl-delivery-policy/v1') {
    throw new Error(`Delivery policy ${path} has an unsupported or missing schema`);
  }
  if (!doc.channels || typeof doc.channels !== 'object' || Array.isArray(doc.channels)) {
    throw new Error(`Delivery policy ${path}.channels must be an object`);
  }
  for (const [channelId, value] of Object.entries(doc.channels)) {
    if (!/^\d{17,20}$/.test(channelId)) {
      throw new Error(`Delivery policy channel key ${JSON.stringify(channelId)} is not a Discord snowflake`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Delivery policy channel ${channelId} must be an object`);
    }
    const policy = value as unknown as DeliveryChannelPolicy;
    if (!/^\d{17,20}$/.test(policy.guildId)) {
      throw new Error(`Delivery policy channel ${channelId}.guildId is not a Discord snowflake`);
    }
    assertInteger(policy.maxMessages, `${channelId}.maxMessages`, 1, 500);
    assertInteger(policy.maxCharacters, `${channelId}.maxCharacters`, 1, 1_000_000);
    assertInteger(policy.maxLatencyMs, `${channelId}.maxLatencyMs`, 1_000, 7 * 24 * 60 * 60_000);
    assertInteger(policy.addressedSettleMs, `${channelId}.addressedSettleMs`, 0, 60_000);
    if (policy.imageTriage !== undefined && typeof policy.imageTriage !== 'boolean') {
      throw new Error(`${channelId}.imageTriage must be a boolean`);
    }
  }
  return doc as DeliveryPolicyDocument;
}

function validateQueue(raw: unknown, path: string): DeliveryQueueDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Delivery queue ${path} must be a JSON object`);
  }
  const doc = raw as Partial<DeliveryQueueDocument>;
  if (doc.schema !== 'discord-mcpl-delivery-queue/v1') {
    throw new Error(`Delivery queue ${path} has an unsupported or missing schema`);
  }
  if (!doc.channels || typeof doc.channels !== 'object' || Array.isArray(doc.channels)) {
    throw new Error(`Delivery queue ${path}.channels must be an object`);
  }
  for (const [channelId, value] of Object.entries(doc.channels)) {
    const channel = value as BufferedChannel;
    if (!channel || !Array.isArray(channel.pending) || !Number.isInteger(channel.addressedVersion)) {
      throw new Error(`Delivery queue ${path} has a malformed channel entry for ${channelId}`);
    }
    for (const entry of channel.pending) {
      const message = entry?.message;
      if (
        !entry || !message || typeof message !== 'object' ||
        typeof message.id !== 'string' || typeof message.channelId !== 'string' ||
        message.channelId !== channelId || typeof message.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(message.timestamp)) ||
        !Number.isFinite(entry.enqueuedAt)
      ) {
        throw new Error(`Delivery queue ${path} contains a malformed message in ${channelId}`);
      }
    }
  }
  return doc as DeliveryQueueDocument;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

function restoreMessage(message: SerializedDiscordMessageData): DiscordMessageData {
  const timestamp = new Date(message.timestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Buffered Discord message has invalid timestamp');
  return { ...message, timestamp };
}

/**
 * Policy + pending-message state.  A configured policy is operator-created;
 * the resident may tune only its three batching thresholds, never add a new
 * room or widen a Discord boundary through this class.
 */
export class DeliveryBatchStore {
  private policy: DeliveryPolicyDocument;
  private queue: DeliveryQueueDocument;

  constructor(
    private readonly policyPath: string,
    private readonly queuePath: string,
  ) {
    if (!existsSync(policyPath)) {
      throw new Error(`DISCORD_DELIVERY_POLICY_FILE does not exist: ${policyPath}`);
    }
    this.policy = validatePolicy(JSON.parse(readFileSync(policyPath, 'utf8')), policyPath);
    if (existsSync(queuePath)) {
      this.queue = validateQueue(JSON.parse(readFileSync(queuePath, 'utf8')), queuePath);
    } else {
      this.queue = { schema: 'discord-mcpl-delivery-queue/v1', channels: {} };
      this.saveQueue();
    }
  }

  channelIds(): string[] {
    return Object.keys(this.policy.channels);
  }

  policyFor(channelId: string, guildId?: string | null): DeliveryChannelPolicy | null {
    const policy = this.policy.channels[channelId];
    if (!policy) return null;
    if (guildId !== undefined && guildId !== null && guildId !== policy.guildId) return null;
    return { ...policy };
  }

  manages(message: DiscordMessageData): boolean {
    return this.policyFor(message.channelId, message.guildId) !== null;
  }

  /** Persist synchronously before returning to the gateway callback. */
  enqueue(message: DiscordMessageData, directAddress: boolean, now = Date.now()): boolean {
    const policy = this.policyFor(message.channelId, message.guildId);
    if (!policy) return false;
    const channel = this.queue.channels[message.channelId] ??= {
      pending: [],
      addressedVersion: 0,
    };
    if (channel.pending.some((entry) => entry.message.id === message.id)) return true;

    channel.pending.push({
      message: { ...message, timestamp: message.timestamp.toISOString() },
      enqueuedAt: now,
    });

    // A direct human address starts a short fragment-grace period.  Further
    // messages from that same author during the grace period extend it, so a
    // thought split by Discord's length limit arrives in one activation.
    if (directAddress) {
      channel.addressedAuthorId = message.authorId;
      channel.addressedDeadlineAt = now + policy.addressedSettleMs;
      channel.addressedVersion += 1;
    } else if (
      channel.addressedDeadlineAt !== undefined &&
      channel.addressedAuthorId === message.authorId &&
      now <= channel.addressedDeadlineAt
    ) {
      channel.addressedDeadlineAt = now + policy.addressedSettleMs;
      channel.addressedVersion += 1;
    }

    this.saveQueue();
    return true;
  }

  /** Return a stable prefix to drain; newly-arriving messages stay behind it. */
  snapshotIfDue(channelId: string, now = Date.now()): DeliveryBatchSnapshot | null {
    const policy = this.policy.channels[channelId];
    const channel = this.queue.channels[channelId];
    if (!policy || !channel || channel.pending.length === 0) return null;
    const characters = channel.pending.reduce((sum, entry) => sum + entry.message.cleanContent.length, 0);
    const oldestDue = channel.pending[0].enqueuedAt + policy.maxLatencyMs;

    // Once a human directly addresses the resident, honor the complete
    // fragment-grace interval even when that message also crosses an ambient
    // count/character threshold. Otherwise the fifteenth message in a burst
    // could wake immediately and split the very multi-message thought the
    // grace period exists to keep together.
    if (channel.addressedDeadlineAt !== undefined && now < channel.addressedDeadlineAt) {
      return null;
    }

    let reason: DeliveryBatchSnapshot['reason'] | null = null;
    if (channel.addressedDeadlineAt !== undefined) reason = 'direct-address';
    else if (channel.pending.length >= policy.maxMessages) reason = 'message-count';
    else if (characters >= policy.maxCharacters) reason = 'character-budget';
    else if (now >= oldestDue) reason = 'max-latency';
    if (!reason) return null;

    const messages = channel.pending.map((entry) => restoreMessage(entry.message));
    return {
      channelId,
      messages,
      wakeThroughMessageId: messages[messages.length - 1].id,
      addressedVersion: channel.addressedVersion,
      reason,
    };
  }

  dueSnapshots(now = Date.now()): DeliveryBatchSnapshot[] {
    return this.channelIds()
      .map((channelId) => this.snapshotIfDue(channelId, now))
      .filter((snapshot): snapshot is DeliveryBatchSnapshot => snapshot !== null);
  }

  /** Earliest policy deadline; count/character thresholds return "now". */
  nextDeadline(now = Date.now()): number | null {
    let next: number | null = null;
    for (const channelId of this.channelIds()) {
      const policy = this.policy.channels[channelId];
      const channel = this.queue.channels[channelId];
      if (!channel || channel.pending.length === 0) continue;
      const characters = channel.pending.reduce((sum, entry) => sum + entry.message.cleanContent.length, 0);
      const deadline = channel.addressedDeadlineAt !== undefined
        ? channel.addressedDeadlineAt
        : channel.pending.length >= policy.maxMessages || characters >= policy.maxCharacters
        ? now
        : channel.pending[0].enqueuedAt + policy.maxLatencyMs;
      next = next === null ? deadline : Math.min(next, deadline);
    }
    return next;
  }

  /** Remove exactly one positively acknowledged head message. */
  acknowledgeHead(channelId: string, messageId: string): void {
    const channel = this.queue.channels[channelId];
    if (!channel || channel.pending[0]?.message.id !== messageId) {
      throw new Error(`Delivery queue head mismatch for ${channelId}: expected ${channel?.pending[0]?.message.id ?? '(empty)'}, got ${messageId}`);
    }
    channel.pending.shift();
    if (channel.pending.length === 0 && channel.addressedDeadlineAt === undefined) {
      delete this.queue.channels[channelId];
    }
    this.saveQueue();
  }

  /** Clear the direct-address deadline only if no later fragment extended it. */
  acknowledgeWake(channelId: string, addressedVersion: number): void {
    const channel = this.queue.channels[channelId];
    if (!channel) return;
    if (channel.addressedVersion === addressedVersion) {
      delete channel.addressedDeadlineAt;
      delete channel.addressedAuthorId;
    }
    if (channel.pending.length === 0 && channel.addressedDeadlineAt === undefined) {
      delete this.queue.channels[channelId];
    }
    this.saveQueue();
  }

  statuses(): DeliveryPolicyStatus[] {
    return this.channelIds().sort().map((channelId) => {
      const policy = this.policy.channels[channelId];
      const channel = this.queue.channels[channelId];
      const pending = channel?.pending ?? [];
      const next = pending.length === 0
        ? null
        : Math.min(
            pending[0].enqueuedAt + policy.maxLatencyMs,
            channel?.addressedDeadlineAt ?? Number.POSITIVE_INFINITY,
          );
      return {
        channelId,
        ...policy,
        pendingMessages: pending.length,
        pendingCharacters: pending.reduce((sum, entry) => sum + entry.message.cleanContent.length, 0),
        oldestPendingAt: pending.length > 0 ? new Date(pending[0].enqueuedAt).toISOString() : null,
        nextWakeAt: next === null || !Number.isFinite(next) ? null : new Date(next).toISOString(),
      };
    });
  }

  updateThresholds(
    channelId: string,
    patch: { maxMessages?: number; maxCharacters?: number; maxLatencyMs?: number },
  ): DeliveryPolicyStatus {
    const current = this.policy.channels[channelId];
    if (!current) {
      throw new Error(`Channel ${channelId} has no operator-created delivery policy; this tool cannot add rooms`);
    }
    if (patch.maxMessages !== undefined) {
      assertInteger(patch.maxMessages, 'maxMessages', 1, 500);
    }
    if (patch.maxCharacters !== undefined) {
      assertInteger(patch.maxCharacters, 'maxCharacters', 1, 1_000_000);
    }
    if (patch.maxLatencyMs !== undefined) {
      assertInteger(patch.maxLatencyMs, 'maxLatencyMs', 1_000, 7 * 24 * 60 * 60_000);
    }
    if (
      patch.maxMessages === undefined &&
      patch.maxCharacters === undefined &&
      patch.maxLatencyMs === undefined
    ) {
      throw new Error('Provide at least one threshold to change');
    }
    this.policy.channels[channelId] = { ...current, ...patch };
    writePrivateJson(this.policyPath, this.policy);
    return this.statuses().find((status) => status.channelId === channelId)!;
  }

  private saveQueue(): void {
    writePrivateJson(this.queuePath, this.queue);
  }
}
