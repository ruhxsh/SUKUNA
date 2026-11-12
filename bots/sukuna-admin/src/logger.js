import { EmbedBuilder } from "discord.js";

export async function logModeration(client, store, guild, details) {
  const entry = {
    action: details.action || "unknown",
    targetId: details.targetId || "N/A",
    moderatorId: details.moderatorId || "N/A",
    reason: details.reason || "No reason supplied",
    duration: details.duration || "N/A",
    result: details.result || "unknown",
    timestamp: new Date().toISOString()
  };
  console.log("[MODERATION]", JSON.stringify({ guildId: guild?.id, ...entry }));
  if (!guild) return;
  const channelId = store.getConfig(guild.id).modLogChannelId;
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return;
    const embed = new EmbedBuilder()
      .setTitle("Moderation: " + entry.action)
      .setColor(entry.result === "success" ? 0x2ecc71 : 0xe74c3c)
      .addFields(
        { name: "Target", value: entry.targetId, inline: true },
        { name: "Moderator", value: entry.moderatorId, inline: true },
        { name: "Result", value: entry.result, inline: true },
        { name: "Reason", value: entry.reason.slice(0, 1000) },
        { name: "Duration", value: entry.duration, inline: true },
        { name: "Time (UTC)", value: entry.timestamp, inline: true }
      );
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Could not send moderation log:", error.message);
  }
}
