
import { requirePermission, UserFacingError } from "../permissions.js";

function parsePositiveInteger(value, min, max) {
  if (!/^\d+$/.test(value ?? "")) return null;

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return null;
  }

  return number;
}

async function reply(message, content) {
  await message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

export async function handleSecurity(message, command, args, store) {
  if (!["automod", "raid"].includes(command)) return false;

  requirePermission(message, "ManageGuild");

  const guildId = message.guild.id;
  const config = store.getGuildConfig(guildId);
  const setting = (args[0] ?? "").toLowerCase();

  if (!setting) {
    if (command === "automod") {
      await reply(
        message,
        [
          "**Automatic moderation settings**",
          `Enabled: ${config.autoModEnabled ? "On" : "Off"}`,
          `Message limit: ${config.autoModMessageLimit}`,
          `Duplicate limit: ${config.autoModDuplicateLimit}`,
          `Mention limit: ${config.autoModMentionLimit}`,
          `Action: ${config.autoModAction}`,
          `Timeout: ${Math.floor(config.autoModTimeoutMs / 1000)} seconds`,
          "",
          "Commands:",
          "`s automod on`",
          "`s automod off`",
          "`s automod messages 6`",
          "`s automod duplicates 3`",
          "`s automod mentions 6`",
          "`s automod action warn`",
          "`s automod action timeout`",
          "`s automod timeout 60`",
        ].join("\n"),
      );
    } else {
      await reply(
        message,
        [
          "**Raid protection settings**",
          `Enabled: ${config.raidProtectionEnabled ? "On" : "Off"}`,
          `Join limit: ${config.raidJoinLimit} members`,
          "",
          "Commands:",
          "`s raid on`",
          "`s raid off`",
          "`s raid joins 8`",
        ].join("\n"),
      );
    }

    return true;
  }

  if (command === "automod") {
    if (setting === "on" || setting === "off") {
      await store.setGuildConfig(guildId, {
        autoModEnabled: setting === "on",
      });

      await reply(
        message,
        `Automatic moderation is now **${setting}**.`,
      );
      return true;
    }

    if (setting === "messages" || setting === "duplicates" || setting === "mentions") {
      const value = parsePositiveInteger(args[1], 2, 30);

      if (value === null) {
        throw new UserFacingError(
          "Enter a whole number from 2 to 30.",
        );
      }

      const fields = {
        messages: "autoModMessageLimit",
        duplicates: "autoModDuplicateLimit",
        mentions: "autoModMentionLimit",
      };

      await store.setGuildConfig(guildId, {
        [fields[setting]]: value,
      });

      await reply(message, `Automatic moderation ${setting} limit set to **${value}**.`);
      return true;
    }

    if (setting === "action") {
      const action = (args[1] ?? "").toLowerCase();

      if (!["warn", "timeout"].includes(action)) {
        throw new UserFacingError(
          "Choose an action: `warn` or `timeout`.",
        );
      }

      await store.setGuildConfig(guildId, {
        autoModAction: action,
      });

      await reply(message, `Automatic moderation action set to **${action}**.`);
      return true;
    }

    if (setting === "timeout") {
      const seconds = parsePositiveInteger(args[1], 1, 600);

      if (seconds === null) {
        throw new UserFacingError(
          "Enter a timeout from 1 to 600 seconds.",
        );
      }

      await store.setGuildConfig(guildId, {
        autoModTimeoutMs: seconds * 1000,
      });

      await reply(message, `Automatic moderation timeout set to **${seconds} seconds**.`);
      return true;
    }
  }

  if (command === "raid") {
    if (setting === "on" || setting === "off") {
      await store.setGuildConfig(guildId, {
        raidProtectionEnabled: setting === "on",
      });

      await reply(
        message,
        `Raid protection is now **${setting}**.`,
      );
      return true;
    }

    if (setting === "joins") {
      const value = parsePositiveInteger(args[1], 2, 30);

      if (value === null) {
        throw new UserFacingError(
          "Enter a whole number from 2 to 30.",
        );
      }

      await store.setGuildConfig(guildId, {
        raidJoinLimit: value,
      });

      await reply(message, `Raid join limit set to **${value} members**.`);
      return true;
    }
  }

  throw new UserFacingError(
    "Unknown security setting. Use `s automod` or `s raid` to see the commands.",
  );
}
