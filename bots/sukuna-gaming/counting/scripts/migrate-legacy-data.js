import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { extractLegacyCountingData } from "../src/store.js";

const legacyPath = process.env.LEGACY_DATA_FILE;
const destinationPath = resolve(
  process.env.COUNTING_DATA_FILE || "./data/counting-data.json",
);

if (!legacyPath) {
  throw new Error(
    "Set LEGACY_DATA_FILE to the old sukuna-data.json path before running this migration.",
  );
}

const sourcePath = resolve(legacyPath);
if (sourcePath === destinationPath) {
  throw new Error("The legacy source and new counting destination must be different files.");
}

try {
  await access(destinationPath);
  throw new Error(
    `Destination already exists: ${destinationPath}. Move it aside before retrying; this script never overwrites counting data.`,
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const legacy = JSON.parse(await readFile(sourcePath, "utf8"));
const countingData = extractLegacyCountingData(legacy);
await mkdir(dirname(destinationPath), { recursive: true });

const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
try {
  await writeFile(
    temporaryPath,
    `${JSON.stringify(countingData, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const { rename } = await import("node:fs/promises");
  await rename(temporaryPath, destinationPath);
} catch (error) {
  const { unlink } = await import("node:fs/promises");
  await unlink(temporaryPath).catch(() => {});
  throw error;
}

const servers = Object.entries(countingData.guilds);
console.info(`Migrated counting progress for ${servers.length} server(s).`);
for (const [guildId, state] of servers) {
  console.info(
    `Server ${guildId}: current=${state.currentCount}, highest=${state.highestCount}, channel=${state.channelId ?? "disabled"}`,
  );
}
console.info(`New counting data saved to ${destinationPath}`);
console.info("The legacy file was not modified or deleted.");
