/**
 * Feature set declarations for the Discord MCPL server.
 */

import type { FeatureSetDeclaration } from '@animalabs/mcpl-core';

/** Array-form declaration entry: a core FeatureSetDeclaration plus its name
 *  inline. mcpl-core 0.5 types `McplCapabilities.featureSets` as the §5.2
 *  Record-keyed-by-name shape, but this server still advertises the legacy
 *  ARRAY form — hashed verbatim by the §17 digest conformance corpus and
 *  normalized by hosts (af feature-set-manager handles Array.isArray).
 *  Changing the wire shape changes the manifest digest, so migrating to the
 *  Record form is a deliberate fleet decision (harness #5 adjacency), not a
 *  type-error fix. Types-only adaptation here; bytes on the wire unchanged. */
export interface NamedFeatureSetDeclaration extends FeatureSetDeclaration {
  name: string;
  /** 0.2.1-era field (state patches opt-in), dropped from the 0.5 core type
   *  (§8 out of scope for 0.5.0). Kept on the wire for digest stability —
   *  wrong-typed/extra fields hash verbatim per the conformance corpus.
   *  Required (not optional): the installed 0.2.1 core type requires it, so
   *  an optional override is a TS2430; every declaration supplies it, and
   *  once the dep moves to an 0.5 core (no hostState on the parent) a
   *  required extra field here stays legal while keeping the wire stable. */
  hostState: boolean;
}

export const featureSets: NamedFeatureSetDeclaration[] = [
  {
    name: 'discord.messaging',
    description: 'Send, read, react to messages in Discord channels',
    // SPEC §6.4 derives feature-set availability from `uses` FAIL-CLOSED, so
    // an incomplete list disables the set the moment a host enforces it. This
    // set does not merely call tools and publish: it pushes events (reactions,
    // wake-worthy messages), receives inbound channel traffic, registers the
    // channel descriptors, and is subject to host open/close. Issue #14.
    uses: [
      'tools',
      'channels.publish',
      'pushEvents',
      'channels.incoming',
      'channels.register',
      'channels.lifecycle',
      // Review (Sol, PR #15): the server also HANDLES the streaming
      // terminators (outgoing/chunk + outgoing/complete — finalize-only
      // since this PR), channels/acknowledge (server.ts), and
      // channels/typing. `channels: true` advertises all seven leaves, and
      // §6.4 requires `uses` to describe the capabilities the feature
      // actually exercises — an incomplete list ships a manifest that does
      // not describe handlers already present.
      'channels.streaming',
      'channels.acknowledge',
      'channels.typing',
    ],
    rollback: true,
    hostState: false,
    // MCPL RFC-001 — tags carried on Discord message events (emits umbrellas
    // directly, so no host-side implication expansion is needed).
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:reply', 'chat:dm', 'chat:ambient',
        'chat:private', 'chat:from-human', 'chat:from-bot', 'chat:thread',
        'chat:reaction', 'chat:reaction-remove',
        'chat:has-image', 'chat:has-audio', 'chat:has-file',
      ],
      // RFC-001 rev 2: `suggestedTreatment` (formerly `defaultTreatment`) — a
      // producer HINT requiring explicit host acceptance (SPEC §16.5), never
      // auto-applied policy. The pinned @animalabs/mcpl-core still types the
      // retired name; mcpl-core-ts#6 renames it in the same release train, so
      // the wire carries the spec name now and the cast comes off when the
      // library lands. Advisory-only either way: nothing may act on it without
      // explicit acceptance, so no behaviour rides on which name a host reads.
      ...({
        suggestedTreatment: [
          { tagsAny: ['chat:addressed'], behavior: 'immediate' },
          { tagsAny: ['chat:ambient', 'chat:from-bot'], behavior: { throttle: { perMs: 120000 } } },
        ],
      } as object),
      // Discord-specific extensions (e.g. discord:everyone, discord:slash) may be
      // emitted in future; consumers should tolerate undeclared tags.
      open: true,
    },
  },
  {
    name: 'discord.channels',
    description: 'Create, delete, and manage Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'discord.history',
    description: 'Fetch message history from Discord channels',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'discord.subscriptions',
    description:
      'Manage per-channel ambient-message subscriptions (which channels deliver ' +
      'non-mention messages for passive awareness). Mentions and DMs are always ' +
      'delivered and are not affected by subscriptions.',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
];

/** Check if a feature set is in a given enabled list. */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  // Check exact match
  if (enabledSets.has(name)) return true;
  // Check wildcard (e.g., "discord.*")
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'remove_reaction':
    case 'list_emojis':
    case 'edit_message':
    case 'delete_message':
      return 'discord.messaging';
    case 'create_text_channel':
    case 'delete_channel':
      return 'discord.channels';
    case 'fetch_history':
    case 'fetch_around':
    case 'fetch_attachments':
      return 'discord.history';
    case 'subscribe_channel':
    case 'unsubscribe_channel':
    case 'mute_channel':
    case 'unmute_channel':
    case 'list_subscriptions':
    case 'channel_missed':
    case 'set_reaction_visibility':
      return 'discord.subscriptions';
    case 'list_guilds':
    case 'list_channels':
    case 'list_channel_members':
    case 'refresh_channels':
    case 'filters_get':
    case 'filters_update':
      return undefined; // Always available
    default:
      return undefined;
  }
}
