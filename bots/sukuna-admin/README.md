# SUKUNA — Administration & Security

Independent Discord bot for moderation, warnings, moderation logs, configurable message automod, and conservative join-rate raid alerts. It does not own social, gaming, music, community, voice, economy, giveaway, or general utility features.

## Requirements and setup
- Node.js 22+
- A dedicated Discord application and bot token
- Persistent host storage
- Enable **Message Content Intent** and **Server Members Intent** in the Developer Portal.
- OAuth2 scopes: `bot` and `applications.commands` (slash commands are not implemented in this release; prefix commands are active).
- Bot permissions: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Kick Members, Ban Members, Moderate Members. Add View Audit Log only if a future audited security feature requires it. Do not grant Administrator.
- Keep the bot role below the server owner/admin roles and above roles it is authorized to moderate.
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
- `s warnings USER_ID` (works even if the member has left)
- `s removewarn USER_ID WARNING_ID`
- `s clearwarnings USER_ID`
- `s setmodlog #channel`
- `s disablemodlog`
- `s automod on|off|status`
- `s automod action alert|delete`
- `s automod block add|remove phrase`
- `s automod limits MAX_MESSAGES INTERVAL_MS DUPLICATE_LIMIT MENTION_LIMIT`
- `s raid on|off|status`
- `s raid limit 10`

Moderation actions require their matching Discord permission. Configuration, warning deletion, and warning clearing require Manage Server. Warning records include target ID, moderator ID, reason, timestamp, and unique record ID and persist independently of member presence.

## Safety defaults
Automod and raid detection are **off by default**. Automod is configurable per guild and can alert or delete; it does not automatically timeout or ban. Raid protection only detects a configurable join-rate threshold and alerts through the moderation log; it never automatically locks channels, kicks, or bans. Tune thresholds for the server before enabling. Exempt channels/roles can be added through persisted config by an administrator; command UI for those exemptions is not included yet.

## Storage and reliability
JSON storage is intended for one running process per data directory. Writes are serialized, written to unique temporary files, synced, and atomically renamed. Keep backups. Do not run multiple replicas against the same JSON file. If the database is invalid, the original is moved to a timestamped corrupt backup before a fresh file is created.

## Verification
Run `npm run check` and `npm test`. Tests use temporary directories and do not require a Discord token. Live Discord permissions, host persistence, and moderation behavior still require a controlled test server.
