import { EmbedBuilder } from "discord.js";

export async function logModeration(client, store, guild, details) {
  const entry = {
    action: String(details.action || "unknown").slice(0, 80),
    targetId: String(details.targetId || "N/A"),
    moderatorId: String(details.moderatorId || "N/A"),
    reason: String(details.reason || "No reason supplied").slice(0, 1000),
    duration: String(details.duration || "N/A").slice(0, 80),
    result: String(details.result || "unknown"),
    timestamp: new Date().toISOString()
  };
  console.log("[MODERATION]", JSON.stringify({ guildId: guild?.id, ...entry }));
  if (!guild) return;
  const channelId = store.getConfig(guild.id).modLogChannelId;
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return;
    const embed = new EmbedBuilder().setTitle("Moderation: " + entry.action)
      .setColor(entry.result === "success" ? 0x2ecc71 : entry.result === "alert" ? 0xf39c12 : 0xe74c3c)
      .addFields(
        { name: "Target", value: entry.targetId, inline: true },
        { name: "Moderator", value: entry.moderatorId, inline: true },
        { name: "Result", value: entry.result, inline: true },
        { name: "Reason", value: entry.reason.slice(0, 1000) },
        { name: "Duration", value: entry.duration, inline: true },
        { name: "Time (UTC)", value: entry.timestamp, inline: true }
      );
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Could not send moderation log:", error.message);
  }
}
