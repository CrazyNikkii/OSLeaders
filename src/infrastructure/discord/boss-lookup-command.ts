import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import { AccountRetrievalService } from '../../features/accounts/account-retrieval.js';
import { BossLookupService, type BossLookupResult } from '../../features/lookups/boss-lookup.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  type OsrsAccountMode,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';

const BOSS_COMMAND_NAME = 'boss';
const BOSS_OPTION_NAME = 'boss';
const ACCOUNT_OPTION_NAME = 'account';
const MAX_AUTOCOMPLETE_CHOICES = 25;

export const bossLookupCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(BOSS_COMMAND_NAME)
    .setDescription('Look up an OSRS boss kill count for a tracked account.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(BOSS_OPTION_NAME)
        .setDescription('The boss to look up.')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName(ACCOUNT_OPTION_NAME)
        .setDescription('A tracked account; defaults to your default account.')
        .setAutocomplete(true),
    )
    .toJSON(),
] as const;

export interface BossLookupCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  bossLookup: Pick<BossLookupService, 'lookup'>;
}

export class BossLookupCommandHandler {
  public constructor(private readonly services: BossLookupCommandServices) {}

  public async autocomplete(
    guildId: string | null,
    optionName: string,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    if (optionName === BOSS_OPTION_NAME) {
      return OSRS_BOSS_ACTIVITY_NAMES.filter((boss) =>
        boss.toLocaleLowerCase('en-US').includes(normalizedQuery),
      )
        .slice(0, MAX_AUTOCOMPLETE_CHOICES)
        .map((boss) => ({ name: boss, value: boss }));
    }
    if (optionName !== ACCOUNT_OPTION_NAME || guildId === null) {
      return [];
    }

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
    boss: string,
    accountId: string | null,
  ): Promise<BossLookupResult | { kind: 'invalid_boss' | 'not_in_guild' }> {
    if (guildId === null) {
      return Promise.resolve({ kind: 'not_in_guild' });
    }
    if (!isOsrsBossActivityName(boss)) {
      return Promise.resolve({ kind: 'invalid_boss' });
    }

    return this.services.bossLookup.lookup({
      boss,
      guildId,
      requesterDiscordUserId,
      target:
        accountId === null ? { kind: 'default_account' } : { accountId, kind: 'tracked_account' },
    });
  }
}

export class DiscordBossLookupCommandAdapter {
  public constructor(private readonly handler: BossLookupCommandHandler) {}

  public async handle(
    interaction: AutocompleteInteraction | ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName !== BOSS_COMMAND_NAME) {
      return;
    }
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      await interaction.respond(
        await this.handler.autocomplete(interaction.guildId, focused.name, focused.value),
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.handler.lookup(
      interaction.guildId,
      interaction.user.id,
      interaction.options.getString(BOSS_OPTION_NAME, true),
      interaction.options.getString(ACCOUNT_OPTION_NAME),
    );
    if (result.kind === 'not_in_guild') {
      await interaction.editReply({
        content: 'This command can only be used in a Discord server.',
      });
      return;
    }
    if (result.kind === 'invalid_boss') {
      await interaction.editReply({
        content: 'Choose a boss from the autocomplete suggestions.',
      });
      return;
    }
    if (result.kind === 'found') {
      try {
        await publishBossLookupResult(interaction, bossLookupEmbed(result));
      } catch (error) {
        await interaction.editReply({
          content: 'I could not publish that result publicly. Please try again.',
        });
        throw error;
      }
      await interaction.deleteReply();
      return;
    }

    await interaction.editReply({
      content: bossLookupFailureMessage(result),
    });
  }
}

async function publishBossLookupResult(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    throw new Error('The boss lookup channel is not available for public results.');
  }
  await channel.send({ embeds: [embed] });
}

export function bindDiscordBossLookupCommandAdapter(
  client: Client,
  adapter: DiscordBossLookupCommandAdapter,
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

export function createBossLookupCommandHandler(
  accountRetrieval: ConstructorParameters<typeof AccountRetrievalService>[0],
  bossLookup: Pick<BossLookupService, 'lookup'>,
): BossLookupCommandHandler {
  return new BossLookupCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRetrieval),
    bossLookup,
  });
}

export function bossLookupEmbed(
  result: Extract<BossLookupResult, { kind: 'found' }>,
): EmbedBuilder {
  const target = result.target.kind === 'tracked_account' ? result.target.account : result.target;
  return new EmbedBuilder()
    .setTitle(`${result.boss.name}: ${target.displayUsername}`)
    .addFields(
      { inline: true, name: 'Kill count', value: result.boss.score.toLocaleString('en-US') },
      { inline: true, name: 'Rank', value: formatRank(result.boss.rank) },
      { inline: true, name: 'Mode', value: accountModeLabel(target.accountMode) },
    );
}

export function bossLookupFailureMessage(
  result: Exclude<BossLookupResult, { kind: 'found' }> | { kind: 'invalid_boss' | 'not_in_guild' },
): string {
  switch (result.kind) {
    case 'not_in_guild':
      return 'This command can only be used in a Discord server.';
    case 'invalid_boss':
      return 'Choose a boss from the autocomplete suggestions.';
    case 'default_account_not_found':
      return 'You do not have a default linked account in this server.';
    case 'account_not_found':
      return 'That tracked account is no longer available in this server.';
    case 'hiscores_failure':
      return 'Hiscores could not provide a complete result for that account right now.';
  }
}

function isOsrsBossActivityName(value: string): value is OsrsBossActivityName {
  return OSRS_BOSS_ACTIVITY_NAMES.includes(value as OsrsBossActivityName);
}

function formatRank(rank: number): string {
  return rank === -1 ? 'Unranked' : rank.toLocaleString('en-US');
}

function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
