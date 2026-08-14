import { randomUUID } from 'node:crypto';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import type { ManualDailyRecapSendService } from '../../features/recaps/send-daily-recap.js';
import type { DailyRecapDeliveryService } from '../../features/recaps/deliver-daily-recap.js';
import type {
  GuildPermissionRequest,
  GuildPermissions,
} from '../../features/guild-configuration/guild-permission-service.js';

const CONFIRMATION_LIFETIME_MS = 5 * 60 * 1_000;
const CONFIRMATION_PREFIX = 'daily-recap-send-confirm';
const MAX_PENDING_CONFIRMATIONS = 1_000;

export interface Clock {
  now(): Date;
}

export interface ManualDailyRecapSendPermissionEvaluator {
  evaluate(request: GuildPermissionRequest): Promise<GuildPermissions>;
}

interface Confirmation {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export class DiscordManualDailyRecapSendCommandAdapter {
  private readonly confirmations = new Map<string, Confirmation>();

  public constructor(
    private readonly manualSend: Pick<ManualDailyRecapSendService, 'send'>,
    private readonly delivery: Pick<DailyRecapDeliveryService, 'deliver' | 'recover'>,
    private readonly permissions: ManualDailyRecapSendPermissionEvaluator,
    private readonly clock: Clock = systemClock,
  ) {}

  public async handle(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
      return;
    }
    await this.handleConfirmation(interaction);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== 'recap' || interaction.options.getSubcommand() !== 'send') {
      return;
    }
    const authorization = await this.authorize(interaction);
    if (authorization === undefined) {
      await interaction.reply({
        content: 'This command can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!authorization.canManageAccounts) {
      await interaction.reply({
        content:
          'You need Discord Administrator permission or the bot-manager role to send a recap.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const confirmationId = this.createConfirmation(authorization.guildId, interaction.user.id);
    await interaction.reply({
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${CONFIRMATION_PREFIX}:${confirmationId}`)
            .setLabel('Send daily recap')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      content: 'Prepare and advance the daily recap baselines? This cannot be undone.',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleConfirmation(interaction: ButtonInteraction): Promise<void> {
    const confirmationId = decodeConfirmation(interaction.customId);
    if (confirmationId === undefined) {
      return;
    }
    const authorization = await this.authorize(interaction);
    if (authorization === undefined) {
      await interaction.reply({
        content: 'This confirmation can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!authorization.canManageAccounts) {
      await interaction.reply({
        content:
          'You need Discord Administrator permission or the bot-manager role to send a recap.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const confirmation = this.consumeConfirmation(
      confirmationId,
      authorization.guildId,
      interaction.user.id,
    );
    if (confirmation === 'expired') {
      await interaction.reply({
        content: 'This recap-send confirmation has expired. Run `/recap send` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (confirmation !== 'confirmed') {
      await interaction.reply({
        content: 'You are not allowed to use this recap-send confirmation.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();
    const recovered = await this.delivery.recover(authorization.guildId);
    if (recovered.kind !== 'no_recoverable_delivery') {
      await interaction.editReply({ components: [], content: recoveryMessage(recovered) });
      return;
    }
    const result = await this.manualSend.send(authorization.guildId);
    const delivery =
      result.kind === 'ready_for_delivery'
        ? await this.delivery.deliver(authorization.guildId, result.recapRunId)
        : undefined;
    await interaction.editReply({ components: [], content: resultMessage(result, delivery) });
  }

  private async authorize(
    interaction: ButtonInteraction | ChatInputCommandInteraction,
  ): Promise<(GuildPermissionRequest & { canManageAccounts: boolean }) | undefined> {
    if (interaction.guildId === null) {
      return undefined;
    }
    const request: GuildPermissionRequest = {
      guildId: interaction.guildId,
      hasAdministratorPermission:
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
      memberRoleIds: memberRoleIds(interaction),
    };
    const permissions = await this.permissions.evaluate(request);
    return { ...request, canManageAccounts: permissions.canManageAccounts };
  }

  private createConfirmation(guildId: string, requesterDiscordUserId: string): string {
    this.pruneExpired();
    while (this.confirmations.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = this.confirmations.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.confirmations.delete(oldest);
    }
    const confirmationId = randomUUID();
    this.confirmations.set(confirmationId, {
      expiresAt: new Date(this.clock.now().getTime() + CONFIRMATION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return confirmationId;
  }

  private consumeConfirmation(
    confirmationId: string,
    guildId: string,
    requesterDiscordUserId: string,
  ): 'confirmed' | 'expired' | 'forbidden' {
    const confirmation = this.confirmations.get(confirmationId);
    if (confirmation === undefined) {
      return 'forbidden';
    }
    if (confirmation.expiresAt.getTime() <= this.clock.now().getTime()) {
      this.confirmations.delete(confirmationId);
      return 'expired';
    }
    if (
      confirmation.guildId !== guildId ||
      confirmation.requesterDiscordUserId !== requesterDiscordUserId
    ) {
      return 'forbidden';
    }
    this.confirmations.delete(confirmationId);
    return 'confirmed';
  }

  private pruneExpired(): void {
    const now = this.clock.now().getTime();
    for (const [id, confirmation] of this.confirmations) {
      if (confirmation.expiresAt.getTime() <= now) {
        this.confirmations.delete(id);
      }
    }
  }
}

export function bindDiscordManualDailyRecapSendCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordManualDailyRecapSendCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !shouldHandleInteraction(interaction) ||
      (!interaction.isButton() && !interaction.isChatInputCommand())
    ) {
      return;
    }
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

function decodeConfirmation(customId: string): string | undefined {
  const prefix = `${CONFIRMATION_PREFIX}:`;
  if (!customId.startsWith(prefix)) {
    return undefined;
  }
  const confirmationId = customId.slice(prefix.length);
  return confirmationId.length > 0 && !confirmationId.includes(':') ? confirmationId : undefined;
}

function memberRoleIds(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): readonly string[] {
  const roles = interaction.member?.roles;
  if (roles === undefined) {
    return [];
  }
  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

function resultMessage(
  result: Awaited<ReturnType<ManualDailyRecapSendService['send']>>,
  delivery: Awaited<ReturnType<DailyRecapDeliveryService['deliver']>> | undefined,
): string {
  switch (result.kind) {
    case 'ready_for_delivery':
      if (delivery?.kind === 'delivered') {
        return `Daily recap was delivered to <#${result.recapChannelId}>.`;
      }
      if (delivery?.kind === 'delivery_failed') {
        return `Daily recap was collected, but delivery to <#${result.recapChannelId}> failed. It was recorded for recovery.`;
      }
      return 'Daily recap delivery was already being handled. Check the recap channel before sending again.';
    case 'recap_not_configured':
      return 'A daily recap channel has not been configured for this server.';
    case 'recap_already_running':
      return 'Another daily recap collection or pending delivery is already in progress.';
  }
}

function recoveryMessage(
  result: Exclude<
    Awaited<ReturnType<DailyRecapDeliveryService['recover']>>,
    { kind: 'no_recoverable_delivery' }
  >,
): string {
  switch (result.kind) {
    case 'delivered':
      return 'A previously pending daily recap was delivered. No new recap was collected.';
    case 'delivery_failed':
      return 'A previously pending daily recap could not be delivered. It remains queued for recovery.';
    case 'delivery_not_pending':
      return 'A previously pending daily recap is already being handled. Check the recap channel before sending again.';
  }
}

const systemClock: Clock = { now: () => new Date() };
