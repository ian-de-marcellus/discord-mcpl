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
  description:
    'Optional file attachments to upload with the message. This (discord-mcpl) ' +
    'surface uploads by host file PATH — each entry is read from a local ' +
    'filesystem path on the host (e.g. a file you created in your workspace or ' +
    'sandbox); it does NOT accept inline base64 bytes. (The portal surface is the ' +
    'opposite: it wants inline base64 bytes.) Up to 10 files per message; size ' +
    'limits are enforced by Discord.',
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

/**
 * Shared param descriptions that spell out how this surface's ids differ from
 * the portal surface, so an agent that learned one does not silently mis-call
 * the other. discord-mcpl talks to Discord directly; portal/portal-mcpl talks
 * to a relay and uses a different id scheme.
 */
const CHANNEL_ID_DESC =
  'Channel to act on. Accepts EITHER a name or an id — prefer the name, it is ' +
  'far easier to get right than a 19-digit snowflake.\n' +
  '  • `#kitchen-table (Separatrix)` — the exact label shown in channel ' +
  'listings and announcements. Normally unambiguous; paste it back verbatim. ' +
  '(Discord permits duplicate channel names within one server, so if two ' +
  'candidates share a label the error lists their ids instead.)\n' +
  '  • `#kitchen-table` — shorthand. Errors (listing the qualified options) if ' +
  'the name exists in more than one server, rather than guessing.\n' +
  '  • `123456789012345678` — raw Discord snowflake, still accepted.\n' +
  'Names are matched exactly (case-insensitive, leading # optional); there is ' +
  'no fuzzy matching, so a near-miss fails loudly instead of delivering to the ' +
  'wrong room. If two channels share a name the error lists them with ids, ' +
  'which are always a valid address. Threads, categories and forum roots are ' +
  'addressable by id only. A channel whose own name ends in parentheses ' +
  '(e.g. `#standup (weekly)`) must use the qualified form, since bare parens ' +
  'read as a guild. Surface ' +
  'marker: discord-mcpl namespaces its MCPL channels as ' +
  '`discord:<guildId>:<channelId>` — a different id space from the portal ' +
  'surface (`portal:<channelId>`).';

/** Contrasts a per-channel Discord snowflake against portal's global relay id. */
const MESSAGE_ID_KIND =
  'Discord message snowflake — unique only WITHIN its channel, so you must pass ' +
  'channelId together with messageId. (The portal surface instead takes a ' +
  'durable, globally-unique relay message id and needs messageId alone — no ' +
  'channelId.)';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description: 'Send a message to a Discord channel, optionally with file attachments',
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
    name: 'pin_message',
    description:
      'Pin a Discord message as a durable shared bookmark. Requires Manage Messages permission in the channel. ' +
      'Use fetch_history or fetch_around when you need to discover the message ID.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to pin. ' + MESSAGE_ID_KIND },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'unpin_message',
    description: 'Remove a Discord message from the channel pins. Requires Manage Messages permission.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'Message to unpin. ' + MESSAGE_ID_KIND },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'list_guilds',
    description: 'List Discord guilds (servers) the bot is in',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_channels',
    description: 'List channels in a Discord guild',
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
    description:
      'List channel membership. Guild channels return everyone with view ' +
      'permission; threads return their JOINED members only (a public thread ' +
      'may be readable by non-joined users with parent access — see `scope` ' +
      "and `note` in the result); DMs return the two parties. Channels " +
      "outside this residence's configured channel filters cannot be " +
      'inspected — filters bound inspection, not just delivery. Humans sort ' +
      'before bots. Large channels are capped (`truncated: true`, with ' +
      '`total` still the full count).',
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
    description:
      'List the custom (server) emojis available to use. Put `token` (e.g. ' +
      '`<:name:id>`) in message content to render one, or pass `reactionArg` ' +
      '(`:name:`) to add_reaction. Reactions and message emojis draw from this ' +
      'same set. Returns name, id, animated flag, message `token`, and `reactionArg`.',
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
    description:
      'Fetch message history from a channel. By default returns the most recent ' +
      'messages. Use `before` (a message ID) to scroll further back — pass the ID ' +
      'of the oldest message you have seen to page backwards through older history. ' +
      'Use `after` (a message ID) to fetch only messages newer than a given point. ' +
      'The `before`/`after` cursors are Discord message snowflakes (the portal ' +
      'surface accepts a relay id or a snowflake there). ' +
      'Pagination is automatic, so `limit` may exceed Discord\'s 100-per-request cap.',
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
    name: 'delivery_policy_get',
    description:
      'Inspect operator-created high-traffic room batching. Reports the three ' +
      'resident-adjustable wake thresholds (message count, character count, and ' +
      'max latency), the fixed direct-address fragment grace, and current pending ' +
      'counts. This does not reveal or widen any Discord access boundary.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delivery_policy_set',
    description:
      'Tune the three wake thresholds for an already operator-approved high-traffic ' +
      'room. Whichever threshold arrives first flushes the chronological batch. ' +
      'This cannot add a room, change its guild, alter the direct-address grace, or ' +
      'change image handling.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        maxMessages: {
          type: 'number',
          description: 'Wake after this many pending messages (integer 1–500). Omit to leave unchanged.',
        },
        maxCharacters: {
          type: 'number',
          description: 'Wake after this many pending message characters (integer 1–1,000,000). Omit to leave unchanged.',
        },
        maxLatencyMinutes: {
          type: 'number',
          description: 'Wake this many minutes after the oldest pending message (up to 7 days). Omit to leave unchanged.',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'fetch_attachments',
    description:
      'Load the attachments of one specific message into your context: images ' +
      'as images, text files inline, audio transcribed (same limits as live ' +
      'delivery). Use it when attachments did not reach you: a caption and its ' +
      'images sent as separate messages, an image that dropped from context, or ' +
      'a forward whose files you only saw noted. Includes files inside forwards.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: CHANNEL_ID_DESC },
        messageId: { type: 'string', description: 'The message whose attachments to load. ' + MESSAGE_ID_KIND },
      },
      required: ['channelId', 'messageId'],
    },
  },
  {
    name: 'attachment_info',
    description:
      'Inspect provenance and hashes for an image preserved from a configured ' +
      'busy Discord room. Use the immutable attachment id shown beside its marked ' +
      'model description. Does not load the image itself.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', description: 'Immutable Discord attachment id from the delivered provenance marker.' },
      },
      required: ['attachmentId'],
    },
  },
  {
    name: 'load_attachment_image',
    description:
      'Load a previously preserved Discord image directly into this context by ' +
      'immutable attachment id. This is direct observation (unlike the automatic ' +
      'Haiku routing description). The original bytes remain retained; the loaded ' +
      'rendering is normalized only for model compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', description: 'Immutable Discord attachment id from the delivered provenance marker.' },
      },
      required: ['attachmentId'],
    },
  },
  {
    name: 'ocr_attachment',
    description:
      'Ask the isolated configured image reader to transcribe visible text from a ' +
      'previously preserved image. The result is explicitly marked as model-generated ' +
      'transcription, retains model/prompt provenance, and never replaces the image.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', description: 'Immutable Discord attachment id from the delivered provenance marker.' },
      },
      required: ['attachmentId'],
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
    description:
      'List the Discord channels currently subscribed for ambient message ' +
      'delivery. Also reports `unsubscribedWithBacklog`: channels you have ' +
      'unsubscribed from that have since accumulated missed ambient messages.',
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
