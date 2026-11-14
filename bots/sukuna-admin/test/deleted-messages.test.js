import test from "node:test";
import assert from "node:assert/strict";
import {
  cacheMessage,
  handleDeletedMessage,
  handleBulkDeletedMessages,
  resetDeletedMessageCacheForTests
} from "../src/deleted-messages.js";

const ids = {
  guild: "12345678901234567",
  channel: "22345678901234567",
  logChannel: "32345678901234567",
  author: "42345678901234567",
  moderator: "52345678901234567"
};

function makeEnvironment({ auditEntries = [] } = {}) {
  const sent = [];
  const logChannel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push(payload); }
  };
  const moderator = { displayName: "Moderator" };
  const guild = {
    id: ids.guild,
    members: {
      me: { permissions: { has: () => true } },
      fetch: async id => id === ids.moderator ? moderator : null
    },
    channels: { fetch: async id => id === ids.logChannel ? logChannel : null },
    fetchAuditLogs: async () => ({ entries: new Map(auditEntries.map((entry, i) => [String(i), entry])) }),
    client: { users: { fetch: async () => null } }
  };
  const store = { getConfig: () => ({ deletedMessageLogChannelId: ids.logChannel }) };
  return { sent, guild, store };
}

function makeMessage(guild, { partial = false, content = "The exact deleted text", authorId = ids.author } = {}) {
  return {
    id: "62345678901234567",
    guildId: ids.guild,
    guild,
    channelId: ids.channel,
    channel: { id: ids.channel },
    partial,
    author: partial ? null : { id: authorId, username: "OriginalAuthor", bot: false },
    member: { displayName: "Original Author" },
    content: partial ? "" : content,
    attachments: new Map(),
    createdAt: new Date("2026-11-13T12:00:00.000Z"),
    client: { guilds: { cache: new Map([[ids.guild, guild]]) } }
  };
}

test("deleted message log preserves cached content and identifies a unique moderator audit entry", async () => {
  resetDeletedMessageCacheForTests();
  const auditEntry = {
    targetId: ids.author,
    executorId: ids.moderator,
    createdTimestamp: Date.now(),
    extra: { channel: { id: ids.channel }, count: 1 }
  };
  const env = makeEnvironment({ auditEntries: [auditEntry] });
  const original = makeMessage(env.guild);
  cacheMessage(original, env.store);
  const deleted = makeMessage(env.guild, { partial: true });
  await handleDeletedMessage(deleted, env.store, { waitMs: 0 });
  assert.equal(env.sent.length, 1);
  const embed = env.sent[0].embeds[0].data;
  assert.equal(embed.title, "Message Deleted");
  assert.match(embed.description, /The exact deleted text/);
  assert.match(embed.fields.find(field => field.name === "Author").value, /Original Author/);
  assert.match(embed.fields.find(field => field.name === "Deleted by").value, /Moderator/);
  assert.match(embed.fields.find(field => field.name === "Channel").value, new RegExp(ids.channel));
  assert.deepEqual(env.sent[0].allowedMentions, { parse: [] });
});

test("ambiguous audit entries are not guessed", async () => {
  resetDeletedMessageCacheForTests();
  const entry = {
    targetId: ids.author,
    executorId: ids.moderator,
    createdTimestamp: Date.now(),
    extra: { channel: { id: ids.channel }, count: 1 }
  };
  const env = makeEnvironment({ auditEntries: [entry, { ...entry, executorId: ids.author }] });
  const original = makeMessage(env.guild);
  cacheMessage(original, env.store);
  await handleDeletedMessage(makeMessage(env.guild, { partial: true }), env.store, { waitMs: 0 });
  const deleter = env.sent[0].embeds[0].data.fields.find(field => field.name === "Deleted by").value;
  assert.match(deleter, /unambiguous/);
});

test("uncached partial messages are clearly marked instead of inventing content", async () => {
  resetDeletedMessageCacheForTests();
  const env = makeEnvironment();
  await handleDeletedMessage(makeMessage(env.guild, { partial: true }), env.store, { waitMs: 0 });
  const content = env.sent[0].embeds[0].data.description;
  assert.match(content, /not cached by SUKUNA/);
});

test("bulk deletion uses the matching bulk audit count for actor attribution", async () => {
  resetDeletedMessageCacheForTests();
  const entry = {
    targetId: ids.author,
    executorId: ids.moderator,
    createdTimestamp: Date.now(),
    extra: { channel: { id: ids.channel }, count: 2 }
  };
  const env = makeEnvironment({ auditEntries: [entry] });
  const first = makeMessage(env.guild);
  const second = { ...makeMessage(env.guild), id: "72345678901234567", content: "Second removed message" };
  cacheMessage(first, env.store);
  cacheMessage(second, env.store);
  await handleBulkDeletedMessages(new Map([[first.id, makeMessage(env.guild, { partial: true })], [second.id, { ...makeMessage(env.guild, { partial: true }), id: second.id }]]), env.store);
  assert.equal(env.sent.length, 2);
  for (const payload of env.sent) {
    assert.match(payload.embeds[0].data.fields.find(field => field.name === "Deleted by").value, /Moderator/);
  }
});

test("deleted-message logging does nothing when no destination is configured", async () => {
  resetDeletedMessageCacheForTests();
  const env = makeEnvironment();
  env.store.getConfig = () => ({ deletedMessageLogChannelId: null });
  cacheMessage(makeMessage(env.guild));
  await handleDeletedMessage(makeMessage(env.guild, { partial: true }), env.store, { waitMs: 0 });
  assert.equal(env.sent.length, 0);
});
