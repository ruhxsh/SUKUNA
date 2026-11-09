import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { logError } from "../logging.js";
import { UserFacingError } from "../permissions.js";

const DEFAULT_PROPOSAL_TTL_HOURS = 24;
const MIN_PROPOSAL_TTL_HOURS = 1;
const MAX_PROPOSAL_TTL_HOURS = 168;
const DIVORCE_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

function getProposalTtlMs() {
  const raw = process.env.MARRIAGE_PROPOSAL_TTL_HOURS;
  const hours = raw === undefined ? DEFAULT_PROPOSAL_TTL_HOURS : Number(raw);
  if (
    !Number.isInteger(hours) ||
    hours < MIN_PROPOSAL_TTL_HOURS ||
    hours > MAX_PROPOSAL_TTL_HOURS
  ) {
    throw new UserFacingError(
      "MARRIAGE_PROPOSAL_TTL_HOURS must be a whole number from 1 to 168.",
    );
  }
  return hours * 60 * 60 * 1_000;
}

function targetMember(message, command) {
  const member = message.mentions.members.first();
  if (member) return member;
  if (message.mentions.users.first()) {
    return { error: "That person must be a member of this server." };
  }
  return {
    error: `Usage: \`s ${command} @user\` — mention a server member.`,
  };
}

async function reply(message, content, extra = {}) {
  return message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
    ...extra,
  });
}

function proposalButtons(proposalId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sukuna:marriage:${proposalId}:accept`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sukuna:marriage:${proposalId}:decline`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function saveMessageId(store, method, recordId, message) {
  if (!message?.id) return;
  try {
    await store[method](recordId, message.channelId ?? message.channel?.id, message.id);
  } catch (error) {
    logError(error, `Could not save ${method} for a persistent button`);
  }
}

async function handleMarry(message, store) {
  const target = targetMember(message, "marry");
  if (target.error) {
    await reply(message, target.error);
    return;
  }
  if (target.id === message.author.id) {
    await reply(message, "You can't propose to yourself.");
    return;
  }
  if (target.user?.bot) {
    await reply(message, "You can't propose to a bot.");
    return;
  }

  const ttlMs = getProposalTtlMs();
  const result = await store.createMarriageProposal({
    guildId: message.guild.id,
    proposerId: message.author.id,
    recipientId: target.id,
    channelId: message.channel.id,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (!result.ok) {
    const reasons = {
      "already-married": "You or that member is already married.",
      "pending-conflict":
        "You or that member already has a pending proposal. Resolve it before starting another.",
      invalid: "That proposal couldn't be created. Check the member and channel, then try again.",
    };
    await reply(message, reasons[result.reason] ?? "That proposal couldn't be created.");
    return;
  }

  const { proposal } = result;
  let sent;
  try {
    sent = await message.reply({
      content:
        `<@${message.author.id}> proposed to <@${target.id}>! ` +
        `Only <@${target.id}> can accept or decline. This proposal expires ` +
        `<t:${Math.floor(Date.parse(proposal.expiresAt) / 1_000)}:R>.`,
      components: proposalButtons(proposal.id),
      allowedMentions: {
        repliedUser: false,
        parse: [],
        users: [message.author.id, target.id],
      },
    });
  } catch (error) {
    await store.cancelMarriageProposal(proposal.id).catch(() => {});
    throw error;
  }
  await saveMessageId(store, "setMarriageProposalMessage", proposal.id, sent);
}

async function handleMarried(message, store) {
  const marriage = store.getMarriage(message.guild.id, message.author.id);
  if (!marriage) {
    await reply(message, "You aren't currently married.");
    return;
  }

  await reply(
    message,
    `You are married to <@${marriage.spouseId}> since ` +
      `<t:${Math.floor(Date.parse(marriage.marriedAt) / 1_000)}:D>.`,
  );
}

async function handleDivorce(message, store) {
  const marriage = store.getMarriage(message.guild.id, message.author.id);
  if (!marriage) {
    await reply(message, "You aren't currently married.");
    return;
  }

  const expiresAt = new Date(Date.now() + DIVORCE_CONFIRMATION_TTL_MS).toISOString();
  const result = await store.createDivorceConfirmation({
    guildId: message.guild.id,
    userId: message.author.id,
    spouseId: marriage.spouseId,
    channelId: message.channel.id,
    expiresAt,
  });
  if (!result.ok) {
    await reply(message, "Your marriage changed before the confirmation could be created.");
    return;
  }

  const confirmation = result.confirmation;
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sukuna:divorce:${confirmation.id}:confirm`)
        .setLabel("Confirm divorce")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`sukuna:divorce:${confirmation.id}:cancel`)
        .setLabel("Stay married")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  let sent;
  try {
    sent = await message.reply({
      content:
        `This will end your marriage to <@${marriage.spouseId}>. ` +
        `Only you can confirm or cancel, and this prompt expires in 5 minutes.`,
      components,
      allowedMentions: { repliedUser: false, parse: [] },
    });
  } catch (error) {
    await store
      .resolveDivorceConfirmation(confirmation.id, message.author.id, "cancel")
      .catch(() => {});
    throw error;
  }
  await saveMessageId(store, "setDivorceConfirmationMessage", confirmation.id, sent);
}

async function handleCouple(message, store) {
  const target = targetMember(message, "couple");
  if (target.error) {
    await reply(message, target.error);
    return;
  }
  if (target.id === message.author.id) {
    await reply(message, "Mention another member to check your relationship.");
    return;
  }

  const marriage = store.getMarriageBetween(
    message.guild.id,
    message.author.id,
    target.id,
  );
  if (!marriage) {
    await reply(message, `You and <@${target.id}> aren't married to each other.`);
    return;
  }

  await reply(
    message,
    `<@${marriage.memberA}> and <@${marriage.memberB}> have been married since ` +
      `<t:${Math.floor(Date.parse(marriage.marriedAt) / 1_000)}:D>.`,
  );
}

async function handleShip(message) {
  const target = targetMember(message, "ship");
  if (target.error) {
    await reply(message, target.error);
    return;
  }
  if (target.id === message.author.id) {
    await reply(message, "Mention another member to check your compatibility.");
    return;
  }
  if (target.user?.bot) {
    await reply(message, "Bots don't have a compatibility score.");
    return;
  }

  const score = Math.floor(Math.random() * 101);
  const messageForScore =
    score >= 90
      ? "The stars are practically writing your theme song."
      : score >= 70
        ? "A promising duo with strong anime-opening energy."
        : score >= 40
          ? "There might be a spark after the next story arc."
          : "More chaotic side-quest energy than romance—for now.";
  await reply(
    message,
    `💞 <@${message.author.id}> + <@${target.id}>: **${score}%** compatibility. ${messageForScore}`,
    {
      allowedMentions: {
        repliedUser: false,
        parse: [],
        users: [message.author.id, target.id],
      },
    },
  );
}

async function handleProposals(message, store) {
  const proposals = await store.getPendingMarriageProposals(
    message.guild.id,
    message.author.id,
  );
  if (proposals.length === 0) {
    await reply(message, "You have no pending marriage proposals.");
    return;
  }

  const lines = proposals.map((proposal) => {
    const incoming = proposal.recipientId === message.author.id;
    const otherId = incoming ? proposal.proposerId : proposal.recipientId;
    const direction = incoming ? "Incoming from" : "Sent to";
    const expiry = `<t:${Math.floor(Date.parse(proposal.expiresAt) / 1_000)}:R>`;
    return `• ${direction} <@${otherId}> — expires ${expiry}`;
  });
  await reply(message, `**Your pending proposals**\n${lines.join("\n")}`);
}

async function handleMarriageHelp(message, store) {
  const marriage = store.getMarriage(message.guild.id, message.author.id);
  const status = marriage
    ? `Current status: married to <@${marriage.spouseId}>.`
    : "Current status: unmarried.";
  const proposals = await store.getPendingMarriageProposals(
    message.guild.id,
    message.author.id,
  );
  const pendingStatus =
    proposals.length > 0
      ? `\nYou have ${proposals.length} pending proposal${proposals.length === 1 ? "" : "s"}.`
      : "";
  const embed = new EmbedBuilder()
    .setColor(0x7c3aed)
    .setTitle("Marriage commands")
    .setDescription(
      `${status}${pendingStatus}\n\n` +
        "`s marry @user` — propose with Accept and Decline buttons\n" +
        "`s married` — show your spouse\n" +
        "`s divorce` — request a confirmation before ending a marriage\n" +
        "`s couple @user` — check whether you are married to a member\n" +
        "`s ship @user` — generate a playful compatibility score\n" +
        "`s proposals` — list your pending proposals",
    );
  await message.reply({
    embeds: [embed],
    allowedMentions: { repliedUser: false, parse: [] },
  });
}

export async function handleMarriageCommand(message, command, store) {
  switch (command) {
    case "marry":
      await handleMarry(message, store);
      return true;
    case "married":
      await handleMarried(message, store);
      return true;
    case "divorce":
      await handleDivorce(message, store);
      return true;
    case "couple":
      await handleCouple(message, store);
      return true;
    case "ship":
      await handleShip(message);
      return true;
    case "proposals":
      await handleProposals(message, store);
      return true;
    case "marriage":
      await handleMarriageHelp(message, store);
      return true;
    default:
      return false;
  }
}

function componentContextMatches(interaction, record) {
  return Boolean(
    interaction.inGuild?.() &&
      interaction.guildId === record.guildId &&
      interaction.channelId === record.channelId &&
      (!record.messageId || interaction.message?.id === record.messageId),
  );
}

async function privateReply(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

async function replaceButtonMessage(interaction, content) {
  try {
    await interaction.editReply({
      content,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logError(error, "Could not update a persistent Sukuna button message");
  }
}

async function handleProposalButton(interaction, store, proposalId, decision) {
  if (!["accept", "decline"].includes(decision)) return false;
  if (!interaction.inGuild?.() || !interaction.guildId) {
    await privateReply(interaction, "Use this button in the server where the proposal was made.");
    return true;
  }

  const proposal = store.getMarriageProposal(proposalId);
  if (!proposal) {
    await privateReply(interaction, "This proposal is no longer available.");
    return true;
  }
  if (interaction.user.id !== proposal.recipientId) {
    await privateReply(interaction, "Only the person who received this proposal can respond.");
    return true;
  }
  if (!componentContextMatches(interaction, proposal)) {
    await privateReply(interaction, "This proposal button no longer matches its original message.");
    return true;
  }
  if (proposal.status !== "pending") {
    await privateReply(interaction, "This proposal has already been resolved.");
    return true;
  }
  if (Date.parse(proposal.expiresAt) <= Date.now()) {
    const expired = await store.respondToMarriageProposal(
      proposalId,
      interaction.user.id,
      decision,
    );
    await privateReply(
      interaction,
      expired.reason === "expired"
        ? "This proposal has expired."
        : "This proposal is no longer available.",
    );
    return true;
  }

  const result = await store.respondToMarriageProposal(
    proposalId,
    interaction.user.id,
    decision,
  );

  if (!result.ok) {
    const messages = {
      expired: "This proposal expired before it could be answered.",
      resolved: "This proposal has already been resolved.",
      "already-married": "One of you is already married, so this proposal was closed.",
      unauthorized: "Only the recipient can respond to this proposal.",
      "not-found": "This proposal is no longer available.",
    };
    await replaceButtonMessage(interaction, "This proposal is no longer active.");
    await privateReply(interaction, messages[result.reason] ?? "This proposal could not be resolved.");
    return true;
  }

  const publicMessage =
    decision === "accept"
      ? `<@${proposal.proposerId}> and <@${proposal.recipientId}> are now married!`
      : `<@${proposal.recipientId}> declined the marriage proposal.`;
  await replaceButtonMessage(interaction, publicMessage);
  await privateReply(
    interaction,
    decision === "accept" ? "You accepted the proposal." : "You declined the proposal.",
  );
  return true;
}

async function handleDivorceButton(interaction, store, confirmationId, decision) {
  if (!["confirm", "cancel"].includes(decision)) return false;
  if (!interaction.inGuild?.() || !interaction.guildId) {
    await privateReply(interaction, "Use this button in the server where the prompt was made.");
    return true;
  }

  const confirmation = store.getDivorceConfirmation(confirmationId);
  if (!confirmation) {
    await privateReply(interaction, "This divorce prompt is no longer available.");
    return true;
  }
  if (interaction.user.id !== confirmation.userId) {
    await privateReply(interaction, "Only the person who requested the divorce can respond.");
    return true;
  }
  if (!componentContextMatches(interaction, confirmation)) {
    await privateReply(interaction, "This confirmation button no longer matches its original message.");
    return true;
  }
  if (confirmation.status !== "pending") {
    await privateReply(interaction, "This divorce prompt has already been resolved.");
    return true;
  }
  if (Date.parse(confirmation.expiresAt) <= Date.now()) {
    const expired = await store.resolveDivorceConfirmation(
      confirmationId,
      interaction.user.id,
      decision,
    );
    await privateReply(
      interaction,
      expired.reason === "expired"
        ? "This divorce prompt has expired. Your marriage is unchanged."
        : "This divorce prompt is no longer available.",
    );
    return true;
  }

  const result = await store.resolveDivorceConfirmation(
    confirmationId,
    interaction.user.id,
    decision,
  );
  if (!result.ok) {
    const messages = {
      expired: "This divorce prompt expired. Your marriage is unchanged.",
      resolved: "This divorce prompt has already been resolved.",
      stale: "Your relationship changed before this confirmation; no divorce was made.",
      unauthorized: "Only the person who requested the divorce can respond.",
      "not-found": "This divorce prompt is no longer available.",
    };
    await replaceButtonMessage(interaction, "This divorce prompt is no longer active.");
    await privateReply(interaction, messages[result.reason] ?? "The confirmation could not be completed.");
    return true;
  }

  const publicMessage =
    decision === "confirm"
      ? `<@${confirmation.userId}> and <@${confirmation.spouseId}> are no longer married.`
      : `<@${confirmation.userId}> cancelled the divorce.`;
  await replaceButtonMessage(interaction, publicMessage);
  await privateReply(
    interaction,
    decision === "confirm" ? "The marriage has ended." : "Your marriage is unchanged.",
  );
  return true;
}

export async function handleMarriageButton(interaction, store) {
  if (!interaction.customId?.startsWith("sukuna:marriage:") &&
      !interaction.customId?.startsWith("sukuna:divorce:")) {
    return false;
  }

  await interaction.deferUpdate();

  const [, type, recordId, decision, extra] = interaction.customId.split(":");
  if (!recordId || extra !== undefined) {
    await privateReply(interaction, "This button is invalid or has expired.");
    return true;
  }

  if (type === "marriage") {
    return handleProposalButton(interaction, store, recordId, decision);
  }
  if (type === "divorce") {
    return handleDivorceButton(interaction, store, recordId, decision);
  }
  return false;
}
