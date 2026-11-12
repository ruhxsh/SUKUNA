import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleCountingCommand, handleCountingMessage } from "../src/counting.js";
import { CountingStore, extractLegacyCountingData, normalizeCountingData } from "../src/store.js";

const guildId = "10000000000000001";
const channelId = "20000000000000002";
const userA = "30000000000000003";
const userB = "40000000000000004";

function makeMessage({
  content,
  authorId = userA,
  guild = true,
  permissions = new Set(["AddReactions", "ManageMessages"]),
} = {}) {
  const calls = { reactions: [], deleted: false, replies: [] };
  const channel = {
    id: channelId,
    permissionsFor: () => ({ has: (permission) => permissions.has(permission) }),
  };
  const message = {
    content,
    author: { id: authorId, bot: false },
    guild: guild ? { id: guildId, members: { me: {} } } : null,
    channel,
    react: async (emoji) => calls.reactions.push(emoji),
    delete: async () => { calls.deleted = true; },
    reply: async (payload) => calls.replies.push(payload),
    calls,
  };
  return message;
}

test("legacy extraction keeps only counting state and preserves disabled guild progress", () => {
  const migrated = extractLegacyCountingData({
    version: 3,
    guilds: {
      [guildId]: {
        countingChannelId: channelId,
        currentCount: 128,
        highestCount: 140,
        lastCounterId: userA,
        welcomeChannelId: "50000000000000005",
      },
      "10000000000000006": {
        countingChannelId: null,
        currentCount: 22,
        highestCount: 22,
        lastCounterId: userB,
      },
      "10000000000000007": { currentCount: 0, highestCount: 0 },
    },
    warnings: { sensitive: true },
    marriages: [{ secret: true }],
  });

  assert.deepEqual(migrated.guilds[guildId], {
    channelId,
    currentCount: "128",
    highestCount: "140",
    lastCounterId: userA,
  });
  assert.deepEqual(migrated.guilds["10000000000000006"], {
    channelId: null,
    currentCount: "22",
    highestCount: "22",
    lastCounterId: userB,
  });
  assert.equal(migrated.guilds["10000000000000007"], undefined);
  assert.equal("warnings" in migrated, false);
  assert.equal("marriages" in migrated, false);
});

test("normalization supports large counts and repairs inconsistent high counts", () => {
  const normalized = normalizeCountingData({
    version: 1,
    guilds: {
      [guildId]: {
        channelId,
        currentCount: "900719925474099312345",
        highestCount: "5",
        lastCounterId: userA,
      },
    },
  });

  assert.equal(normalized.guilds[guildId].currentCount, "900719925474099312345");
  assert.equal(normalized.guilds[guildId].highestCount, "900719925474099312345");
});

test("counts persist, enforce sequence and alternate members", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-test-"));
  const filePath = join(directory, "counting-data.json");

  try {
    const store = await new CountingStore(filePath).load();
    await store.setChannel(guildId, channelId);

    assert.equal((await store.recordCount(guildId, "0001", userA)).accepted, true);
    assert.equal((await store.recordCount(guildId, "2", userA)).reason, "same-member");
    assert.equal((await store.recordCount(guildId, "3", userB)).reason, "wrong-number");
    assert.equal((await store.recordCount(guildId, "2", userB)).accepted, true);

    const restarted = await new CountingStore(filePath).load();
    assert.deepEqual(restarted.getGuildState(guildId), {
      channelId,
      currentCount: "2",
      highestCount: "2",
      lastCounterId: userB,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simultaneous count attempts cannot both claim the same number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-race-"));
  try {
    const store = await new CountingStore(join(directory, "counting-data.json")).load();
    await store.setChannel(guildId, channelId);

    const results = await Promise.all([
      store.recordCount(guildId, "1", userA),
      store.recordCount(guildId, "1", userB),
    ]);

    assert.equal(results.filter((result) => result.accepted).length, 1);
    assert.equal(store.getGuildState(guildId).currentCount, "1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("count handler accepts valid numbers and removes invalid numeric entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-handler-"));
  try {
    const store = await new CountingStore(join(directory, "counting-data.json")).load();
    await store.setChannel(guildId, channelId);

    const first = makeMessage({ content: "0001", authorId: userA });
    const sameMember = makeMessage({ content: "2", authorId: userA });
    const decimal = makeMessage({ content: "2.5", authorId: userB });
    const second = makeMessage({ content: "2", authorId: userB });

    await handleCountingMessage(first, store, { error() {} });
    await handleCountingMessage(sameMember, store, { error() {} });
    await handleCountingMessage(decimal, store, { error() {} });
    await handleCountingMessage(second, store, { error() {} });

    assert.deepEqual(first.calls.reactions, ["✅"]);
    assert.equal(sameMember.calls.deleted, true);
    assert.equal(decimal.calls.deleted, true);
    assert.deepEqual(second.calls.reactions, ["✅"]);
    assert.equal(store.getGuildState(guildId).currentCount, "2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-number messages, bots, other channels and other servers are ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-ignore-"));
  try {
    const store = await new CountingStore(join(directory, "counting-data.json")).load();
    await store.setChannel(guildId, channelId);

    const ordinary = makeMessage({ content: "hello" });
    const bot = makeMessage({ content: "1" });
    bot.author.bot = true;
    const otherChannel = makeMessage({ content: "1" });
    otherChannel.channel.id = "50000000000000005";
    const dm = makeMessage({ content: "1", guild: false });

    assert.equal(await handleCountingMessage(ordinary, store, { error() {} }), false);
    assert.equal(await handleCountingMessage(bot, store, { error() {} }), false);
    assert.equal(await handleCountingMessage(otherChannel, store, { error() {} }), false);
    assert.equal(await handleCountingMessage(dm, store, { error() {} }), false);
    assert.equal(store.getGuildState(guildId).currentCount, "0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("count setup commands preserve progress when disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-setup-"));
  try {
    const store = await new CountingStore(join(directory, "counting-data.json")).load();
    await store.setChannel(guildId, channelId);
    await store.recordCount(guildId, "1", userA);

    const disabled = makeMessage({ content: "s disablecounting" });
    disabled.member = { permissions: { has: (permission) => permission === "ManageGuild" } };
    await handleCountingCommand(disabled, store);

    assert.equal(store.getGuildState(guildId).channelId, null);
    assert.equal(store.getGuildState(guildId).currentCount, "1");
    assert.match(disabled.calls.replies[0].content, /preserved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid JSON is not overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-corrupt-"));
  const filePath = join(directory, "counting-data.json");
  const original = "{broken";
  try {
    await writeFile(filePath, original, "utf8");
    await assert.rejects(new CountingStore(filePath).load(), /not valid JSON/);
    assert.equal(await readFile(filePath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
