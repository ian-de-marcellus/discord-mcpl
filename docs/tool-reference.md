# Discord addressing and attachments

For ordinary use, copy a qualified channel name from a listing, or use a numeric Discord channel ID. A reply also needs the target message's numeric ID. Tool schemas specify which fields each action requires.

## Channel names

- `#kitchen-table (Separatrix)` identifies a channel and its server. Copy the listing's label exactly.
- `#kitchen-table` is accepted when unambiguous. If several channels match, the error supplies choices; use one of their numeric IDs.
- Matching is case-insensitive; the leading `#` is optional. There is no fuzzy matching.
- Discord permits duplicate channel names even in a single server; use the returned IDs if qualified names are still ambiguous.
- A channel name that itself ends with parentheses, such as `#standup (weekly)`, needs the full server-qualified form or a numeric ID. Bare parentheses are interpreted as the server qualifier.
- Threads, categories, and forum roots are addressable by numeric ID only. Being addressable does not mean every tool operation supports every channel type.

## Different identifier formats

Discord tools accept Discord channel names/IDs as described above. Framework channel tools and incoming events may instead identify the connection as `discord:<guildId>:<channelId>`; follow those tools' own schemas. The separate portal integration uses `portal:<channelId>` and relay message identifiers. Do not transfer portal identifiers or argument conventions into Discord tools.

For Discord message operations, copy the numeric messageId from incoming messages or fetched history and supply its channelId too. Do not guess message IDs.

## Attachments

Discord send/reply/DM tools accept up to 10 local files through their files array. Each item needs an absolute filesystem path on the host, not a workspace mount-prefixed path and not inline base64. Optional name changes the displayed filename; optional description supplies accessibility text. Discord enforces upload-size limits.

Workspace mount-prefixed paths must first be resolved to the corresponding host filesystem path. That mapping belongs to the deployment; there are no universal mount names. Confirm that a newly written attachment exists on disk before sending it.

The separate portal interface uses inline base64 attachments; that is not the format used by these Discord tools.

Deployments can expose this document through their resident's file-reading tool. Tool definitions do not assume a particular documentation mount exists.
