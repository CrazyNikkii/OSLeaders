import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import { AccountRetrievalService } from '../../features/accounts/account-retrieval.js';
import { SkillLookupService, type SkillLookupResult } from '../../features/lookups/skill-lookup.js';
import { OSRS_SKILL_NAMES, type OsrsSkillName } from '../hiscores/osrs-hiscore-catalog.js';
import {
  accountModeLabel,
  formatHiscoreRank,
  OSLEADERS_EMBED_COLOR,
} from './discord-embed-presentation.js';

const SKILL_COMMAND_NAME = 'skill';
const SKILL_OPTION_NAME = 'skill';
const ACCOUNT_OPTION_NAME = 'account';
const MAX_AUTOCOMPLETE_CHOICES = 25;

export const skillLookupCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(SKILL_COMMAND_NAME)
    .setDescription('Look up an OSRS skill for a tracked account.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(SKILL_OPTION_NAME)
        .setDescription('The skill to look up.')
        .setRequired(true)
        .addChoices(...OSRS_SKILL_NAMES.map((skill) => ({ name: skill, value: skill }))),
    )
    .addStringOption((option) =>
      option
        .setName(ACCOUNT_OPTION_NAME)
        .setDescription('A tracked account; defaults to your default account.')
        .setAutocomplete(true),
    )
    .toJSON(),
] as const;

export interface SkillLookupCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  skillLookup: Pick<SkillLookupService, 'lookup'>;
}

export class SkillLookupCommandHandler {
  public constructor(private readonly services: SkillLookupCommandServices) {}

  public async autocomplete(
    guildId: string | null,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    if (guildId === null) {
      return [];
    }

    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const accounts = await this.services.accountRetrieval.listForGuild(guildId);
    return accounts
      .filter((account) =>
        account.displayUsername.toLocaleLowerCase('en-US').includes(normalizedQuery),
      )
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((account) => ({
        name: `${account.displayUsername} (${account.accountMode})`,
        value: account.id,
      }));
  }

  public lookup(
    guildId: string | null,
    requesterDiscordUserId: string,
    skill: OsrsSkillName,
    accountId: string | null,
  ): Promise<SkillLookupResult | { kind: 'not_in_guild' }> {
    if (guildId === null) {
      return Promise.resolve({ kind: 'not_in_guild' });
    }

    return this.services.skillLookup.lookup({
      guildId,
      requesterDiscordUserId,
      skill,
      target:
        accountId === null ? { kind: 'default_account' } : { accountId, kind: 'tracked_account' },
    });
  }
}

export class DiscordSkillLookupCommandAdapter {
  public constructor(private readonly handler: SkillLookupCommandHandler) {}

  public async handle(
    interaction: AutocompleteInteraction | ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName !== SKILL_COMMAND_NAME) {
      return;
    }
    if (interaction.isAutocomplete()) {
      if (interaction.options.getFocused(true).name !== ACCOUNT_OPTION_NAME) {
        return;
      }
      await interaction.respond(
        await this.handler.autocomplete(interaction.guildId, interaction.options.getFocused()),
      );
      return;
    }

    const result = await this.handler.lookup(
      interaction.guildId,
      interaction.user.id,
      interaction.options.getString(SKILL_OPTION_NAME, true) as OsrsSkillName,
      interaction.options.getString(ACCOUNT_OPTION_NAME),
    );
    if (result.kind === 'not_in_guild') {
      await interaction.reply({
        content: 'This command can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.kind === 'found') {
      await interaction.reply({ embeds: [skillLookupEmbed(result)] });
      return;
    }

    await interaction.reply({
      content: skillLookupFailureMessage(result),
      flags: MessageFlags.Ephemeral,
    });
  }
}

export function bindDiscordSkillLookupCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordSkillLookupCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction)) {
      return;
    }
    if (interaction.isAutocomplete() || interaction.isChatInputCommand()) {
      void adapter.handle(interaction).catch(reportUnexpectedError);
    }
  });
}

export function createSkillLookupCommandHandler(
  accountRetrieval: ConstructorParameters<typeof AccountRetrievalService>[0],
  skillLookup: Pick<SkillLookupService, 'lookup'>,
): SkillLookupCommandHandler {
  return new SkillLookupCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRetrieval),
    skillLookup,
  });
}

export function skillLookupEmbed(
  result: Extract<SkillLookupResult, { kind: 'found' }>,
): EmbedBuilder {
  const target = result.target.kind === 'tracked_account' ? result.target.account : result.target;
  return new EmbedBuilder()
    .setColor(OSLEADERS_EMBED_COLOR)
    .setDescription(lookupTargetDescription(result))
    .setFooter({ text: 'OSRS Hiscores' })
    .setTitle(`${result.skill.name} · ${target.displayUsername}`)
    .addFields(
      { inline: true, name: 'Level', value: String(result.skill.level) },
      {
        inline: true,
        name: 'Experience',
        value: `${result.skill.experience.toLocaleString('en-US')} XP`,
      },
      { inline: true, name: 'Rank', value: formatHiscoreRank(result.skill.rank) },
    );
}

export function skillLookupFailureMessage(
  result: Exclude<SkillLookupResult, { kind: 'found' }>,
): string {
  switch (result.kind) {
    case 'default_account_not_found':
      return 'You do not have a default linked account in this server.';
    case 'account_not_found':
      return 'That tracked account is no longer available in this server.';
    case 'hiscores_failure':
      return 'Hiscores could not provide a complete result for that account right now.';
  }
}

function lookupTargetDescription(result: Extract<SkillLookupResult, { kind: 'found' }>): string {
  if (result.target.kind === 'one_time_account') {
    return `**${accountModeLabel(result.target.accountMode)}** · One-time lookup`;
  }
  const account = result.target.account;
  const association =
    account.association.type === 'linked'
      ? `<@${account.association.discordUserId}>`
      : 'Watchlist account';
  return `**${accountModeLabel(account.accountMode)}** · ${association}`;
}
