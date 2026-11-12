import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/store.js";

const ids = { guildId: "12345678901234567", targetId: "22345678901234567", moderatorId: "32345678901234567" };

test("warnings persist, retain identity fields, and can be removed independently", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    const warning = await store.addWarning({ ...ids, reason: "Test warning" });
    const reloaded = await new JsonStore(file).init();
    const records = reloaded.getWarnings(ids.guildId, ids.targetId);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, warning.id);
    assert.equal(records[0].number, 1);
    assert.equal(records[0].moderatorId, ids.moderatorId);
    assert.ok(await reloaded.removeWarning(ids.guildId, ids.targetId, 1));
    assert.equal(reloaded.getWarnings(ids.guildId, ids.targetId).length, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("clearing warnings preserves other members' records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    await store.addWarning({ ...ids, reason: "A" });
    await store.addWarning({ ...ids, targetId: "42345678901234567", reason: "B" });
    assert.equal(await store.clearWarnings(ids.guildId, ids.targetId), 1);
    assert.equal(store.getWarnings(ids.guildId, "42345678901234567").length, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("concurrent writes preserve all warning records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.addWarning({ ...ids, reason: "R" + i })));
    const reloaded = await new JsonStore(file).init();
    assert.equal(reloaded.getWarnings(ids.guildId, ids.targetId).length, 30);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("configuration is bounded and ignores invalid values", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  try {
    const store = await new JsonStore(path.join(directory, "store.json")).init();
    const config = await store.updateConfig(ids.guildId, c => ({ ...c, automod: { ...c.automod, maxMessages: 999, blockedPhrases: ["bad", "", 2] }, security: { ...c.security, raidJoinLimit: 1 } }));
    assert.equal(config.automod.maxMessages, 30);
    assert.deepEqual(config.automod.blockedPhrases, ["bad"]);
    assert.equal(config.security.raidJoinLimit, 3);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed persistence rolls back warning and configuration mutations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  try {
    const store = await new JsonStore(path.join(directory, "store.json")).init();
    store.persist = async () => { throw new Error("simulated disk failure"); };
    await assert.rejects(store.addWarning({ ...ids, reason: "Should roll back" }), /simulated disk failure/);
    assert.equal(store.getWarnings(ids.guildId, ids.targetId).length, 0);
    await assert.rejects(store.updateConfig(ids.guildId, config => ({ ...config, modLogChannelId: "52345678901234567" })), /simulated disk failure/);
    assert.equal(store.getConfig(ids.guildId).modLogChannelId, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("invalid database is backed up instead of silently overwritten", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    await fs.writeFile(file, "{ invalid json", "utf8");
    const originalError = console.error;
    console.error = () => {};
    try { await new JsonStore(file).init(); }
    finally { console.error = originalError; }
    const files = await fs.readdir(directory);
    assert.ok(files.some(name => name.startsWith("store.json.corrupt-")));
    const fresh = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(fresh.version, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("warning numbers stay stable after removal and continue increasing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    const first = await store.addWarning({ ...ids, reason: "First" });
    const second = await store.addWarning({ ...ids, reason: "Second" });
    assert.equal(first.number, 1);
    assert.equal(second.number, 2);
    await store.removeWarning(ids.guildId, ids.targetId, 1);
    const third = await store.addWarning({ ...ids, reason: "Third" });
    assert.equal(third.number, 3);
    assert.deepEqual(store.getWarnings(ids.guildId, ids.targetId).map(w => w.number), [3, 2]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("older warning records receive stable numbers during database normalization", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    await fs.writeFile(file, JSON.stringify({ version: 2, guilds: {
      [ids.guildId]: { config: {}, warnings: [
        { id: "old-a", targetId: ids.targetId, moderatorId: ids.moderatorId, reason: "A", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "old-b", targetId: ids.targetId, moderatorId: ids.moderatorId, reason: "B", createdAt: "2026-01-02T00:00:00.000Z" }
      ] }
    }}), "utf8");
    const store = await new JsonStore(file).init();
    assert.deepEqual(store.getWarnings(ids.guildId, ids.targetId).map(w => w.number), [2, 1]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
