import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DATA_VERSION = 1;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const COUNT_PATTERN = /^\d{1,100}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

function normalizeCount(value, fallback = "0") {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : fallback;
  }

  if (typeof value === "string" && COUNT_PATTERN.test(value)) {
    return BigInt(value).toString();
  }

  return fallback;
}

function defaultGuildState() {
  return {
    channelId: null,
    currentCount: "0",
    highestCount: "0",
    lastCounterId: null,
  };
}

export function normalizeCountingData(raw) {
  if (!isRecord(raw) || raw.version !== DATA_VERSION || !isRecord(raw.guilds)) {
    throw new Error("The counting data file has an unsupported or invalid format.");
  }

  const guilds = {};
  for (const [guildId, entry] of Object.entries(raw.guilds)) {
    if (!isSnowflake(guildId) || !isRecord(entry)) continue;

    const currentCount = normalizeCount(entry.currentCount);
    const highestCount = normalizeCount(entry.highestCount, currentCount);
    const current = BigInt(currentCount);
    const highest = BigInt(highestCount);

    guilds[guildId] = {
      channelId: isSnowflake(entry.channelId) ? entry.channelId : null,
      currentCount,
      highestCount: (highest > current ? highest : current).toString(),
      lastCounterId: isSnowflake(entry.lastCounterId) ? entry.lastCounterId : null,
    };
  }

  return { version: DATA_VERSION, guilds };
}

export function extractLegacyCountingData(raw) {
  if (!isRecord(raw) || !isRecord(raw.guilds)) {
    throw new Error("The legacy SUKUNA data file does not contain a valid guild settings object.");
  }

  const guilds = {};
  for (const [guildId, legacy] of Object.entries(raw.guilds)) {
    if (!isSnowflake(guildId) || !isRecord(legacy)) continue;

    const currentCount = normalizeCount(legacy.currentCount);
    const highestCount = normalizeCount(legacy.highestCount, currentCount);
    const channelId = isSnowflake(legacy.countingChannelId)
      ? legacy.countingChannelId
      : null;
    const lastCounterId = isSnowflake(legacy.lastCounterId)
      ? legacy.lastCounterId
      : null;

    if (
      channelId === null &&
      currentCount === "0" &&
      highestCount === "0" &&
      lastCounterId === null
    ) {
      continue;
    }

    guilds[guildId] = {
      channelId,
      currentCount,
      highestCount: (BigInt(highestCount) > BigInt(currentCount)
        ? BigInt(highestCount)
        : BigInt(currentCount)).toString(),
      lastCounterId,
    };
  }

  return normalizeCountingData({ version: DATA_VERSION, guilds });
}

export class CountingStore {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.data = { version: DATA_VERSION, guilds: {} };
    this.queue = Promise.resolve();
  }

  static fromEnvironment() {
    const directory = resolve(
      process.env.COUNTING_DATA_DIR || join(process.cwd(), "data"),
    );
    return new CountingStore(join(directory, "counting-data.json"));
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const contents = await readFile(this.filePath, "utf8");
      this.data = normalizeCountingData(JSON.parse(contents));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.data = { version: DATA_VERSION, guilds: {} };
        return this;
      }

      if (error instanceof SyntaxError) {
        throw new Error(
          `Counting data is not valid JSON. The original file was left untouched: ${this.filePath}`,
        );
      }

      throw error;
    }

    return this;
  }

  getGuildState(guildId) {
    if (!isSnowflake(guildId)) throw new Error("Invalid server ID.");
    const state = this.data.guilds[guildId] ?? defaultGuildState();
    return { ...state };
  }

  async runExclusive(operation) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolveQueue) => {
      release = resolveQueue;
    });

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setChannel(guildId, channelId) {
    if (!isSnowflake(guildId) || (channelId !== null && !isSnowflake(channelId))) {
      throw new Error("Invalid counting server or channel ID.");
    }

    return this.runExclusive(async () => {
      const previous = this.getGuildState(guildId);
      this.data.guilds[guildId] = { ...previous, channelId };

      try {
        await this.writeAtomically();
      } catch (error) {
        this.data.guilds[guildId] = previous;
        throw error;
      }

      return this.getGuildState(guildId);
    });
  }

  async recordCount(guildId, countText, userId) {
    if (
      !isSnowflake(guildId) ||
      !isSnowflake(userId) ||
      typeof countText !== "string" ||
      !COUNT_PATTERN.test(countText)
    ) {
      throw new Error("Invalid counting entry.");
    }

    return this.runExclusive(async () => {
      const state = this.getGuildState(guildId);
      const submitted = BigInt(countText);
      const expected = BigInt(state.currentCount) + 1n;

      if (submitted !== expected) {
        return { accepted: false, reason: "wrong-number", state };
      }

      if (userId === state.lastCounterId) {
        return { accepted: false, reason: "same-member", state };
      }

      const previous = this.data.guilds[guildId] ?? defaultGuildState();
      const next = {
        ...state,
        currentCount: submitted.toString(),
        highestCount: (submitted > BigInt(state.highestCount)
          ? submitted
          : BigInt(state.highestCount)).toString(),
        lastCounterId: userId,
      };
      this.data.guilds[guildId] = next;

      try {
        await this.writeAtomically();
      } catch (error) {
        this.data.guilds[guildId] = previous;
        throw error;
      }

      return { accepted: true, reason: null, state: { ...next } };
    });
  }

  async writeAtomically() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;

    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async flush() {
    await this.queue.catch(() => {});
  }
}

export { DATA_VERSION, COUNT_PATTERN };
