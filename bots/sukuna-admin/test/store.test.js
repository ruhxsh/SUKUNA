import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/store.js";

test("warnings persist and can be removed independently", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    const warning = await store.addWarning({
      guildId: "12345678901234567", targetId: "22345678901234567",
      moderatorId: "32345678901234567", reason: "Test warning"
    });
    const reloaded = await new JsonStore(file).init();
    assert.equal(reloaded.getWarnings("12345678901234567", "22345678901234567").length, 1);
    assert.equal(reloaded.getWarnings("12345678901234567", "22345678901234567")[0].id, warning.id);
    assert.ok(await reloaded.removeWarning("12345678901234567", "22345678901234567", warning.id));
    assert.equal(reloaded.getWarnings("12345678901234567", "22345678901234567").length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("clearing warnings preserves other members' records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sukuna-admin-"));
  const file = path.join(directory, "store.json");
  try {
    const store = await new JsonStore(file).init();
    const guildId = "12345678901234567";
    await store.addWarning({ guildId, targetId: "22345678901234567", moderatorId: "32345678901234567", reason: "A" });
    await store.addWarning({ guildId, targetId: "42345678901234567", moderatorId: "32345678901234567", reason: "B" });
    assert.equal(await store.clearWarnings(guildId, "22345678901234567"), 1);
    assert.equal(store.getWarnings(guildId, "42345678901234567").length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
