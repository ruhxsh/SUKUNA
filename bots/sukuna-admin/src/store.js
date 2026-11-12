import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "./config.js";

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const snowflake = value => typeof value === "string" && /^\d{17,20}$/.test(value);
const emptyState = () => ({ version: 2, guilds: {} });

function normalizeConfig(input) {
  const config = isObject(input) ? input : {};
  const automod = isObject(config.automod) ? config.automod : {};
  const security = isObject(config.security) ? config.security : {};
  const phrases = Array.isArray(automod.blockedPhrases)
    ? [...new Set(automod.blockedPhrases.filter(v => typeof v === "string").map(v => v.trim().slice(0, 100)).filter(Boolean))].slice(0, 100)
    : [];
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(snowflake))].slice(0, 100) : [];
  return {
    modLogChannelId: snowflake(config.modLogChannelId) ? config.modLogChannelId : null,
    automod: {
      enabled: automod.enabled === true,
      action: ["alert", "delete"].includes(automod.action) ? automod.action : "delete",
      maxMessages: Number.isInteger(automod.maxMessages) ? Math.min(30, Math.max(3, automod.maxMessages)) : DEFAULT_CONFIG.automod.maxMessages,
      intervalMs: Number.isInteger(automod.intervalMs) ? Math.min(60000, Math.max(3000, automod.intervalMs)) : DEFAULT_CONFIG.automod.intervalMs,
      duplicateLimit: Number.isInteger(automod.duplicateLimit) ? Math.min(10, Math.max(2, automod.duplicateLimit)) : DEFAULT_CONFIG.automod.duplicateLimit,
      massMentionLimit: Number.isInteger(automod.massMentionLimit) ? Math.min(50, Math.max(2, automod.massMentionLimit)) : DEFAULT_CONFIG.automod.massMentionLimit,
      blockedPhrases: phrases,
      ignoredChannelIds: ids(automod.ignoredChannelIds),
      ignoredRoleIds: ids(automod.ignoredRoleIds)
    },
    security: {
      raidProtectionEnabled: security.raidProtectionEnabled === true,
      raidJoinLimit: Number.isInteger(security.raidJoinLimit) ? Math.min(100, Math.max(3, security.raidJoinLimit)) : DEFAULT_CONFIG.security.raidJoinLimit,
      raidWindowMs: Number.isInteger(security.raidWindowMs) ? Math.min(300000, Math.max(5000, security.raidWindowMs)) : DEFAULT_CONFIG.security.raidWindowMs,
      raidAction: "alert",
      alertCooldownMs: Number.isInteger(security.alertCooldownMs) ? Math.min(600000, Math.max(10000, security.alertCooldownMs)) : DEFAULT_CONFIG.security.alertCooldownMs
    }
  };
}

function normalizeState(value) {
  if (!isObject(value) || !isObject(value.guilds)) return emptyState();
  const state = emptyState();
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    if (!snowflake(guildId) || !isObject(guild)) continue;
    const warnings = Array.isArray(guild.warnings) ? guild.warnings.filter(w =>
      isObject(w) && typeof w.id === "string" &&
      snowflake(w.targetId) && snowflake(w.moderatorId) &&
      typeof w.reason === "string" && typeof w.createdAt === "string" &&
      !Number.isNaN(Date.parse(w.createdAt))
    ).map(w => ({ id: w.id, targetId: w.targetId, moderatorId: w.moderatorId, reason: w.reason.slice(0, 500), createdAt: w.createdAt })) : [];
    state.guilds[guildId] = { config: normalizeConfig(guild.config), warnings };
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
    if (!this.state.guilds[guildId]) this.state.guilds[guildId] = { config: structuredClone(DEFAULT_CONFIG), warnings: [] };
    return this.state.guilds[guildId];
  }

  getConfig(guildId) { return structuredClone(this.getGuild(guildId).config); }

  async updateConfig(guildId, updater) {
    const guild = this.getGuild(guildId);
    const next = updater(structuredClone(guild.config));
    if (!isObject(next)) throw new TypeError("Invalid configuration update.");
    guild.config = normalizeConfig(next);
    await this.persist();
    return this.getConfig(guildId);
  }

  async addWarning({ guildId, targetId, moderatorId, reason }) {
    if (!snowflake(guildId) || !snowflake(targetId) || !snowflake(moderatorId)) throw new TypeError("Invalid Discord ID.");
    const record = { id: randomUUID(), targetId, moderatorId, reason: String(reason || "No reason supplied").slice(0, 500), createdAt: new Date().toISOString() };
    this.getGuild(guildId).warnings.push(record);
    await this.persist();
    return { ...record };
  }

  getWarnings(guildId, targetId) {
    return this.getGuild(guildId).warnings.filter(w => w.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(w => ({ ...w }));
  }

  async removeWarning(guildId, targetId, warningId) {
    const records = this.getGuild(guildId).warnings;
    const index = records.findIndex(w => w.targetId === targetId && w.id === warningId);
    if (index < 0) return null;
    const [removed] = records.splice(index, 1);
    await this.persist();
    return { ...removed };
  }

  async clearWarnings(guildId, targetId) {
    const guild = this.getGuild(guildId);
    const before = guild.warnings.length;
    guild.warnings = guild.warnings.filter(w => w.targetId !== targetId);
    await this.persist();
    return before - guild.warnings.length;
  }

  async persist() {
    const write = this.writeQueue.catch(() => {}).then(async () => {
      const snapshot = JSON.stringify(this.state, null, 2);
      const tempPath = this.filePath + "." + randomUUID() + ".tmp";
      let handle;
      try {
        handle = await fs.open(tempPath, "wx", 0o600);
        await handle.writeFile(snapshot, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tempPath, this.filePath);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.writeQueue = write;
    return write;
  }
}
