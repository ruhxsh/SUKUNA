import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import {
  buildAnimeGifApiUrl,
  DEFAULT_ANIME_GIF_API_BASE_URL,
  fetchAnimeGif,
  SUPPORTED_ANIME_GIF_ACTIONS,
} from "../src/anime-gifs.js";
import {
  ANIME_INTERACTION_COMMANDS,
  handleAnimeReplyButton,
  handleAnimeInteraction,
} from "../src/commands/anime-interactions.js";
import {
  handleInteraction,
  handleMessage,
  parseCommand,
} from "../src/command-handler.js";
import {
  handleCountingMessage,
  handleCountingSetup,
} from "../src/commands/counting.js";
import { handleMarriageCommand } from "../src/commands/marriage.js";
import { safeErrorMessage } from "../src/logging.js";
import { selfAssignableRoleProblem } from "../src/permissions.js";
import {
  JsonStore,
  normalizeStoreData,
  parseDuration,
} from "../src/store.js";
import { handleUtility } from "../src/commands/utility.js";

const guildId = "10000000000000001";
const userId = "20000000000000002";
const moderatorId = "30000000000000003";
const channelId = "40000000000000004";

test("prefix parser accepts lowercase and uppercase s and ignores ordinary messages", () => {
  assert.deepEqual(parseCommand("s ping"), { command: "ping", args: [] });
  assert.deepEqual(parseCommand("S ping"), { command: "ping", args: [] });
  assert.deepEqual(parseCommand("s timeout @member 20m reason words"), {
    command: "timeout",
    args: ["@member", "20m", "reason", "words"],
  });
  assert.deepEqual(parseCommand("S timeout @member 20m reason words"), {
    command: "timeout",
    args: ["@member", "20m", "reason", "words"],
  });
  assert.deepEqual(parseCommand("s"), { command: "", args: [] });
  assert.equal(parseCommand("someone said hi"), null);
});

test("s avatar is not accepted as an alias for s av", async () => {
  const replies = [];
  const message = {
    author: { bot: false },
    guild: {},
    content: "s avatar",
    reply: async (payload) => replies.push(payload),
  };

  await handleMessage(message, {}, {});
  assert.match(replies[0].content, /Unknown command/);
});

test("all requested anime action commands map to documented GIF API actions", () => {
  assert.deepEqual(ANIME_INTERACTION_COMMANDS, [
    "hug",
    "kiss",
    "pat",
    "cuddle",
    "punch",
    "slap",
    "poke",
    "wave",
    "highfive",
    "bite",
    "dance",
  ]);
  assert.deepEqual(ANIME_INTERACTION_COMMANDS, SUPPORTED_ANIME_GIF_ACTIONS);
  assert.equal(DEFAULT_ANIME_GIF_API_BASE_URL, "https://nekos.best/api/v2");

  for (const action of ANIME_INTERACTION_COMMANDS) {
    assert.equal(
      new URL(buildAnimeGifApiUrl(action)).pathname,
      `/api/v2/${action}`,
    );
  }
  assert.throws(() => buildAnimeGifApiUrl("not-an-action"), /Unsupported/);
  assert.throws(
    () => buildAnimeGifApiUrl("hug", "http://api.gifukai.com/v1"),
    /HTTPS/,
  );
});

test("Nekos.best GIF response is parsed without a second media request", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        results: [{
          anime_name: "Test Anime",
          url: "https://nekos.best/api/v2/hug/sample.gif",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await fetchAnimeGif("hug", { fetchImpl });
  assert.equal(result.url, "https://nekos.best/api/v2/hug/sample.gif");
  assert.equal(result.anime, "Test Anime");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nekos.best/api/v2/hug");
});

test("GIF fetch validates metadata and confirms the image is reachable", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "image/gif" },
      });
    }
    return new Response(
      JSON.stringify({
        action: "hug",
        anime: "Test Anime",
        url: "https://cdn.gifukai.com/hug/sample.gif",
        content_type: "image/gif",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await fetchAnimeGif("hug", {
    baseUrl: "https://api.gifukai.com/v1",
    fetchImpl,
  });

  assert.equal(result.url, "https://cdn.gifukai.com/hug/sample.gif");
  assert.equal(result.anime, "Test Anime");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.gifukai.com/v1/hug");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[1].options.method, "HEAD");
});

test("GIF fetch rejects untrusted image hosts and unavailable image files", async () => {
  const apiResponse = (url) =>
    new Response(
      JSON.stringify({
        action: "hug",
        anime: "Test Anime",
        url,
        content_type: "image/gif",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  await assert.rejects(
    fetchAnimeGif("hug", {
      baseUrl: "https://api.gifukai.com/v1",
      fetchImpl: async () => apiResponse("https://untrusted.example/file.gif"),
    }),
    /unsupported image/,
  );

  let requestCount = 0;
  await assert.rejects(
    fetchAnimeGif("hug", {
      baseUrl: "https://api.gifukai.com/v1",
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? apiResponse("https://cdn.gifukai.com/hug/missing.gif")
          : new Response(null, { status: 404 });
      },
    }),
    /not currently available/,
  );
});

test("help includes every anime interaction command", async () => {
  let helpEmbed;
  await handleUtility(
    {
      reply: async (payload) => {
        helpEmbed = payload.embeds[0];
      },
    },
    "help",
    [],
    {},
  );

  const helpText = helpEmbed.data.fields.map((field) => field.value).join("\n");
  for (const command of ANIME_INTERACTION_COMMANDS) {
    assert.ok(helpText.includes(`s ${command}`), `${command} is listed in help`);
  }
});

function makeInteractionMessage({
  authorId,
  targetMember = null,
  targetUser = null,
} = {}) {
  const replies = [];
  return {
    author: { id: authorId ?? "20000000000000002" },
    mentions: {
      members: { first: () => targetMember },
      users: { first: () => targetUser },
    },
    reply: async (payload) => {
      replies.push(payload);
      return {
        id: "70000000000000007",
        channelId,
        channel: { id: channelId },
      };
    },
    replies,
  };
}

function makeFakeAnimeReplyStore() {
  const records = new Map();
  const counts = new Map();
  const countKey = (guildId, actorId, targetId, action) =>
    `${guildId}:${actorId}:${targetId}:${action}`;
  return {
    records,
    async createAnimeReply(record) {
      const saved = { id: "anime-reply-record", ...record, messageId: null };
      records.set(saved.id, saved);
      return { ...saved };
    },
    async setAnimeReplyMessage(id, savedChannelId, messageId) {
      const saved = records.get(id);
      if (!saved) return false;
      saved.channelId = savedChannelId;
      saved.messageId = messageId;
      return true;
    },
    async removeAnimeReply(id) {
      return records.delete(id);
    },
    getInteractionCount(guildId, actorId, targetId, action) {
      return counts.get(countKey(guildId, actorId, targetId, action)) ?? 0;
    },
    async incrementInteractionCount(guildId, actorId, targetId, action) {
      const key = countKey(guildId, actorId, targetId, action);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

function makeButtonInteraction({
  customId,
  userId,
  messageId = "70000000000000007",
  interactionChannelId = channelId,
} = {}) {
  const calls = { replies: [], followUps: [], edits: [], sentMessages: [] };
  const channel = {
    id: interactionChannelId,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      calls.sentMessages.push(payload);
      return {
        id: "80000000000000008",
        channelId: interactionChannelId,
        channel,
      };
    },
  };
  const interaction = {
    customId,
    user: { id: userId },
    guildId,
    channelId: interactionChannelId,
    message: { id: messageId },
    guild: {
      id: guildId,
      members: { me: { permissions: { has: () => true } } },
    },
    channel,
    replied: false,
    deferred: false,
    inGuild: () => true,
    isButton: () => true,
    reply: async (payload) => {
      calls.replies.push(payload);
      interaction.replied = true;
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => calls.edits.push(payload),
    followUp: async (payload) => calls.followUps.push(payload),
  };
  return { interaction, calls };
}

test("target-required interactions explain missing, invalid, self, and bot targets", async () => {
  let fetchCount = 0;
  const gifFetcher = async () => {
    fetchCount += 1;
    return { url: "https://cdn.gifukai.com/hug/sample.gif", anime: "Test Anime" };
  };
  const store = {};
  const client = { user: { id: "10000000000000001" } };

  const missing = makeInteractionMessage();
  await handleAnimeInteraction(missing, "hug", client, store, gifFetcher);
  assert.match(missing.replies[0].content, /Usage: `s hug @user`/);

  const invalid = makeInteractionMessage({
    targetUser: { id: "30000000000000003" },
  });
  await handleAnimeInteraction(invalid, "pat", client, store, gifFetcher);
  assert.match(invalid.replies[0].content, /member of this server/);

  const botTarget = makeInteractionMessage({
    targetMember: { id: client.user.id },
  });
  await handleAnimeInteraction(botTarget, "kiss", client, store, gifFetcher);
  assert.match(botTarget.replies[0].content, /can't target myself/);

  const selfTarget = makeInteractionMessage({
    targetMember: { id: "20000000000000002" },
  });
  await handleAnimeInteraction(selfTarget, "slap", client, store, gifFetcher);
  assert.match(selfTarget.replies[0].content, /another member/);
  assert.equal(fetchCount, 0);
});

test("dance works without a target and mentions the performer", async () => {
  const message = makeInteractionMessage();
  message.guild = {
    members: { me: { permissions: { has: () => true } } },
  };
  message.channel = {
    isTextBased: () => true,
    send: () => {},
    permissionsFor: () => ({ has: () => true }),
  };

  await handleAnimeInteraction(
    message,
    "dance",
    { user: { id: "10000000000000001" } },
    {},
    async () => ({
      url: "https://cdn.gifukai.com/dance/sample.gif",
      anime: "Test Anime",
    }),
  );

  const payload = message.replies[0];
  assert.equal(
    payload.embeds[0].data.image.url,
    "https://cdn.gifukai.com/dance/sample.gif",
  );
  assert.match(payload.embeds[0].data.description, /<@20000000000000002>/);
  assert.deepEqual(payload.allowedMentions.users, ["20000000000000002"]);
});

test("a targeted interaction includes both mentions and the returned GIF", async () => {
  const actorId = "20000000000000002";
  const targetId = "30000000000000003";
  const message = makeInteractionMessage({
    authorId: actorId,
    targetMember: { id: targetId },
  });
  message.guild = {
    id: guildId,
    members: { me: { permissions: { has: () => true } } },
  };
  message.channel = {
    id: channelId,
    isTextBased: () => true,
    send: () => {},
    permissionsFor: () => ({ has: () => true }),
  };
  const store = makeFakeAnimeReplyStore();

  await handleAnimeInteraction(
    message,
    "hug",
    { user: { id: "10000000000000001" } },
    store,
    async (action) => ({
      action,
      url: "https://cdn.gifukai.com/hug/sample.gif",
      anime: "Test Anime",
    }),
  );

  const payload = message.replies[0];
  assert.equal(
    payload.embeds[0].data.image.url,
    "https://cdn.gifukai.com/hug/sample.gif",
  );
  assert.match(payload.embeds[0].data.description, new RegExp(`<@${actorId}>`));
  assert.match(payload.embeds[0].data.description, new RegExp(`<@${targetId}>`));
  assert.deepEqual(payload.allowedMentions.users, [actorId, targetId]);
  assert.equal(payload.components[0].components[0].data.label, "Hug back");
});

test("an unavailable GIF source produces no image embed", async () => {
  const actorId = "20000000000000002";
  const message = makeInteractionMessage({
    authorId: actorId,
    targetMember: { id: "30000000000000003" },
  });
  message.guild = {
    id: "10000000000000001",
    members: { me: { permissions: { has: () => true } } },
    channels: { fetch: async () => null },
  };
  message.channel = {
    isTextBased: () => true,
    send: () => {},
    permissionsFor: () => ({ has: () => true }),
  };

  await handleAnimeInteraction(
    message,
    "hug",
    { user: { id: "10000000000000001" } },
    { getGuildConfig: () => ({ modLogChannelId: null }) },
    async () => {
      throw new Error("Image service unavailable.");
    },
  );

  assert.equal(message.replies[0].embeds, undefined);
  assert.match(message.replies[0].content, /couldn't load that anime GIF/);
});

test("duration parser accepts valid units and enforces Discord's 28-day limit", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("4w"), 28 * 86_400_000);
  assert.equal(parseDuration("29d"), null);
  assert.equal(parseDuration("0m"), null);
  assert.equal(parseDuration("1h30m"), null);
  assert.equal(parseDuration("soon"), null);
});

test("error diagnostics redact token-like strings before logging", () => {
  const token = "abc.def.abcdefghijklmnopqrstuvwxyz0123456789";
  const message = safeErrorMessage(new Error(`Login failed using ${token}`), token);
  assert.equal(message, "Login failed using [REDACTED]");
  assert.doesNotMatch(message, /abcdefghijklmnopqrstuvwxyz/);
});

test("self-role validation rejects privileged and managed roles", () => {
  const makeRole = (id, permission = 0n, managed = false) => ({
    id,
    guild: { id: guildId },
    managed,
    permissions: new PermissionsBitField(permission),
  });

  assert.equal(selfAssignableRoleProblem(makeRole("50000000000000005")), null);
  assert.match(
    selfAssignableRoleProblem(
      makeRole("50000000000000005", PermissionFlagsBits.Administrator),
    ),
    /staff-level/,
  );
  assert.match(
    selfAssignableRoleProblem(makeRole("50000000000000005", 0n, true)),
    /Integration-managed/,
  );
  assert.match(selfAssignableRoleProblem(makeRole(guildId)), /@everyone/);
});

test("settings and warnings survive a store reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-store-test-"));
  try {
    const firstRun = await new JsonStore(join(directory, "sukuna-data.json")).load();
    await firstRun.setGuildConfig(guildId, {
      welcomeChannelId: channelId,
      selfAssignableRoleIds: ["50000000000000005"],
      countingChannelId: channelId,
    });
    assert.equal(await firstRun.tryIncrementCounting(guildId, 1, userId), true);
    assert.equal(await firstRun.tryIncrementCounting(guildId, 2, moderatorId), true);
    const warning = await firstRun.addWarning(
      guildId,
      userId,
      moderatorId,
      "Test warning",
    );

    const afterRestart = await new JsonStore(join(directory, "sukuna-data.json")).load();
    assert.equal(afterRestart.getGuildConfig(guildId).welcomeChannelId, channelId);
    assert.deepEqual(afterRestart.getGuildConfig(guildId).selfAssignableRoleIds, [
      "50000000000000005",
    ]);
    assert.equal(afterRestart.getGuildConfig(guildId).countingChannelId, channelId);
    assert.equal(afterRestart.getGuildConfig(guildId).currentCount, 2);
    assert.equal(afterRestart.getGuildConfig(guildId).highestCount, 2);
    assert.equal(afterRestart.getGuildConfig(guildId).lastCounterId, moderatorId);
    assert.deepEqual(afterRestart.getWarnings(guildId, userId), [warning]);
    assert.equal(await afterRestart.clearWarnings(guildId, userId), 1);
    assert.deepEqual(
      (await new JsonStore(join(directory, "sukuna-data.json")).load()).getWarnings(
        guildId,
        userId,
      ),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store normalization drops invalid IDs and defaults bad settings safely", () => {
  const data = normalizeStoreData({
    version: 1,
    guilds: {
      [guildId]: {
        welcomeChannelId: "not-a-snowflake",
        modLogChannelId: channelId,
        selfAssignableRoleIds: ["50000000000000005", "bad"],
      },
      invalid: { welcomeChannelId: channelId },
    },
    warnings: null,
  });

  assert.deepEqual(data.guilds[guildId], {
    welcomeChannelId: null,
    modLogChannelId: channelId,
    autoRoleId: null,
    selfAssignableRoleIds: ["50000000000000005"],
    countingChannelId: null,
    currentCount: 0,
    highestCount: 0,
    lastCounterId: null,
  });
  assert.equal(data.guilds.invalid, undefined);
  assert.deepEqual(data.warnings, {});
  assert.throws(() => normalizeStoreData({ version: 99 }), /unsupported or invalid/);
});

function makeCountingMessage({
  content,
  guildId: messageGuildId = guildId,
  channelId: messageChannelId = channelId,
  authorId = userId,
  permissions = new PermissionsBitField(
    PermissionFlagsBits.AddReactions | PermissionFlagsBits.ManageMessages,
  ),
}) {
  const reactions = [];
  let deleted = false;

  return {
    author: { id: authorId, bot: false },
    content,
    guild: {
      id: messageGuildId,
      members: { me: { id: "60000000000000006" } },
    },
    channel: {
      id: messageChannelId,
      permissionsFor: () => permissions,
    },
    react: async (emoji) => reactions.push(emoji),
    delete: async () => {
      deleted = true;
    },
    reactions,
    get deleted() {
      return deleted;
    },
  };
}

test("counting accepts the next number and deletes incorrect or consecutive-member numbers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-test-"));

  try {
    const store = await new JsonStore(join(directory, "sukuna-data.json")).load();
    await store.setGuildConfig(guildId, { countingChannelId: channelId });

    const first = makeCountingMessage({ content: "1", authorId: userId });
    const repeated = makeCountingMessage({ content: "2", authorId: userId });
    const skipped = makeCountingMessage({ content: "3", authorId: moderatorId });
    const second = makeCountingMessage({ content: "2", authorId: moderatorId });
    const repeatedAgain = makeCountingMessage({ content: "3", authorId: moderatorId });
    const third = makeCountingMessage({ content: "3", authorId: userId });

    for (const message of [first, repeated, skipped, second, repeatedAgain, third]) {
      await handleCountingMessage(message, store);
    }

    assert.deepEqual(
      [first, repeated, skipped, second, repeatedAgain, third].map(
        (message) => message.reactions,
      ),
      [["✅"], [], [], ["✅"], [], ["✅"]],
    );

    assert.deepEqual(
      [first, repeated, skipped, second, repeatedAgain, third].map(
        (message) => message.deleted,
      ),
      [false, true, true, false, true, false],
    );

    assert.equal(store.getGuildConfig(guildId).currentCount, 3);
    assert.equal(store.getGuildConfig(guildId).highestCount, 3);
    assert.equal(store.getGuildConfig(guildId).lastCounterId, userId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simultaneous counting messages accept only one count and servers stay independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-race-test-"));
  const otherGuildId = "10000000000000003";

  try {
    const store = await new JsonStore(join(directory, "sukuna-data.json")).load();
    await store.setGuildConfig(guildId, { countingChannelId: channelId });
    await store.setGuildConfig(otherGuildId, { countingChannelId: "40000000000000005" });

    const messages = [
      makeCountingMessage({ content: "1", authorId: userId }),
      makeCountingMessage({ content: "1", authorId: moderatorId }),
      makeCountingMessage({
        content: "1",
        guildId: otherGuildId,
        channelId: "40000000000000005",
        authorId: userId,
      }),
    ];

    await Promise.all(messages.map((message) => handleCountingMessage(message, store)));

    assert.equal(
      messages.slice(0, 2).filter((message) => message.reactions.includes("✅")).length,
      1,
    );
    assert.equal(
      messages.slice(0, 2).filter((message) => message.deleted).length,
      1,
    );
    assert.deepEqual(messages[2].reactions, ["✅"]);
    assert.equal(messages[2].deleted, false);

    assert.equal(store.getGuildConfig(guildId).currentCount, 1);
    assert.equal(store.getGuildConfig(otherGuildId).currentCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("counting ignores non-number messages and does not advance without required permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-permissions-test-"));
  const originalConsoleError = console.error;

  try {
    const store = await new JsonStore(join(directory, "sukuna-data.json")).load();
    await store.setGuildConfig(guildId, { countingChannelId: channelId });

    const ordinaryMessage = makeCountingMessage({ content: "hello" });
    await handleCountingMessage(ordinaryMessage, store);
    assert.deepEqual(ordinaryMessage.reactions, []);
    assert.equal(ordinaryMessage.deleted, false);

    const blockedMessage = makeCountingMessage({
      content: "1",
      permissions: new PermissionsBitField(),
    });

    console.error = () => {};
    await handleCountingMessage(blockedMessage, store);

    assert.deepEqual(blockedMessage.reactions, []);
    assert.equal(blockedMessage.deleted, false);
    assert.equal(store.getGuildConfig(guildId).currentCount, 0);
  } finally {
    console.error = originalConsoleError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("counting keeps a saved accepted count when Discord reaction delivery fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-counting-reaction-test-"));
  const originalConsoleError = console.error;

  try {
    const store = await new JsonStore(join(directory, "sukuna-data.json")).load();
    await store.setGuildConfig(guildId, { countingChannelId: channelId });

    const message = makeCountingMessage({ content: "1" });
    message.react = async () => {
      throw new Error("Reaction request failed");
    };

    console.error = () => {};

    await assert.doesNotReject(handleCountingMessage(message, store));
    assert.equal(store.getGuildConfig(guildId).currentCount, 1);
    assert.equal(store.getGuildConfig(guildId).lastCounterId, userId);
  } finally {
    console.error = originalConsoleError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("counting setup requires ManageGuild and preserves progress when disabled", async () => {
  const replies = [];
  const configs = [];
  const requiredBotPermissions =
    PermissionFlagsBits.AddReactions | PermissionFlagsBits.ManageMessages;

  const guild = {
    id: guildId,
    ownerId: "90000000000000009",
    members: {
      me: {
        permissions: new PermissionsBitField(requiredBotPermissions),
      },
    },
  };

  const channel = {
    id: channelId,
    guild,
    send: () => {},
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(requiredBotPermissions),
  };

  const message = {
    author: { id: userId },
    guild,
    member: {
      permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    },
    mentions: { channels: { first: () => channel } },
    reply: async (payload) => replies.push(payload),
  };

  const store = {
    getGuildConfig: () => ({ currentCount: 7 }),
    setGuildConfig: async (id, patch) => configs.push({ id, patch }),
  };

  await handleCountingSetup(message, store);
  await handleCountingSetup(message, store, true);

  assert.deepEqual(configs, [
    { id: guildId, patch: { countingChannelId: channelId } },
    { id: guildId, patch: { countingChannelId: null } },
  ]);

  assert.match(replies[0].content, /current count is 7/);
  assert.match(replies[1].content, /current and highest counts are saved/);

  message.member.permissions = new PermissionsBitField();
  await assert.rejects(handleCountingSetup(message, store), /Manage Server/);
  assert.equal(configs.length, 2);
});

test("invalid JSON is reported without overwriting the user's data file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sukuna-invalid-store-test-"));
  const filePath = join(directory, "sukuna-data.json");
  const original = "{ not valid json";

  try {
    await writeFile(filePath, original, "utf8");
    await assert.rejects(new JsonStore(filePath).load(), /not valid JSON/);
    assert.equal(await readFile(filePath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
