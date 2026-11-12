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
      action: ["alert", "delete"].includes(automod.action) ? automod.action : DEFAULT_CONFIG.automod.action,
      blockInvites: automod.blockInvites === true,
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
      alertCooldownMs: Number.isInteger(security.alertCooldownMs) ? Math.min(600000, Math.max(10000, security.alertCooldownMs)) : DEFAULT_CONFIG.security.alertCooldownMs,
      accountAgeAlertsEnabled: security.accountAgeAlertsEnabled === true,
      minimumAccountAgeDays: Number.isInteger(security.minimumAccountAgeDays) ? Math.min(365, Math.max(1, security.minimumAccountAgeDays)) : DEFAULT_CONFIG.security.minimumAccountAgeDays
    }
  };
}

function normalizeState(value) {
  if (!isObject(value) || value.version !== 2 || !isObject(value.guilds)) {
    throw new Error("Database structure or version is invalid.");
  }
  const state = emptyState();
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    if (!snowflake(guildId) || !isObject(guild)) continue;
    const warnings = Array.isArray(guild.warnings) ? guild.warnings.filter(w =>
      isObject(w) && typeof w.id === "string" &&
      snowflake(w.targetId) && snowflake(w.moderatorId) &&
      typeof w.reason === "string" && typeof w.createdAt === "string" &&
      !Number.isNaN(Date.parse(w.createdAt))
    ).map(w => ({
      id: w.id.slice(0, 80), number: Number.isSafeInteger(w.number) && w.number > 0 ? w.number : 0,
      targetId: w.targetId, moderatorId: w.moderatorId,
      reason: w.reason.slice(0, 500), createdAt: w.createdAt
    })) : [];
    const byTarget = new Map();
    for (const warning of warnings) {
      if (!byTarget.has(warning.targetId)) byTarget.set(warning.targetId, []);
      byTarget.get(warning.targetId).push(warning);
    }
    for (const memberWarnings of byTarget.values()) {
      memberWarnings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let nextNumber = Math.max(0, ...memberWarnings.map(w => w.number));
      for (const warning of memberWarnings) if (warning.number === 0) warning.number = ++nextNumber;
    }
    const warningHistory = Array.isArray(guild.warningHistory) ? guild.warningHistory.filter(w =>
      isObject(w) && typeof w.id === "string" &&
      snowflake(w.targetId) && snowflake(w.moderatorId) &&
      typeof w.reason === "string" && typeof w.createdAt === "string" &&
      !Number.isNaN(Date.parse(w.createdAt))
    ).map(w => ({
      id: w.id.slice(0, 80), number: Number.isSafeInteger(w.number) && w.number > 0 ? w.number : 0,
      targetId: w.targetId, moderatorId: w.moderatorId,
      reason: w.reason.slice(0, 500), createdAt: w.createdAt,
      status: w.status === "removed" ? "removed" : "cleared"
    })) : [];
    const allByTarget = new Map();
    for (const warning of [...warnings, ...warningHistory]) {
      if (!allByTarget.has(warning.targetId)) allByTarget.set(warning.targetId, []);
      allByTarget.get(warning.targetId).push(warning);
    }
    for (const memberWarnings of allByTarget.values()) {
      memberWarnings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let nextNumber = Math.max(0, ...memberWarnings.map(w => w.number));
      for (const warning of memberWarnings) if (warning.number === 0) warning.number = ++nextNumber;
    }
    state.guilds[guildId] = { config: normalizeConfig(guild.config), warnings, warningHistory };
  }
  return state;
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let raw;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
      return this;
    }
    try {
      this.state = normalizeState(JSON.parse(raw));
    } catch (error) {
      const backup = this.filePath + ".corrupt-" + Date.now();
      await fs.rename(this.filePath, backup);
      console.error("Invalid database moved to " + backup + ": " + error.message);
      this.state = emptyState();
      await this.persist();
    }
    return this;
  }

  runMutation(operation) {
    const next = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = next;
    return next;
  }

  getGuild(guildId) {
    if (!this.state.guilds[guildId]) this.state.guilds[guildId] = { config: structuredClone(DEFAULT_CONFIG), warnings: [], warningHistory: [] };
    return this.state.guilds[guildId];
  }

  getConfig(guildId) { return structuredClone(this.getGuild(guildId).config); }

  async updateConfig(guildId, updater) {
    return this.runMutation(async () => {
      const guild = this.getGuild(guildId);
      const next = updater(structuredClone(guild.config));
      if (!isObject(next)) throw new TypeError("Invalid configuration update.");
      const previous = guild.config;
      guild.config = normalizeConfig(next);
      try { await this.persist(); }
      catch (error) { guild.config = previous; throw error; }
      return this.getConfig(guildId);
    });
  }

  async addWarning({ guildId, targetId, moderatorId, reason }) {
    return this.runMutation(async () => {
      if (!snowflake(guildId) || !snowflake(targetId) || !snowflake(moderatorId)) throw new TypeError("Invalid Discord ID.");
      const records = this.getGuild(guildId).warnings;
      const number = records.filter(w => w.targetId === targetId).reduce((max, w) => Math.max(max, w.number || 0), 0) + 1;
      const record = { id: randomUUID(), number, targetId, moderatorId, reason: String(reason || "No reason supplied").slice(0, 500), createdAt: new Date().toISOString() };
      records.push(record);
      try { await this.persist(); }
      catch (error) { records.splice(records.findIndex(item => item.id === record.id), 1); throw error; }
      return { ...record };
    });
  }

  getWarnings(guildId, targetId) {
    return this.getGuild(guildId).warnings.filter(w => w.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(w => ({ ...w }));
  }

  getWarningHistory(guildId, targetId) {
    const guild = this.getGuild(guildId);
    return [...guild.warningHistory, ...guild.warnings]
      .filter(w => w.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(w => ({ ...w, status: w.status || "active" }));
  }

  async removeWarning(guildId, targetId, warningNumber) {
    return this.runMutation(async () => {
      const guild = this.getGuild(guildId);
      const index = guild.warnings.findIndex(w => w.targetId === targetId && w.number === Number(warningNumber));
      if (index < 0) return null;
      const [removed] = guild.warnings.splice(index, 1);
      const archived = { ...removed, status: "removed" };
      guild.warningHistory.push(archived);
      try { await this.persist(); }
      catch (error) { guild.warningHistory.pop(); guild.warnings.splice(index, 0, removed); throw error; }
      return { ...archived };
    });
  }

  async clearWarnings(guildId, targetId) {
    return this.runMutation(async () => {
      const guild = this.getGuild(guildId);
      const removed = guild.warnings.filter(w => w.targetId === targetId);
      if (!removed.length) return 0;
      const previousHistoryLength = guild.warningHistory.length;
      guild.warnings = guild.warnings.filter(w => w.targetId !== targetId);
      guild.warningHistory.push(...removed.map(w => ({ ...w, status: "cleared" })));
      try { await this.persist(); }
      catch (error) {
        guild.warningHistory.splice(previousHistoryLength);
        guild.warnings.push(...removed);
        throw error;
      }
      return removed.length;
    });
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
