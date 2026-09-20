/**
 * MCP tool definitions and input types for Discord operations.
 * These tools work in both MCP and MCPL mode.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Reusable schema for the optional `files` attachment parameter on send tools. */
const FILES_PROP = {
  type: 'array',
  description: 'Optional attachments: up to 10 files, each supplied by its absolute filesystem path on this host. Discord upload-size limits apply.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute local filesystem path to the file to upload' },
      name: { type: 'string', description: 'Optional display filename (defaults to the basename of path)' },
      description: { type: 'string', description: 'Optional alt-text / description shown for accessibility' },
    },
    required: ['path'],
  },
};

/** Keep everyday addressing instructions local; edge cases live in docs/tool-reference.md. */
const CHANNEL_ID_DESC =
  'Destination channel. Copy its qualified name from a channel listing (e.g. "#kitchen-table (Separatrix)"), ' +
  'or use a numeric Discord channel ID. Threads, categories and forum roots require numeric IDs. ' +
  'Ambiguous names return choices.';

const MESSAGE_ID_KIND =
  'Numeric Discord ID of the target message, copied from incoming messages or fetched history. ' +
  'Also supply the channel containing it.';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description: "Send a message to an explicit Discord channel, optionally with local file attachments. Use reply_message to reply to a particular message. An explicit send also updates this server’s reply-routing state.",
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId'],
    },
  },
  {
    name: 'reply_message',
    description: 'Reply to a specific message in a Discord channel, optionally with file attachments',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to reply to. ' + MESSAGE_ID_KIND },
        content: { type: 'string', description: 'Reply content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'send_dm',
    description: "Send a direct message to a Discord user, identified by @username / display name (of someone in a shared server or who has DMed the bot) or by numeric user ID. To reply to a DM you received, pass the sender's name or id. Optionally include file attachments.",
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Discord @username / display name (of a member in a shared server or someone who has DMed the bot), or a numeric user ID (snowflake)' },
        content: { type: 'string', description: 'Message content (optional if files are attached)' },
        files: FILES_PROP,
      },
      required: ['userId'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add a reaction (emoji) to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to react to. ' + MESSAGE_ID_KIND },
        emoji: { type: 'string', description: 'A unicode emoji (e.g. 👍), or a custom server emoji as `:name:` (discover names/ids with list_emojis) or its full `<:name:id>` token.' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'remove_reaction',
    description: 'Remove this bot\'s reaction (emoji) from a message',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message whose reaction should be removed. ' + MESSAGE_ID_KIND },
        emoji: { type: 'string', description: 'The unicode or custom emoji previously added by this bot.' },
      },
      required: ['channelId', 'messageId', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to edit. ' + MESSAGE_ID_KIND },
        content: { type: 'string', description: 'New message content' },
      },
      required: ['channelId', 'messageId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete a message sent by this bot',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to delete. ' + MESSAGE_ID_KIND },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_guilds',
    description: "List Discord servers known to the connected bot, with IDs, names and member counts. Use a guild ID with list_channels to enumerate its channels. This does not list ambient-message subscriptions.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_channels',
    description: "List channels in one Discord server, specified by guildId, subject to configured channel filters. Returns channel IDs, names, types, parent IDs and labels. Listing a channel does not subscribe to its traffic. Use list_subscriptions for ambient subscriptions.",
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
      },
      required: ['guildId'],
    },
  },
  {
    name: 'list_channel_members',
    description: "List people associated with a Discord channel, with IDs and display names. For a guild channel: members who can view it; for a thread: joined members; for a DM: participants. Check scope, note and truncated. This does not report who is online or reading now. Use fetch_history for messages.",
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_emojis',
    description: "List custom server emojis available to the bot, with names and IDs. Supply guildId for one server or omit it to span known servers. These are emoji assets, not recent reactions.",
    inputSchema: {
      type: 'object',
      properties: {
        guildId: {
          type: 'string',
          description:
            'Optional: limit to one guild (raw guild id). Omit to list custom emojis across all guilds the bot is in.',
        },
      },
    },
  },
  {
    name: 'refresh_channels',
    description:
      'Re-scan every Discord channel the bot can currently see and register any ' +
      'that the host does not yet know about. Use this if you were added to a new ' +
      'server or channel after startup and it is not showing up in your channel ' +
      'list. Returns the count of visible channels and any newly-registered ones.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'filters_get',
    description:
      'Show the active event filters: which guilds/channels can deliver events to you ' +
      '(guild whitelist, optional per-guild channel whitelist) and which users may DM you. ' +
      'null means unrestricted. Filters gate delivery only — the bot must also be a ' +
      'member of a guild to see it at all. Reports the config plane\'s desired-vs-effective ' +
      'state (live / stale / unavailable — whitelists and suppression share one lifecycle, so ' +
      'a broken filters file makes ALL of them stale together) and reaction-suppression state ' +
      '(status/count/digest, never the entries themselves): some reaction markers are ' +
      'withheld from your view across every surface. Those entries are operator-maintained ' +
      'in the filters file and not adjustable from this tool surface — that is a facility ' +
      'not built yet (a referential suppress-by-key surface is planned host-side), not a ' +
      'policy about you. Note: some reactions on your account are placed by the host, not ' +
      'by you; "me": true on a reaction is not evidence you authored it.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'filters_update',
    description:
      'Hot-adjust the event filters — takes effect immediately, no restart. Requires ' +
      'DISCORD_FILTERS_FILE to be configured (filters_get tells you). If the guild filter ' +
      'is currently unrestricted, the first add/remove materializes it as the list of all ' +
      'current guilds first, so nothing silently drops. Newly-allowed guilds have their ' +
      'channels registered right away. Reaction-suppression entries are operator-owned and ' +
      'ride through updates untouched; this tool has no parameter that can carry them. ' +
      'If the filters file is missing or unparseable on disk, updates are refused without ' +
      'writing anything — an operator repairs the file (hot reload applies it within seconds) ' +
      'and the update can then be retried.',
    inputSchema: {
      type: 'object',
      properties: {
        addGuilds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Guilds to allow. Each entry is a raw guild id ("111" = every channel; on an ' +
            'already-restricted guild this LIFTS the channel restriction) or ' +
            '"111:222+333" (only those channel ids; merges into an existing channel list).',
        },
        removeGuilds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Guild ids to remove from the whitelist. Their events stop being delivered immediately.',
        },
        setDmUsers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Replace the DM-user whitelist with these user ids. CAREFUL: an empty array ' +
            'means UNRESTRICTED (DMs from anyone), matching the env-unset semantics. Omit to leave DMs unchanged.',
        },
      },
    },
  },
  {
    name: 'fetch_history',
    description: "Read past messages from a Discord channel, including message IDs. Use before/after message IDs and limit to select history; configured backscroll limits may reduce the amount. Use list_channel_members for people rather than messages.",
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        limit: { type: 'number', description: 'Max messages to fetch (default 50)' },
        before: {
          type: 'string',
          description:
            'Only fetch messages older than this message ID (exclusive). ' +
            'Use the oldest ID you already have to page further back.',
        },
        after: {
          type: 'string',
          description:
            'Only fetch messages newer than this message ID (exclusive). ' +
            'Use the newest ID you already have to fetch what is new.',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_around',
    description:
      'Scroll to a specific message and fetch the surrounding context. Returns a ' +
      'window of messages centred on `messageId` (the message itself plus roughly ' +
      'half the window on either side). Single request, so `limit` is capped at 100.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: {
          type: 'string',
          description: 'Message to centre the window on. ' + MESSAGE_ID_KIND,
        },
        limit: {
          type: 'number',
          description: 'Total window size, centred on the message (default 50, max 100)',
        },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'create_text_channel',
    description: 'Create a new text channel in a guild',
    inputSchema: {
      type: 'object',
      properties: {
        guildId: { type: 'string', description: 'Discord guild ID' },
        name: { type: 'string', description: 'Channel name' },
        categoryId: { type: 'string', description: 'Parent category ID (optional)' },
      },
      required: ['guildId', 'name'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Delete a Discord channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to delete. ' + CHANNEL_ID_DESC },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'set_reaction_visibility',
    description:
      'Opt a channel in or out of showing emoji reactions live. When ON, reactions ' +
      'added or removed on ANY message in that channel appear in your context as ' +
      'they happen — but they NEVER wake you; you just see them next time you are ' +
      'active. Default OFF, persisted across restarts. (Reactions on history you ' +
      'fetch always show via fetch_history regardless of this setting.)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        visible: {
          type: 'boolean',
          description: 'true = surface live reactions from this channel; false = stop.',
        },
      },
      required: ['channelId', 'visible'],
    },
  },
  {
    name: 'mute_channel',
    description:
      'Mute a Discord channel entirely: no ambient messages, no wake on @mentions ' +
      'or replies, and it will NOT auto-subscribe you back in when mentioned. Also ' +
      'drops any existing ambient subscription. Use this to stay out of a channel ' +
      'that keeps pulling you in. Persisted across restarts. Reverse with unmute_channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to mute. ' + CHANNEL_ID_DESC },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'unmute_channel',
    description:
      'Un-mute a Discord channel: mentions and DMs reach you again. Does not by ' +
      'itself reopen ordinary traffic — use channel_open for that. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to unmute. ' + CHANNEL_ID_DESC },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'list_subscriptions',
    description: "Inspect ambient-message subscriptions and the recorded missed-message backlog for unsubscribed channels. This does not enumerate all Discord channels; use list_channels for that.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'channel_missed',
    description:
      'Report how much ambient (non-mention, non-DM) traffic you have missed in ' +
      'a channel since you UNSUBSCRIBED from it — returns missed message and ' +
      'character counts. Note the baseline is your unsubscribe point, NOT a ' +
      'read/seen watermark; the portal surface exposes a same-named ' +
      '`channel_missed` that instead counts since your last-read watermark, so do ' +
      'not assume identical semantics across surfaces. Mentions and DMs are always ' +
      'delivered and are not counted. Useful for deciding whether to resubscribe. ' +
      'Counts are durable across restarts and backfill downtime gaps on reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to check. ' + CHANNEL_ID_DESC },
      },
      required: ['channelId'],
    },
  },
];
