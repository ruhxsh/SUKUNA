import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PREFIX = "s";
export const DEFAULT_CONFIG = Object.freeze({
  modLogChannelId: null,
  deletedMessageLogChannelId: null,
  automod: {
    enabled: false,
    action: "delete",
    blockInvites: false,
    blockLinks: false,
    blockCaps: false,
    blockMentions: true,
    whitelistPhrases: [],
    maxMessages: 6,
    intervalMs: 7000,
    duplicateLimit: 4,
    massMentionLimit: 5,
    blockedPhrases: [],
    ignoredChannelIds: [],
    ignoredRoleIds: []
  },
  security: {
    raidProtectionEnabled: false,
    raidJoinLimit: 10,
    raidWindowMs: 15000,
    alertCooldownMs: 60000,
    accountAgeAlertsEnabled: false,
    minimumAccountAgeDays: 7,
    suspiciousAccountDetectionEnabled: false,
    raidAction: "alert",
    raidWhitelistIds: []
  }
});
export function getDataFilePath() {
  return path.join(process.env.BOT_DATA_DIR || path.resolve(here, "../data"), "sukuna-admin.json");
}
