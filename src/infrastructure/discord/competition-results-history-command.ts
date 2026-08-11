import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  CompetitionResultsHistoryService,
  type CompetitionResultsHistoryResult,
  type FinishedCompetitionResultEntry,
} from '../../features/competitions/competition-results-history.js';
import { accountModeLabel, OSLEADERS_EMBED_COLOR } from './discord-embed-presentation.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-results-history';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;
const PAGE_ITEM_LIMIT = 23;
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';

interface Session {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export class CompetitionResultsHistoryCommandHandler {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly history: Pick<
      CompetitionResultsHistoryService,
      'getFinishedResult' | 'listFinished'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const competitions = await this.history.listFinished(guildId);
    if (competitions.length === 0)
      return failure('There are no finished competitions in this server yet.');
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
    const competitions = await this.history.listFinished(request.guildId);
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
    return this.history.getFinishedResult({
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

export class DiscordCompetitionResultsHistoryCommandAdapter {
  public constructor(private readonly handler: CompetitionResultsHistoryCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'history'
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
    if (isCancelledResult(result)) {
      await interaction.editReply({ components: [], embeds: [cancelledHistoryEmbed(result)] });
      return;
    }
    if (!isFinishedResult(result)) {
      await interaction.editReply(response(result));
      return;
    }
    try {
      await publishResults(interaction, competitionResultsHistoryEmbeds(result));
      await interaction.deleteReply();
    } catch (error) {
      await interaction.editReply({
        components: [],
        content: 'I could not publish those competition results publicly. Please try again.',
      });
      throw error;
    }
  }
}

export function bindDiscordCompetitionResultsHistoryCommandAdapter(
  client: Client,
  adapter: DiscordCompetitionResultsHistoryCommandAdapter,
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

export function competitionResultsHistoryEmbeds(
  result: Extract<CompetitionResultsHistoryResult, { kind: 'finished_result' }>,
): EmbedBuilder[] {
  const lines = result.entries.map(formatEntry);
  const pages = split(lines, 4_000);
  const metric = `${result.metric.name} ${result.metric.kind === 'skill' ? 'XP' : 'KC'}`;
  const timing =
    result.finishedAt === null
      ? 'Finished'
      : `Finished <t:${Math.floor(result.finishedAt.getTime() / 1_000)}:R>`;
  return pages.map((page, index) =>
    (() => {
      const pageSuffix = pages.length > 1 ? ` (${index + 1}/${pages.length})` : '';
      return new EmbedBuilder()
        .setColor(OSLEADERS_EMBED_COLOR)
        .setTitle(competitionResultsHistoryTitle(result.displayName, pageSuffix))
        .setDescription(
          `**${metric}**${result.targetValue === null ? '' : ` - Target: ${number(result.targetValue)}`}\n${timing}\n\n${page}`,
        )
        .setFooter({
          text: result.isResultDelayed
            ? 'Final values were collected after the deadline'
            : 'Final competition results',
        });
    })(),
  );
}

function response(result: unknown) {
  if (isSelection(result)) {
    const options = result.competitions.map((competition) => ({
      label: competitionResultsHistoryChoiceLabel(competition.displayName),
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
            .setPlaceholder('Choose finished competition')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options),
        ),
      ],
      content: 'Choose a finished competition to view its results.',
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

function formatEntry(entry: FinishedCompetitionResultEntry): string {
  const entrant = entry.discordUserId === null ? 'Watchlist account' : `<@${entry.discordUserId}>`;
  const heading = entry.rank === null ? entrant : `#${entry.rank} ${entrant}`;
  const gain = entry.finalGain === null ? 'Final value unavailable' : `+${number(entry.finalGain)}`;
  const accounts = entry.accounts
    .map((account) => {
      if (account.finalValue === null)
        return `- **${account.displayUsername}** (${accountModeLabel(account.accountMode)}): final value unavailable`;
      return `- **${account.displayUsername}** (${accountModeLabel(account.accountMode)}): ${number(account.startingValue)} -> ${number(account.finalValue)} (**+${number(account.gain ?? 0n)}**)`;
    })
    .join('\n');
  return `**${entry.isWinner ? 'Winner - ' : ''}${heading} - ${gain}**\n${accounts}`;
}

function number(value: bigint): string {
  return value.toLocaleString('en-US');
}
export function competitionResultsHistoryChoiceLabel(displayName: string): string {
  return truncate(displayName, 100);
}
export function competitionResultsHistoryTitle(displayName: string, pageSuffix = ''): string {
  const titleSuffix = ` results${pageSuffix}`;
  return `${truncate(displayName, 256 - titleSuffix.length)}${titleSuffix}`;
}
function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
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
  return page === '' ? ['No entrants participated in this competition.'] : [...pages, page];
}
function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This interaction is no longer valid. Run the command again.');
}
function sessionFailure(result: 'expired' | 'mismatch' | 'invalid') {
  return result === 'expired'
    ? failure('This selection expired. Run `/competition history` again.')
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
function isFinishedResult(
  result: unknown,
): result is Extract<CompetitionResultsHistoryResult, { kind: 'finished_result' }> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'finished_result'
  );
}
function isCancelledResult(
  result: unknown,
): result is Extract<CompetitionResultsHistoryResult, { kind: 'cancelled_result' }> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'cancelled_result'
  );
}
function cancelledHistoryEmbed(
  result: Extract<CompetitionResultsHistoryResult, { kind: 'cancelled_result' }>,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(OSLEADERS_EMBED_COLOR)
    .setTitle(`${competitionResultsHistoryChoiceLabel(result.displayName)} cancelled`)
    .setDescription(
      `Cancelled <t:${Math.floor(result.cancelledAt.getTime() / 1_000)}:R>. No final results were recorded.`,
    );
}
async function publishResults(
  interaction: StringSelectMenuInteraction,
  embeds: readonly EmbedBuilder[],
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable())
    throw new Error('The competition results channel is not available for public results.');
  for (let index = 0; index < embeds.length; index += 10)
    await channel.send({ embeds: embeds.slice(index, index + 10) });
}
