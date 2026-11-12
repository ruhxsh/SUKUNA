# SUKUNA — Multi-Bot Project

This repository is being rebuilt as a clean, multi-bot system.

## Preserved feature

The only feature carried forward from the old SUKUNA bot is the counting system. It now lives in `bots/sukuna-gaming/counting/` and is assigned to **SUKUNA GAMING**.

## Important data note

The old bot's live data file is not stored in GitHub. Do not delete the old host's `sukuna-data.json` until the counting migration has been run and verified. Use the migration script in the counting folder to extract only counting channels, counts, highest counts, and last counter IDs.

## Archived source

The previous repository code is preserved on the `archive/old-sukuna-before-cleanup` branch. The active `main` branch contains only the new counting system until the other independent bots are added.

## Checks

The counting package has automated syntax and test checks in GitHub Actions. See its README for setup and migration instructions.
