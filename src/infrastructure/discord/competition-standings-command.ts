import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import {
  CompetitionStandingsService,
  type CompetitionStandingEntry,
  type CompetitionStandingsResult,
} from '../../features/competitions/competition-standings.js';
import { OSLEADERS_EMBED_COLOR } from './discord-embed-presentation.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-standings';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;
const PAGE_ITEM_LIMIT = 23;
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';

export interface CompetitionStandingsChoices {
  listActive(guildId: string): Promise<readonly { displayName: string; id: string }[]>;
}

interface Session {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export class CompetitionStandingsCommandHandler {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly standings: Pick<CompetitionStandingsService, 'getStandings'>,
    private readonly choices: CompetitionStandingsChoices,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const competitions = await this.choices.listActive(guildId);
    if (competitions.length === 0)
      return failure('There are no active competitions in this server.');
    return this.selection(competitions, guildId, requesterDiscordUserId, 0);
  }

  public async selectCompetition(request: {
    competitionId: string;
    customId: string;
    guildId: string | null;
    requesterDiscordUserId: string;
  }) {
    const decoded = decode(request.customId);
    if (decoded === undefined || request.guildId === null) return invalid();
    const session = this.consume(
      decoded.sessionId,
      request.guildId,
      request.requesterDiscordUserId,
    );
    if (typeof session === 'string') return sessionFailure(session);
    const competitions = await this.choices.listActive(request.guildId);
    if (
      request.competitionId === NEXT_PAGE_VALUE ||
      request.competitionId === PREVIOUS_PAGE_VALUE
    ) {
      return this.selection(
        competitions,
        request.guildId,
        request.requesterDiscordUserId,
        request.competitionId === NEXT_PAGE_VALUE
          ? decoded.page + 1
          : Math.max(0, decoded.page - 1),
      );
    }
    if (!competitions.some((competition) => competition.id === request.competitionId))
      return invalid();
    return this.standings.getStandings({
      competitionId: request.competitionId,
      guildId: request.guildId,
    });
  }

  private selection(
    competitions: readonly { displayName: string; id: string }[],
    guildId: string,
    requesterDiscordUserId: string,
    requestedPage: number,
  ) {
    const pageCount = Math.max(1, Math.ceil(competitions.length / PAGE_ITEM_LIMIT));
    const page = Math.min(requestedPage, pageCount - 1);
    const sessionId = this.create({
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return {
      competitions: competitions.slice(page * PAGE_ITEM_LIMIT, (page + 1) * PAGE_ITEM_LIMIT),
      customId: encode(sessionId, page),
      kind: 'competition_selection' as const,
      page,
      pageCount,
    };
  }

  private create(session: Session): string {
    this.prune();
    while (this.sessions.size >= MAX_PENDING_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomUUID();
    this.sessions.set(id, session);
    return id;
  }

  private consume(
    id: string,
    guildId: string,
    requesterDiscordUserId: string,
  ): Session | 'expired' | 'mismatch' | 'invalid' {
    const session = this.sessions.get(id);
    if (session === undefined) return 'invalid';
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      this.sessions.delete(id);
      return 'expired';
    }
    if (session.guildId !== guildId || session.requesterDiscordUserId !== requesterDiscordUserId)
      return 'mismatch';
    this.sessions.delete(id);
    return session;
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) this.sessions.delete(id);
    }
  }
}

export class DiscordCompetitionStandingsCommandAdapter {
  public constructor(private readonly handler: CompetitionStandingsCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'standings'
      )
        return;
      await interaction.reply({
        ...response(await this.handler.start(interaction.guildId, interaction.user.id)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith(INTERACTION_PREFIX))
      return;
    await interaction.deferUpdate();
    const result = await this.handler.selectCompetition({
      competitionId: interaction.values[0] ?? '',
      customId: interaction.customId,
      guildId: interaction.guildId,
      requesterDiscordUserId: interaction.user.id,
    });
    if (!isStandings(result)) {
      await interaction.editReply(response(result));
      return;
    }
    try {
      await publishStandings(interaction, competitionStandingsEmbeds(result));
      await interaction.deleteReply();
    } catch (error) {
      await interaction.editReply({
        components: [],
        content: 'I could not publish those standings publicly. Please try again.',
      });
      throw error;
    }
  }
}

export function bindDiscordCompetitionStandingsCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordCompetitionStandingsCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !shouldHandleInteraction(interaction) ||
      (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu())
    )
      return;
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

export function competitionStandingsEmbeds(
  result: Extract<CompetitionStandingsResult, { kind: 'standings' }>,
): EmbedBuilder[] {
  const lines = result.entries.map(formatEntry);
  const pages = split(lines, 4_000);
  const metric = `${result.metric.name} ${result.metric.kind === 'skill' ? 'XP' : 'KC'}`;
  const timing =
    result.targetValue === null
      ? result.endsAt === null
        ? 'No deadline'
        : `Ends <t:${Math.floor(result.endsAt.getTime() / 1_000)}:R>`
      : `Target: ${result.targetValue.toLocaleString('en-US')} ${result.metric.kind === 'skill' ? 'XP' : 'KC'}`;
  return pages.map((page, index) =>
    new EmbedBuilder()
      .setColor(OSLEADERS_EMBED_COLOR)
      .setTitle(`Competition standings${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`)
      .setDescription(`**${metric}** - ${timing}\n\n${page}`)
      .setFooter({
        text:
          result.failures.length === 0
            ? 'Current Hiscores values'
            : 'Some entries use their last known value',
      }),
  );
}

function response(result: unknown) {
  if (isSelection(result)) {
    const options = result.competitions.map((competition) => ({
      label: competition.displayName,
      value: competition.id,
    }));
    if (result.page > 0) options.push({ label: 'Previous page', value: PREVIOUS_PAGE_VALUE });
    if (result.page < result.pageCount - 1)
      options.push({ label: 'Next page', value: NEXT_PAGE_VALUE });
    return {
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(result.customId)
            .setPlaceholder('Choose active competition')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options),
        ),
      ],
      content: 'Choose an active competition to view its standings.',
    };
  }
  return {
    components: [],
    content:
      typeof result === 'object' && result !== null && 'message' in result
        ? String(result.message)
        : 'This interaction is no longer valid. Run the command again.',
  };
}

function formatEntry(entry: CompetitionStandingEntry): string {
  const entrant = entry.discordUserId === null ? 'Watchlist account' : `<@${entry.discordUserId}>`;
  const accounts = entry.accounts
    .map(
      (account) =>
        `- **${account.displayUsername}**: ${number(account.startingValue)} -> ${number(account.currentValue)} (**+${number(account.gain)}**)${account.isCurrentValueStale ? ' [last known value]' : ''}`,
    )
    .join('\n');
  return `**#${entry.rank} ${entrant} - +${number(entry.gain)}**${entry.isPotentiallyIncomplete ? ' [score may be incomplete]' : ''}\n${accounts}`;
}

function number(value: bigint): string {
  return value.toLocaleString('en-US');
}
function split(lines: readonly string[], maximum: number): string[] {
  const pages: string[] = [];
  let page = '';
  for (const line of lines) {
    const candidate = page === '' ? line : `${page}\n\n${line}`;
    if (candidate.length > maximum && page !== '') {
      pages.push(page);
      page = line;
    } else page = candidate;
  }
  return page === '' ? ['No entrants are currently participating.'] : [...pages, page];
}
function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This interaction is no longer valid. Run the command again.');
}
function sessionFailure(result: 'expired' | 'mismatch' | 'invalid') {
  return result === 'expired'
    ? failure('This selection expired. Run `/competition standings` again.')
    : result === 'mismatch'
      ? failure('This interaction belongs to another member or server.')
      : invalid();
}
function encode(sessionId: string, page: number): string {
  return `${INTERACTION_PREFIX}:competition:${sessionId}:${page}`;
}
function decode(value: string): { page: number; sessionId: string } | undefined {
  const match = new RegExp(`^${INTERACTION_PREFIX}:competition:([^:]+):(\\d+)$`).exec(value);
  return match?.[1] !== undefined &&
    match[2] !== undefined &&
    Number.isSafeInteger(Number(match[2]))
    ? { page: Number(match[2]), sessionId: match[1] }
    : undefined;
}
function isSelection(result: unknown): result is {
  competitions: readonly { displayName: string; id: string }[];
  customId: string;
  kind: 'competition_selection';
  page: number;
  pageCount: number;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'competition_selection'
  );
}
function isStandings(
  result: unknown,
): result is Extract<CompetitionStandingsResult, { kind: 'standings' }> {
  return (
    typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'standings'
  );
}
async function publishStandings(
  interaction: StringSelectMenuInteraction,
  embeds: readonly EmbedBuilder[],
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable())
    throw new Error('The competition standings channel is not available for public results.');
  for (let index = 0; index < embeds.length; index += 10)
    await channel.send({ embeds: embeds.slice(index, index + 10) });
}
