import { PermissionFlagsBits } from "discord.js";

export function hasModeratorPermission(member, permission) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(permission));
}

export function canActOnTarget(moderator, target, botMember, action) {
  if (!moderator || !target || !botMember) return "Member information is unavailable.";
  if (target.id === moderator.id) return "You cannot use this action on yourself.";
  if (target.id === moderator.guild.ownerId) return "The server owner is protected.";
  if (target.id === botMember.id) return "The bot cannot moderate itself.";
  if (moderator.id !== moderator.guild.ownerId &&
      moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return "Your highest role must be above the target's highest role.";
  }
  const canAct = action === "kick" ? target.kickable :
    action === "ban" ? target.bannable : target.moderatable;
  if (!canAct) return "The bot's role is not high enough or it lacks the required permission.";
  return null;
}

export function isSnowflake(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}
