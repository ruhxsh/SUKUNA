# SUKUNA GAMING — Counting System

This is a standalone, isolated counting module for SUKUNA GAMING. It carries forward only the old SUKUNA counting feature and its counting progress. It does not import moderation, warnings, roles, welcome messages, social features, or any other old bot data.

## Requirements

- Node.js 22 or newer
- A dedicated Discord application/bot for the new SUKUNA system
- Message Content Intent enabled in the Discord Developer Portal
- Bot permissions in the counting channel: View Channel, Send Messages, Add Reactions, Manage Messages

## Commands

- `s setcounting #channel` — configure the counting channel (requires Manage Server)
- `s disablecounting` — disable counting without resetting progress (requires Manage Server)
- `s counting` — show the current count, highest count, and next number

Members post the next integer in the configured channel. A member cannot count twice consecutively. Correct entries receive a check mark. Incorrect numeric entries are deleted. Ordinary non-number messages are ignored.

The system stores counts as decimal strings and uses JavaScript BigInt internally, so the count is not limited by JavaScript's safe-integer range. Each server has independent progress. Simultaneous attempts to submit the same number are serialized so only one can be accepted.

## Preserve the old count

The old bot stored counting settings inside `sukuna-data.json`, alongside unrelated bot data. **Do not delete or overwrite that file until migration is complete and verified.**

1. Copy the old `sukuna-data.json` from the old host's persistent data directory to a safe location.
2. Install dependencies in this folder with `npm install`.
3. Run the migration with the environment variables below. This extracts only each server's counting channel, current count, highest count, and last successful counter ID. It ignores every other field.
4. Check the printed server/count summary and confirm it matches the old bot.
5. Keep the original legacy file as a backup until the new counting bot has successfully started and the count has been verified in Discord.

Example on Linux/macOS:

```sh
LEGACY_DATA_FILE="/path/to/old/data/sukuna-data.json" \
COUNTING_DATA_FILE="./data/counting-data.json" \
node scripts/migrate-legacy-data.js
```

On Windows PowerShell:

```powershell
$env:LEGACY_DATA_FILE="C:\path\to\old\data\sukuna-data.json"
$env:COUNTING_DATA_FILE=".\data\counting-data.json"
node scripts/migrate-legacy-data.js
```

The migration refuses to overwrite an existing destination. It does not modify or delete the legacy file. The new bot reads only `counting-data.json`.

## Run

Set these environment variables in the host's private environment settings:

- `DISCORD_TOKEN` — token for the new dedicated SUKUNA GAMING bot
- `COUNTING_DATA_DIR` — optional persistent directory for `counting-data.json`

Then run:

```sh
npm install
npm test
npm run check
npm start
```

Do not commit bot tokens or data files. Run only one instance against a given JSON data file; multiple bot instances require a shared transactional database.
