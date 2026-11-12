import test from "node:test";
import assert from "node:assert/strict";
import {
  AuditLogEvent,
  PermissionFlagsBits
} from "discord.js";
import {
  handleAutomodMessage,
  handleRaidJoin,
  handleAuditLogEntry,
  resetSecurityMemoryForTests
} from "../src/security.js";

const guildId = "12345678901234567";
function makeStore(overrides = {}) {
  const config = {
    modLogChannelId: null,
    automod: {
      enabled: true, action: "delete", maxMessages: 20, intervalMs: 7000,
      duplicateLimit: 2, massMentionLimit: 3, blockedPhrases: [],
      ignoredChannelIds: [], ignoredRoleIds: []
    },
    security: {
      raidProtectionEnabled: false, raidJoinLimit: 3, raidWindowMs: 15000,
      alertCooldownMs: 60000, accountAgeAlertsEnabled: false,
      minimumAccountAgeDays: 7
    },
    ...overrides
  };
  return { getConfig: () => structuredClone(config) };
}
function makeMessage({content="hello", authorId="22345678901234567", bot=false, roles=[], everyone=false, users=0, roleMentions=0, channelId="32345678901234567"}={}) {
  let deleted = false;
  const message = {
    guild: { id: guildId }, guildId, channelId,
    author: { id: authorId, bot }, webhookId: null, content,
    member: { roles: { cache: { some: fn => roles.some(fn) } } },
    mentions: { everyone, users: { size: users }, roles: { size: roleMentions } },
    client: { user: { id: "42345678901234567" } },
    delete: async () => { deleted = true; },
    wasDeleted: () => deleted
  };
  return message;
}

test("automod detects repeated messages and deletes when configured", async () => {
  resetSecurityMemoryForTests();
  const store = makeStore();
  await handleAutomodMessage(makeMessage(), store);
  const repeated = makeMessage();
  await handleAutomodMessage(repeated, store);
  assert.equal(repeated.wasDeleted(), true);
});

test("automod alerts without deleting when alert mode is selected", async () => {
  resetSecurityMemoryForTests();
  const store = makeStore({ automod: { ...makeStore().getConfig(guildId).automod, action: "alert" } });
  const first = makeMessage();
  const second = makeMessage();
  await handleAutomodMessage(first, store);
  await handleAutomodMessage(second, store);
  assert.equal(second.wasDeleted(), false);
});

test("automod blocks Discord invite links only when enabled", async () => {
  resetSecurityMemoryForTests();
  const base = makeStore();
  const config = base.getConfig(guildId);
  config.automod.blockInvites = true;
  const message = makeMessage({ content: "join us at discord.gg/example" });
  await handleAutomodMessage(message, { getConfig: () => config });
  assert.equal(message.wasDeleted(), true);
});

test("automod ignores bots and configured channels and roles", async () => {
  resetSecurityMemoryForTests();
  const store = makeStore({ automod: {
    ...makeStore().getConfig(guildId).automod,
    ignoredChannelIds: ["32345678901234567"],
    ignoredRoleIds: ["52345678901234567"]
  } });
  const channelIgnored = makeMessage();
  await handleAutomodMessage(channelIgnored, store);
  assert.equal(channelIgnored.wasDeleted(), false);
  const botMessage = makeMessage({ bot: true, authorId: "62345678901234567" });
  await handleAutomodMessage(botMessage, store);
  assert.equal(botMessage.wasDeleted(), false);
});

test("automod catches @everyone and configured blocked phrases", async () => {
  resetSecurityMemoryForTests();
  const store = makeStore();
  const everyone = makeMessage({ everyone: true });
  await handleAutomodMessage(everyone, store);
  assert.equal(everyone.wasDeleted(), true);

  resetSecurityMemoryForTests();
  const config = store.getConfig(guildId);
  config.automod.blockedPhrases = ["blocked phrase"];
  const phraseStore = { getConfig: () => config };
  const blocked = makeMessage({ content: "this contains a blocked phrase" });
  await handleAutomodMessage(blocked, phraseStore);
  assert.equal(blocked.wasDeleted(), true);
});

test("raid and account-age checks are opt-in and alert without punishment", async () => {
  resetSecurityMemoryForTests();
  const disabledStore = makeStore();
  const member = {
    id: "22345678901234567",
    user: { createdTimestamp: Date.now() - 1000 },
    guild: { id: guildId },
    client: { user: { id: "42345678901234567" } }
  };
  const original = console.log;
  let logs = 0;
  console.log = (...args) => { if (args[0] === "[MODERATION]") logs++; };
  try {
    await handleRaidJoin(member, disabledStore);
    assert.equal(logs, 0);
    const config = disabledStore.getConfig(guildId);
    config.security.accountAgeAlertsEnabled = true;
    const ageStore = { getConfig: () => config };
    await handleRaidJoin(member, ageStore);
    assert.equal(logs, 1);
    config.security.raidProtectionEnabled = true;
    config.security.raidJoinLimit = 2;
    await handleRaidJoin(member, ageStore);
    await handleRaidJoin(member, ageStore);
    assert.equal(logs, 4);
  } finally {
    console.log = original;
  }
});

test("audit-log detector only flags kick/ban actors missing the matching permission", async () => {
  const store = makeStore();
  const actor = { permissions: { has: permission =>
    permission === PermissionFlagsBits.Administrator ? false : false
  } };
  const guild = { members: { fetch: async () => actor } };
  const entry = {
    executorId: "22345678901234567",
    targetId: "32345678901234567",
    action: AuditLogEvent.MemberKick,
    reason: "test"
  };
  const original = console.log;
  let logged = false;
  console.log = (...args) => { if (args[0] === "[MODERATION]") logged = true; };
  try {
    await handleAuditLogEntry(entry, guild, store, { user: { id: "42345678901234567" } });
  } finally {
    console.log = original;
  }
  assert.equal(logged, true);
});
