
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DATA_VERSION = 3;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MARRIAGE_PROPOSAL_STATUSES = new Set([
  "pending", "accepted", "declined", "expired", "cancelled",
]);
const ANIME_REPLY_STATUSES = new Set(["pending", "used", "expired", "cancelled"]);
const DIVORCE_CONFIRMATION_STATUSES = new Set([
  "pending", "confirmed", "cancelled", "expired", "superseded", "stale",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

function makeDefaultConfig() {
  return {
    welcomeChannelId: null,
    modLogChannelId: null,
    autoRoleId: null,
    selfAssignableRoleIds: [],
    countingChannelId: null,
    currentCount: 0,
    highestCount: 0,
    lastCounterId: null,

    autoModEnabled: false,
    autoModMessageLimit: 6,
    autoModDuplicateLimit: 3,
    autoModMentionLimit: 6,
    autoModAction: "warn",
    autoModTimeoutMs: 60000,

    raidProtectionEnabled: false,
    raidJoinLimit: 8,
    raidJoinWindowMs: 10000,
  };
}

function normalizeConfig(raw) {
  const config = makeDefaultConfig();
  if (!isRecord(raw)) return config;

  for (const field of ["welcomeChannelId", "modLogChannelId", "autoRoleId"]) {
    config[field] = isSnowflake(raw[field]) ? raw[field] : null;
  }

  if (Array.isArray(raw.selfAssignableRoleIds)) {
    config.selfAssignableRoleIds = [
      ...new Set(raw.selfAssignableRoleIds.filter(isSnowflake)),
    ];
  }

  config.countingChannelId = isSnowflake(raw.countingChannelId)
    ? raw.countingChannelId
    : null;
  config.currentCount =
    Number.isSafeInteger(raw.currentCount) && raw.currentCount >= 0
      ? raw.currentCount
      : 0;
  config.highestCount =
    Number.isSafeInteger(raw.highestCount) && raw.highestCount >= 0
      ? Math.max(raw.highestCount, config.currentCount)
      : config.currentCount;
  config.lastCounterId = isSnowflake(raw.lastCounterId) ? raw.lastCounterId : null;

  config.autoModEnabled = raw.autoModEnabled === true;
  config.autoModMessageLimit =
    Number.isInteger(raw.autoModMessageLimit) &&
    raw.autoModMessageLimit >= 3 &&
    raw.autoModMessageLimit <= 30
      ? raw.autoModMessageLimit
      : 6;
  config.autoModDuplicateLimit =
    Number.isInteger(raw.autoModDuplicateLimit) &&
    raw.autoModDuplicateLimit >= 2 &&
    raw.autoModDuplicateLimit <= 10
      ? raw.autoModDuplicateLimit
      : 3;
  config.autoModMentionLimit =
    Number.isInteger(raw.autoModMentionLimit) &&
    raw.autoModMentionLimit >= 3 &&
    raw.autoModMentionLimit <= 30
      ? raw.autoModMentionLimit
      : 6;
  config.autoModAction = ["warn", "timeout"].includes(raw.autoModAction)
    ? raw.autoModAction
    : "warn";
  config.autoModTimeoutMs =
    Number.isInteger(raw.autoModTimeoutMs) &&
    raw.autoModTimeoutMs >= 10000 &&
    raw.autoModTimeoutMs <= 600000
      ? raw.autoModTimeoutMs
      : 60000;

  config.raidProtectionEnabled = raw.raidProtectionEnabled === true;
  config.raidJoinLimit =
    Number.isInteger(raw.raidJoinLimit) &&
    raw.raidJoinLimit >= 3 &&
    raw.raidJoinLimit <= 30
      ? raw.raidJoinLimit
      : 8;
  config.raidJoinWindowMs =
    Number.isInteger(raw.raidJoinWindowMs) &&
    raw.raidJoinWindowMs >= 5000 &&
    raw.raidJoinWindowMs <= 60000
      ? raw.raidJoinWindowMs
      : 10000;

  return config;
}

function normalizeWarnings(raw) {
  if (!isRecord(raw)) return {};

  const warnings = {};
  for (const [key, entries] of Object.entries(raw)) {
    const ids = key.split(":");
    if (ids.length !== 2 || !ids.every(isSnowflake) || !Array.isArray(entries)) {
      continue;
    }

    warnings[key] = entries.filter(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.reason === "string" &&
        isSnowflake(entry.moderatorId) &&
        typeof entry.createdAt === "string" &&
        Number.isFinite(Date.parse(entry.createdAt)),
    );
  }

  return warnings;
}

function isValidTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeMarriages(raw) {
  if (!Array.isArray(raw)) return [];

  const marriages = [];
  const partneredMembers = new Set();
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !isSnowflake(entry.guildId) ||
      !isSnowflake(entry.memberA) ||
      !isSnowflake(entry.memberB) ||
      entry.memberA === entry.memberB ||
      !isValidTimestamp(entry.marriedAt)
    ) {
      continue;
    }

    const [memberA, memberB] = [entry.memberA, entry.memberB].sort();
    const memberAKey = `${entry.guildId}:${memberA}`;
    const memberBKey = `${entry.guildId}:${memberB}`;
    if (partneredMembers.has(memberAKey) || partneredMembers.has(memberBKey)) {
      continue;
    }

    partneredMembers.add(memberAKey);
    partneredMembers.add(memberBKey);
    marriages.push({ guildId: entry.guildId, memberA, memberB, marriedAt: entry.marriedAt });
  }

  return marriages;
}

function normalizeMarriageProposals(raw) {
  if (!Array.isArray(raw)) return [];

  const proposals = [];
  const ids = new Set();
  const pendingMembers = new Set();
  const now = Date.now();

  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length > 100 ||
      ids.has(entry.id) ||
      !isSnowflake(entry.guildId) ||
      !isSnowflake(entry.proposerId) ||
      !isSnowflake(entry.recipientId) ||
      entry.proposerId === entry.recipientId ||
      !isValidTimestamp(entry.createdAt) ||
      !isValidTimestamp(entry.expiresAt) ||
      !MARRIAGE_PROPOSAL_STATUSES.has(entry.status)
    ) {
      continue;
    }

    let status = entry.status;
    if (status === "pending" && Date.parse(entry.expiresAt) <= now) {
      status = "expired";
    }

    const proposerKey = `${entry.guildId}:${entry.proposerId}`;
    const recipientKey = `${entry.guildId}:${entry.recipientId}`;
    if (
      status === "pending" &&
      (pendingMembers.has(proposerKey) || pendingMembers.has(recipientKey))
    ) {
      status = "cancelled";
    }
    if (status === "pending") {
      pendingMembers.add(proposerKey);
      pendingMembers.add(recipientKey);
    }

    ids.add(entry.id);
    proposals.push({
      id: entry.id,
      guildId: entry.guildId,
      proposerId: entry.proposerId,
      recipientId: entry.recipientId,
      channelId: isSnowflake(entry.channelId) ? entry.channelId : null,
      messageId: isSnowflake(entry.messageId) ? entry.messageId : null,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      status,
    });
  }

  return proposals;
}

function normalizeAnimeReplies(raw) {
  if (!Array.isArray(raw)) return [];

  const replies = [];
  const ids = new Set();
  const now = Date.now();

  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length > 100 ||
      ids.has(entry.id) ||
      !isSnowflake(entry.guildId) ||
      !isSnowflake(entry.channelId) ||
      !isSnowflake(entry.actorId) ||
      !isSnowflake(entry.targetId) ||
      entry.actorId === entry.targetId ||
      typeof entry.action !== "string" ||
      !/^[a-z]{2,20}$/.test(entry.action) ||
      !isValidTimestamp(entry.expiresAt) ||
      !ANIME_REPLY_STATUSES.has(entry.status)
    ) {
      continue;
    }

    let status = entry.status;
    if (status === "pending" && Date.parse(entry.expiresAt) <= now) {
      status = "expired";
    }

    ids.add(entry.id);
    replies.push({
      id: entry.id,
      guildId: entry.guildId,
      channelId: entry.channelId,
      messageId: isSnowflake(entry.messageId) ? entry.messageId : null,
      action: entry.action,
      actorId: entry.actorId,
      targetId: entry.targetId,
      createdAt: isValidTimestamp(entry.createdAt)
        ? entry.createdAt
        : new Date().toISOString(),
      expiresAt: entry.expiresAt,
      status,
      usedAt: isValidTimestamp(entry.usedAt) ? entry.usedAt : null,
    });
  }

  return replies;
}

function normalizeInteractionCounts(raw) {
  if (!isRecord(raw)) return {};

  const counts = {};
  for (const [guildId, byGuild] of Object.entries(raw)) {
    if (!isSnowflake(guildId) || !isRecord(byGuild)) continue;
    const guildCounts = {};

    for (const [pairKey, byPair] of Object.entries(byGuild)) {
      if (!isRecord(byPair)) continue;
      const [actorId, targetId] = pairKey.split(":");
      if (!actorId || !targetId || !isSnowflake(actorId) || !isSnowflake(targetId)) {
        continue;
      }

      const pairCounts = {};
      for (const [action, value] of Object.entries(byPair)) {
        if (
          typeof action === "string" &&
          /^[a-z]{2,20}$/.test(action) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0
        ) {
          pairCounts[action] = Math.floor(value);
        }
      }

      if (Object.keys(pairCounts).length > 0) {
        guildCounts[pairKey] = pairCounts;
      }
    }

    if (Object.keys(guildCounts).length > 0) {
      counts[guildId] = guildCounts;
    }
  }

  return counts;
}

function normalizeDivorceConfirmations(raw) {
  if (!Array.isArray(raw)) return [];

  const confirmations = [];
  const ids = new Set();
  const now = Date.now();

  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length > 100 ||
      ids.has(entry.id) ||
      !isSnowflake(entry.guildId) ||
      !isSnowflake(entry.userId) ||
      !isSnowflake(entry.spouseId) ||
      entry.userId === entry.spouseId ||
      !isSnowflake(entry.channelId) ||
      !isValidTimestamp(entry.createdAt) ||
      !isValidTimestamp(entry.expiresAt) ||
      !DIVORCE_CONFIRMATION_STATUSES.has(entry.status)
    ) {
      continue;
    }

    let status = entry.status;
    if (status === "pending" && Date.parse(entry.expiresAt) <= now) {
      status = "expired";
    }

    ids.add(entry.id);
    confirmations.push({
      id: entry.id,
      guildId: entry.guildId,
      userId: entry.userId,
      spouseId: entry.spouseId,
      channelId: entry.channelId,
      messageId: isSnowflake(entry.messageId) ? entry.messageId : null,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      status,
    });
  }

  return confirmations;
}

export function normalizeStoreData(raw) {
  if (!isRecord(raw) || ![1, 2, DATA_VERSION].includes(raw.version)) {
    throw new Error("The Sukuna data file has an unsupported or invalid format.");
  }

  const guilds = {};
  if (isRecord(raw.guilds)) {
    for (const [guildId, config] of Object.entries(raw.guilds)) {
      if (isSnowflake(guildId)) guilds[guildId] = normalizeConfig(config);
    }
  }

  return {
    version: DATA_VERSION,
    guilds,
    warnings: normalizeWarnings(raw.warnings),
    marriages: normalizeMarriages(raw.marriages),
    marriageProposals: normalizeMarriageProposals(raw.marriageProposals),
    animeReplies: normalizeAnimeReplies(raw.animeReplies),
    divorceConfirmations: normalizeDivorceConfirmations(raw.divorceConfirmations),
    interactionCounts: normalizeInteractionCounts(raw.interactionCounts),
    community: isRecord(raw.community) ? raw.community : { afk: {}, reactionPanels: {}, voice: {}, tickets: {} },
  };
}

function copyRecord(record) {
  return record ? { ...record } : null;
}

function makeMarriage(guildId, firstId, secondId, marriedAt) {
  const [memberA, memberB] = [firstId, secondId].sort();
  return { guildId, memberA, memberB, marriedAt };
}

export function warningKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.data = {
      version: DATA_VERSION,
      guilds: {},
      warnings: {},
      marriages: [],
      marriageProposals: [],
      animeReplies: [],
      divorceConfirmations: [],
      interactionCounts: {},
      community: { afk: {}, reactionPanels: {}, voice: {}, tickets: {} },
    };
    this.saveQueue = Promise.resolve();
  }

  static fromEnvironment() {
    const directory = resolve(process.env.BOT_DATA_DIR || join(process.cwd(), "data"));
    return new JsonStore(join(directory, "sukuna-data.json"));
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const text = await readFile(this.filePath, "utf8");
      this.data = normalizeStoreData(JSON.parse(text));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.data = {
          version: DATA_VERSION,
          guilds: {},
          warnings: {},
          marriages: [],
          marriageProposals: [],
          animeReplies: [],
          divorceConfirmations: [],
          interactionCounts: {},
          community: { afk: {}, reactionPanels: {}, voice: {}, tickets: {} },
        };
        return this;
      }

      if (error instanceof SyntaxError) {
        throw new Error(
          `Sukuna's data file is not valid JSON. It was left untouched at ${this.filePath}.`,
        );
      }

      throw error;
    }

    return this;
  }

  getGuildConfig(guildId) {
    if (!isSnowflake(guildId)) throw new Error("Invalid server ID.");
    this.data.guilds[guildId] ??= makeDefaultConfig();
    return this.data.guilds[guildId];
  }

  async setGuildConfig(guildId, patch) {
    if (!isSnowflake(guildId) || !isRecord(patch)) {
      throw new Error("Invalid server settings.");
    }

    const allowedFields = new Set([
      "welcomeChannelId",
      "modLogChannelId",
      "autoRoleId",
      "selfAssignableRoleIds",
      "countingChannelId",
      "autoModEnabled",
      "autoModMessageLimit",
      "autoModDuplicateLimit",
      "autoModMentionLimit",
      "autoModAction",
      "autoModTimeoutMs",
      "raidProtectionEnabled",
      "raidJoinLimit",
      "raidJoinWindowMs",
    ]);

    const config = this.getGuildConfig(guildId);

    for (const [field, value] of Object.entries(patch)) {
      if (!allowedFields.has(field)) {
        throw new Error("Unknown server setting.");
      }

      if (field === "selfAssignableRoleIds") {
        if (!Array.isArray(value) || !value.every(isSnowflake)) {
          throw new Error("Invalid self-assignable role list.");
        }
        config[field] = [...new Set(value)];
        continue;
      }

      if (
        field === "welcomeChannelId" ||
        field === "modLogChannelId" ||
        field === "autoRoleId" ||
        field === "countingChannelId"
      ) {
        if (value !== null && !isSnowflake(value)) {
          throw new Error(`Invalid value for ${field}.`);
        }
        config[field] = value;
        continue;
      }

      if (field === "autoModAction") {
        if (!["warn", "timeout"].includes(value)) {
          throw new Error("Invalid automatic moderation action.");
        }
        config[field] = value;
        continue;
      }

      if (field === "autoModEnabled" || field === "raidProtectionEnabled") {
        if (typeof value !== "boolean") {
          throw new Error(`Invalid value for ${field}.`);
        }
        config[field] = value;
        continue;
      }

      const limits = {
        autoModMessageLimit: [3, 30],
        autoModDuplicateLimit: [2, 10],
        autoModMentionLimit: [3, 30],
        autoModTimeoutMs: [10000, 600000],
        raidJoinLimit: [3, 30],
        raidJoinWindowMs: [5000, 60000],
      };

      const range = limits[field];
      if (
        !range ||
        !Number.isInteger(value) ||
        value < range[0] ||
        value > range[1]
      ) {
        throw new Error(`Invalid value for ${field}.`);
      }

      config[field] = value;
    }

    await this.save();
    return config;
  }

  async tryIncrementCounting(guildId, count, userId) {
    if (
      !isSnowflake(guildId) ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !isSnowflake(userId)
    ) {
      throw new Error("Invalid counting game entry.");
    }

    const config = this.getGuildConfig(guildId);
    if (count !== config.currentCount + 1 || userId === config.lastCounterId) {
      return false;
    }

    const previousState = {
      currentCount: config.currentCount,
      highestCount: config.highestCount,
      lastCounterId: config.lastCounterId,
    };

    config.currentCount = count;
    config.highestCount = Math.max(config.highestCount, count);
    config.lastCounterId = userId;

    try {
      await this.save();
    } catch (error) {
      Object.assign(config, previousState);
      throw error;
    }

    return true;
  }

  getWarnings(guildId, userId) {
    return [...(this.data.warnings[warningKey(guildId, userId)] ?? [])];
  }

  async addWarning(guildId, userId, moderatorId, reason) {
    if (![guildId, userId, moderatorId].every(isSnowflake)) {
      throw new Error("Invalid warning record.");
    }

    const key = warningKey(guildId, userId);
    const entry = {
      id: randomUUID(),
      reason: String(reason).slice(0, 500),
      moderatorId,
      createdAt: new Date().toISOString(),
    };

    this.data.warnings[key] ??= [];
    this.data.warnings[key].push(entry);
    await this.save();
    return entry;
  }

  async clearWarnings(guildId, userId) {
    const key = warningKey(guildId, userId);
    const previousCount = this.data.warnings[key]?.length ?? 0;
    delete this.data.warnings[key];
    await this.save();
    return previousCount;
  }

  getMarriage(guildId, userId) {
    const marriage = this.data.marriages.find(
      (entry) =>
        entry.guildId === guildId &&
        (entry.memberA === userId || entry.memberB === userId),
    );

    if (!marriage) return null;
    return {
      ...marriage,
      spouseId: marriage.memberA === userId ? marriage.memberB : marriage.memberA,
    };
  }

  getMarriageBetween(guildId, firstId, secondId) {
    return (
      this.data.marriages.find(
        (entry) =>
          entry.guildId === guildId &&
          ((entry.memberA === firstId && entry.memberB === secondId) ||
            (entry.memberA === secondId && entry.memberB === firstId)),
      ) ?? null
    );
  }

  getMarriageProposal(id) {
    return copyRecord(this.data.marriageProposals.find((entry) => entry.id === id));
  }

  async expireMarriageProposals(guildId = null, now = Date.now()) {
    let changed = false;

    for (const proposal of this.data.marriageProposals) {
      if (
        proposal.status === "pending" &&
        (!guildId || proposal.guildId === guildId) &&
        Date.parse(proposal.expiresAt) <= now
      ) {
        proposal.status = "expired";
        changed = true;
      }
    }

    if (changed) await this.save();
    return changed;
  }

  async getPendingMarriageProposals(guildId, userId, now = Date.now()) {
    await this.expireMarriageProposals(guildId, now);

    return this.data.marriageProposals
      .filter(
        (entry) =>
          entry.guildId === guildId &&
          entry.status === "pending" &&
          Date.parse(entry.expiresAt) > now &&
          (entry.proposerId === userId || entry.recipientId === userId),
      )
      .map(copyRecord);
  }

  async createMarriageProposal({
    guildId,
    proposerId,
    recipientId,
    channelId,
    expiresAt,
    now = Date.now(),
  }) {
    if (
      ![guildId, proposerId, recipientId, channelId].every(isSnowflake) ||
      proposerId === recipientId ||
      !isValidTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= now
    ) {
      return { ok: false, reason: "invalid" };
    }

    await this.expireMarriageProposals(guildId, now);

    if (this.getMarriage(guildId, proposerId) || this.getMarriage(guildId, recipientId)) {
      return { ok: false, reason: "already-married" };
    }

    const conflict = this.data.marriageProposals.some(
      (entry) =>
        entry.guildId === guildId &&
        entry.status === "pending" &&
        Date.parse(entry.expiresAt) > now &&
        [entry.proposerId, entry.recipientId].some((id) =>
          [proposerId, recipientId].includes(id),
        ),
    );

    if (conflict) return { ok: false, reason: "pending-conflict" };

    const proposal = {
      id: randomUUID(),
      guildId,
      proposerId,
      recipientId,
      channelId,
      messageId: null,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      status: "pending",
    };

    this.data.marriageProposals.push(proposal);
    await this.save();
    return { ok: true, proposal: copyRecord(proposal) };
  }

  async setMarriageProposalMessage(id, channelId, messageId) {
    const proposal = this.data.marriageProposals.find((entry) => entry.id === id);
    if (!proposal || !isSnowflake(channelId) || !isSnowflake(messageId)) return false;

    proposal.channelId = channelId;
    proposal.messageId = messageId;
    await this.save();
    return true;
  }

  async cancelMarriageProposal(id) {
    const proposal = this.data.marriageProposals.find((entry) => entry.id === id);
    if (!proposal || proposal.status !== "pending") return false;

    proposal.status = "cancelled";
    await this.save();
    return true;
  }

  async respondToMarriageProposal(id, userId, decision, now = Date.now()) {
    const proposal = this.data.marriageProposals.find((entry) => entry.id === id);
    if (!proposal) return { ok: false, reason: "not-found" };
    if (proposal.recipientId !== userId) return { ok: false, reason: "unauthorized" };
    if (proposal.status !== "pending") return { ok: false, reason: "resolved" };
    if (!["accept", "decline"].includes(decision)) {
      return { ok: false, reason: "invalid" };
    }

    if (Date.parse(proposal.expiresAt) <= now) {
      proposal.status = "expired";
      await this.save();
      return { ok: false, reason: "expired" };
    }

    if (decision === "decline") {
      proposal.status = "declined";
      await this.save();
      return { ok: true, decision };
    }

    if (
      this.getMarriage(proposal.guildId, proposal.proposerId) ||
      this.getMarriage(proposal.guildId, proposal.recipientId)
    ) {
      proposal.status = "cancelled";
      await this.save();
      return { ok: false, reason: "already-married" };
    }

    const marriage = makeMarriage(
      proposal.guildId,
      proposal.proposerId,
      proposal.recipientId,
      new Date(now).toISOString(),
    );

    this.data.marriages.push(marriage);
    proposal.status = "accepted";

    for (const other of this.data.marriageProposals) {
      if (
        other.id !== proposal.id &&
        other.guildId === proposal.guildId &&
        other.status === "pending" &&
        [other.proposerId, other.recipientId].some((id) =>
          [proposal.proposerId, proposal.recipientId].includes(id),
        )
      ) {
        other.status = "cancelled";
      }
    }

    await this.save();
    return { ok: true, decision, marriage: copyRecord(marriage) };
  }

  async createAnimeReply({
    guildId,
    channelId,
    action,
    actorId,
    targetId,
    expiresAt,
    now = Date.now(),
  }) {
    if (
      ![guildId, channelId, actorId, targetId].every(isSnowflake) ||
      actorId === targetId ||
      typeof action !== "string" ||
      !/^[a-z]{2,20}$/.test(action) ||
      !isValidTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= now
    ) {
      throw new Error("Invalid anime reply record.");
    }

    const reply = {
      id: randomUUID(),
      guildId,
      channelId,
      messageId: null,
      action,
      actorId,
      targetId,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      status: "pending",
      usedAt: null,
    };

    this.data.animeReplies.push(reply);
    await this.save();
    return copyRecord(reply);
  }

  getAnimeReply(id) {
    return copyRecord(this.data.animeReplies.find((entry) => entry.id === id));
  }

  async setAnimeReplyMessage(id, channelId, messageId) {
    const reply = this.data.animeReplies.find((entry) => entry.id === id);
    if (!reply || !isSnowflake(channelId) || !isSnowflake(messageId)) return false;

    reply.channelId = channelId;
    reply.messageId = messageId;
    await this.save();
    return true;
  }

  async removeAnimeReply(id) {
    const index = this.data.animeReplies.findIndex((entry) => entry.id === id);
    if (index === -1) return false;

    this.data.animeReplies.splice(index, 1);
    await this.save();
    return true;
  }

  async cancelInteractionsForMessage(channelId, messageId) {
    if (!isSnowflake(channelId) || !isSnowflake(messageId)) return 0;

    let changed = 0;

    for (const proposal of this.data.marriageProposals) {
      if (
        proposal.status === "pending" &&
        proposal.channelId === channelId &&
        proposal.messageId === messageId
      ) {
        proposal.status = "cancelled";
        changed += 1;
      }
    }

    for (const reply of this.data.animeReplies) {
      if (
        reply.status === "pending" &&
        reply.channelId === channelId &&
        reply.messageId === messageId
      ) {
        reply.status = "cancelled";
        changed += 1;
      }
    }

    for (const confirmation of this.data.divorceConfirmations) {
      if (
        confirmation.status === "pending" &&
        confirmation.channelId === channelId &&
        confirmation.messageId === messageId
      ) {
        confirmation.status = "cancelled";
        changed += 1;
      }
    }

    if (changed > 0) await this.save();
    return changed;
  }

  async consumeAnimeReply(
    id,
    userId,
    guildId,
    channelId,
    messageId,
    now = Date.now(),
  ) {
    const reply = this.data.animeReplies.find((entry) => entry.id === id);
    if (!reply) return { ok: false, reason: "not-found" };

    if (
      reply.guildId !== guildId ||
      reply.channelId !== channelId ||
      (reply.messageId && reply.messageId !== messageId)
    ) {
      return { ok: false, reason: "wrong-message" };
    }

    if (reply.targetId !== userId) return { ok: false, reason: "unauthorized" };
    if (reply.status !== "pending") return { ok: false, reason: "resolved" };

    if (Date.parse(reply.expiresAt) <= now) {
      reply.status = "expired";
      await this.save();
      return { ok: false, reason: "expired" };
    }

    reply.messageId ??= messageId;
    reply.status = "used";
    reply.usedAt = new Date(now).toISOString();
    await this.save();
    return { ok: true, reply: copyRecord(reply) };
  }

  async createDivorceConfirmation({
    guildId,
    userId,
    spouseId,
    channelId,
    expiresAt,
    now = Date.now(),
  }) {
    if (
      ![guildId, userId, spouseId, channelId].every(isSnowflake) ||
      userId === spouseId ||
      !isValidTimestamp(expiresAt) ||
      Date.parse(expiresAt) <= now
    ) {
      return { ok: false, reason: "invalid" };
    }

    const marriage = this.getMarriage(guildId, userId);
    if (!marriage || marriage.spouseId !== spouseId) {
      return { ok: false, reason: "not-married" };
    }

    for (const confirmation of this.data.divorceConfirmations) {
      if (
        confirmation.guildId === guildId &&
        confirmation.userId === userId &&
        confirmation.status === "pending"
      ) {
        confirmation.status = "superseded";
      }
    }

    const confirmation = {
      id: randomUUID(),
      guildId,
      userId,
      spouseId,
      channelId,
      messageId: null,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      status: "pending",
    };

    this.data.divorceConfirmations.push(confirmation);
    await this.save();
    return { ok: true, confirmation: copyRecord(confirmation) };
  }

  getDivorceConfirmation(id) {
    return copyRecord(this.data.divorceConfirmations.find((entry) => entry.id === id));
  }

  async setDivorceConfirmationMessage(id, channelId, messageId) {
    const confirmation = this.data.divorceConfirmations.find((entry) => entry.id === id);
    if (!confirmation || !isSnowflake(channelId) || !isSnowflake(messageId)) return false;

    confirmation.channelId = channelId;
    confirmation.messageId = messageId;
    await this.save();
    return true;
  }

  async resolveDivorceConfirmation(id, userId, decision, now = Date.now()) {
    const confirmation = this.data.divorceConfirmations.find((entry) => entry.id === id);
    if (!confirmation) return { ok: false, reason: "not-found" };
    if (confirmation.userId !== userId) return { ok: false, reason: "unauthorized" };
    if (confirmation.status !== "pending") return { ok: false, reason: "resolved" };
    if (!["confirm", "cancel"].includes(decision)) {
      return { ok: false, reason: "invalid" };
    }

    if (Date.parse(confirmation.expiresAt) <= now) {
      confirmation.status = "expired";
      await this.save();
      return { ok: false, reason: "expired" };
    }

    if (decision === "cancel") {
      confirmation.status = "cancelled";
      await this.save();
      return { ok: true, decision };
    }

    const marriageIndex = this.data.marriages.findIndex(
      (entry) =>
        entry.guildId === confirmation.guildId &&
        ((entry.memberA === confirmation.userId && entry.memberB === confirmation.spouseId) ||
          (entry.memberB === confirmation.userId && entry.memberA === confirmation.spouseId)),
    );

    if (marriageIndex === -1) {
      confirmation.status = "stale";
      await this.save();
      return { ok: false, reason: "stale" };
    }

    this.data.marriages.splice(marriageIndex, 1);
    confirmation.status = "confirmed";
    await this.save();
    return { ok: true, decision };
  }

  getInteractionCount(guildId, actorId, targetId, action) {
    if (![guildId, actorId, targetId].every(isSnowflake) || actorId === targetId) {
      throw new Error("Invalid interaction count lookup.");
    }
    if (typeof action !== "string" || !/^[a-z]{2,20}$/.test(action)) {
      throw new Error("Invalid interaction action.");
    }

    const pairKey = `${actorId}:${targetId}`;
    return this.data.interactionCounts[guildId]?.[pairKey]?.[action] ?? 0;
  }

  async incrementInteractionCount(guildId, actorId, targetId, action) {
    if (![guildId, actorId, targetId].every(isSnowflake) || actorId === targetId) {
      throw new Error("Invalid interaction count record.");
    }
    if (typeof action !== "string" || !/^[a-z]{2,20}$/.test(action)) {
      throw new Error("Invalid interaction action.");
    }

    const pairKey = `${actorId}:${targetId}`;
    this.data.interactionCounts[guildId] ??= {};
    this.data.interactionCounts[guildId][pairKey] ??= {};
    this.data.interactionCounts[guildId][pairKey][action] ??= 0;
    this.data.interactionCounts[guildId][pairKey][action] += 1;

    await this.save();
    return this.data.interactionCounts[guildId][pairKey][action];
  }

  async save() {
    const operation = this.saveQueue.then(
      () => this.writeAtomically(),
      () => this.writeAtomically(),
    );

    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  async writeAtomically() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(this.data, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

export function parseDuration(input) {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(input ?? "");
  if (!match) return null;

  const amount = Number(match[1]);
  const unitMilliseconds = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }[match[2].toLowerCase()];

  const milliseconds = amount * unitMilliseconds;

  if (
    !Number.isSafeInteger(amount) ||
    milliseconds < 1_000 ||
    milliseconds > 28 * 86_400_000
  ) {
    return null;
  }

  return milliseconds;
}
