import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "./config.js";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyState = () => ({ version: 1, guilds: {} });

function normalizeState(value) {
  if (!isObject(value) || !isObject(value.guilds)) return emptyState();
  const state = emptyState();
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    if (!/^\d{17,20}$/.test(guildId) || !isObject(guild)) continue;
    const warnings = Array.isArray(guild.warnings) ? guild.warnings.filter(w =>
      isObject(w) && typeof w.id === "string" &&
      /^\d{17,20}$/.test(w.targetId || "") &&
      /^\d{17,20}$/.test(w.moderatorId || "") &&
      typeof w.reason === "string" && typeof w.createdAt === "string"
    ) : [];
    const config = isObject(guild.config) ? guild.config : {};
    state.guilds[guildId] = {
      config: {
        ...structuredClone(DEFAULT_CONFIG), ...config,
        automod: { ...structuredClone(DEFAULT_CONFIG.automod), ...(isObject(config.automod) ? config.automod : {}) },
        security: { ...structuredClone(DEFAULT_CONFIG.security), ...(isObject(config.security) ? config.security : {}) }
      },
      warnings
    };
  }
  return state;
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backup = this.filePath + ".corrupt-" + Date.now();
        await fs.rename(this.filePath, backup).catch(() => {});
        console.error("Invalid database moved to " + backup + ": " + error.message);
      }
      this.state = emptyState();
      await this.persist();
    }
    return this;
  }

  getGuild(guildId) {
    if (!this.state.guilds[guildId]) {
      this.state.guilds[guildId] = { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
    }
    return this.state.guilds[guildId];
  }

  getConfig(guildId) {
    return structuredClone(this.getGuild(guildId).config);
  }

  async updateConfig(guildId, updater) {
    const guild = this.getGuild(guildId);
    const next = updater(structuredClone(guild.config));
    if (!isObject(next)) throw new TypeError("Invalid configuration update.");
    guild.config = next;
    await this.persist();
    return structuredClone(guild.config);
  }

  async addWarning({ guildId, targetId, moderatorId, reason }) {
    const record = { id: randomUUID(), targetId, moderatorId, reason, createdAt: new Date().toISOString() };
    this.getGuild(guildId).warnings.push(record);
    await this.persist();
    return { ...record };
  }

  getWarnings(guildId, targetId) {
    return this.getGuild(guildId).warnings
      .filter(w => w.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(w => ({ ...w }));
  }

  async removeWarning(guildId, targetId, warningId) {
    const records = this.getGuild(guildId).warnings;
    const index = records.findIndex(w => w.targetId === targetId && w.id === warningId);
    if (index < 0) return null;
    const removed = records.splice(index, 1)[0];
    await this.persist();
    return removed;
  }

  async clearWarnings(guildId, targetId) {
    const guild = this.getGuild(guildId);
    const before = guild.warnings.length;
    guild.warnings = guild.warnings.filter(w => w.targetId !== targetId);
    await this.persist();
    return before - guild.warnings.length;
  }

  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const tempPath = this.filePath + ".tmp";
      await fs.writeFile(tempPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    });
    return this.writeQueue;
  }
}
