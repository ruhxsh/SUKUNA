# SUKUNA — Administration & Security

Independent Discord bot for server moderation, persistent warnings, moderation logs, configurable message automod, join-rate raid alerts, new-account age alerts, and audit-log permission anomaly alerts. It does not own social, gaming, music, community, voice, economy, giveaway, or general utility features.

## Release status and safety
This is a controlled-server testing release. Automated checks cover syntax, persistence, and selected security logic. A real Discord server test is still required before relying on it for enforcement. No automated raid punishment is performed.

Automod, raid detection, and account-age alerts are OFF by default. Automod can alert or delete only; it never automatically times out or bans. Raid, new-account, and audit-log anomaly detections only create alerts. Account age and join rate are heuristics, not proof of abuse. Configure thresholds conservatively and review alerts manually.

## Requirements and setup
- Node.js 22+
- A dedicated Discord application and bot token (do not reuse another SUKUNA bot's token)
- Persistent host storage; one running process per data directory
- Enable **Message Content Intent** and **Server Members Intent** in the Developer Portal.
- OAuth2 scopes: `bot` and `applications.commands` (slash commands are not implemented in this release; prefix commands are active).
- Bot permissions: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Kick Members, Ban Members, Moderate Members, and **View Audit Log**.
- Do not grant Administrator. Manage Roles is not required.
- Keep the bot role below server owner/admin roles and above only the member roles it is intended to moderate.
- Set `DISCORD_TOKEN` and `BOT_DATA_DIR` in the host environment. Never commit a token. `BOT_DATA_DIR` must be persistent and writable.
- Set the startup directory to `bots/sukuna-admin`, then run `npm install`, `npm run check`, `npm test`, and `npm start`.

## Commands
- `s help`
- `s kick @member [reason]`
- `s ban @member [reason]`
- `s unban USER_ID [reason]`
- `s timeout @member 10m [reason]` (1 second–28 days)
- `s untimeout @member [reason]`
- `s warn @member [reason]`
- `s warnings @member` (active warnings only; use a Discord ID if they have left)
- `s warninghistory @member` (all active and archived warnings; Discord ID also supported)\n- `s removewarn @member WARNING_NUMBER` (archives the warning; Discord ID also supported)
- `s clearwarnings @member` (archives active warnings and resets active numbering; Discord ID also supported)
- `s setmodlog #channel`
- `s disablemodlog`
- `s automod on|off|status`
- `s automod action alert|delete`
- `s automod block add|remove phrase`
- `s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT`
- `s automod ignore channel add|remove #channel`
- `s automod ignore role add|remove @role`
- `s raid on|off|status`
- `s raid limit 10`
- `s security status`
- `s security account-age on|off`
- `s security account-age-days 7`

Moderation actions require their matching Discord permission. Configuration, warning deletion, and warning clearing require Manage Server. Warnings store target ID, moderator ID, reason, timestamp, and a hidden unique record ID, and remain available after a member leaves. Active warning numbers are per-member and restart at Warning #1 after `s clearwarnings`. Clearing or removing an active warning archives it instead of deleting it. `s warnings` shows active warnings; `s warninghistory` shows active and archived records, including reasons, moderators, dates, and whether each record is active, cleared, or removed. Mentions are supported; Discord IDs remain available for members who have left.

## Security behavior
- **Automod:** per-user message-rate, repeated-message, mass-mention (including @everyone/@here), optional Discord invite-link filtering, and configured phrase detection. Channel/role exemptions are configurable. Alert/delete action is configurable.
- **Raid detection:** alerts when a configurable number of members join within a time window. No lock-down, kick, or ban is automated.
- **New-account alerts:** optionally alert when a joining account is younger than the configured age threshold. This is only a signal for staff review.
- **Audit-log anomaly alerts:** monitors recorded member kicks/bans and alerts when the executor lacks the matching Discord permission. This is not a complete role-authorization policy engine; it does not prove intent and does not undo actions.
- **Logging:** console logs always; optional configured Discord moderation-log channel. The bot must be able to view and send embeds in that channel.

## Storage and reliability
JSON storage is for one running process per data directory. Writes are serialized and written to unique temporary files, synced, then atomically renamed. Back up the data directory. Do not run multiple replicas against the same JSON file. Invalid JSON or an unsupported database version is moved to a timestamped `.corrupt-*` backup before a new empty database is created. Other filesystem errors stop startup rather than silently replacing data.

## Verification
Run `npm run check` and `npm test`. Tests use temporary directories and do not require a Discord token. Automated tests cannot verify Discord role hierarchy, live intents, host persistence, or actual moderation permissions; validate those in a private test server before enabling enforcement.
