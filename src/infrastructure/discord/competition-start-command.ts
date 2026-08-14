import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import {
  CompetitionStartService,
  type CompetitionStartResult,
} from '../../features/competitions/start-competition.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-start';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;
const MAX_SELECT_OPTIONS = 25;
const PAGE_ITEM_LIMIT = MAX_SELECT_OPTIONS - 2;
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';

export interface CompetitionStartChoices {
  listStartable(guildId: string): Promise<readonly { id: string; displayName: string }[]>;
}

interface Session {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export class InMemoryCompetitionStartSessionStore {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maximumPendingSessions = MAX_PENDING_SESSIONS,
  ) {}

  public create(session: Session): string {
    this.prune();
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomUUID();
    this.sessions.set(id, session);
    return id;
  }

  public consume(
    id: string,
    guildId: string,
    requesterDiscordUserId: string,
  ): Session | 'expired' | 'mismatch' | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      this.sessions.delete(id);
      return 'expired';
    }
    if (session.guildId !== guildId || session.requesterDiscordUserId !== requesterDiscordUserId) {
      return 'mismatch';
    }
    this.sessions.delete(id);
    return session;
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) this.sessions.delete(id);
    }
  }
}

export class CompetitionStartCommandHandler {
  public constructor(
    private readonly competitions: Pick<CompetitionStartService, 'start'>,
    private readonly choices: CompetitionStartChoices,
    private readonly sessions = new InMemoryCompetitionStartSessionStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const competitions = await this.choices.listStartable(guildId);
    if (competitions.length === 0)
      return failure('There are no competition drafts or pending starts in this server.');
    const sessionId = this.sessions.create({
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return selection(sessionId, competitions, 0);
  }

  public async selectCompetition(request: {
    competitionId: string;
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }) {
    const decoded = decode(request.customId);
    if (decoded === undefined || request.guildId === null) return invalid();
    const nextPage = nextPageFor(request.customId, request.competitionId);
    if (nextPage !== undefined) {
      const session = this.sessions.consume(
        decoded.sessionId,
        request.guildId,
        request.requesterDiscordUserId,
      );
      if (typeof session !== 'object') return sessionFailure(session);
      const competitions = await this.choices.listStartable(request.guildId);
      const replacementSessionId = this.sessions.create(session);
      return selection(replacementSessionId, competitions, nextPage);
    }
    const session = this.sessions.consume(
      decoded.sessionId,
      request.guildId,
      request.requesterDiscordUserId,
    );
    if (typeof session !== 'object') return sessionFailure(session);
    const competitions = await this.choices.listStartable(request.guildId);
    if (!competitions.some((competition) => competition.id === request.competitionId))
      return invalid();
    return startResult(
      await this.competitions.start({
        competitionId: request.competitionId,
        guildId: request.guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
      }),
    );
  }
}

export class DiscordCompetitionStartCommandAdapter {
  public constructor(private readonly handler: CompetitionStartCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'start'
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
    await interaction.editReply(
      response(
        await this.handler.selectCompetition({
          competitionId: interaction.values[0] ?? '',
          customId: interaction.customId,
          guildId: interaction.guildId,
          hasAdministratorPermission:
            interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
          memberRoleIds: memberRoleIds(interaction),
          requesterDiscordUserId: interaction.user.id,
        }),
      ),
    );
  }
}

export function bindDiscordCompetitionStartCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordCompetitionStartCommandAdapter,
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

function selection(
  sessionId: string,
  competitions: readonly { id: string; displayName: string }[],
  page: number,
) {
  const paging = pageSlice(competitions, page);
  return {
    competitions: paging.items,
    customId: encode(sessionId, paging.page),
    kind: 'competition_selection' as const,
    page: paging.page,
    pageCount: paging.pageCount,
  };
}

function response(result: unknown) {
  if (isSelection(result)) {
    return {
      components: [
        menu(
          result.customId,
          'Choose a competition to start',
          pagedOptions(
            result.competitions.map((competition) => ({
              label: competition.displayName,
              value: competition.id,
            })),
            result.page,
            result.pageCount,
          ),
        ),
      ],
      content: 'Choose a competition to start.',
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

function startResult(result: CompetitionStartResult) {
  switch (result.kind) {
    case 'started':
      return failure('Competition started.');
    case 'start_pending':
      return failure(
        `Competition start is pending because starting values could not be fetched for: ${result.failures
          .map((failure) => `**${failure.account.displayUsername}**`)
          .join(', ')}.`,
      );
    case 'competition_not_found':
      return failure('That competition no longer exists in this server.');
    case 'forbidden':
      return failure('Only the competition creator or a competition manager can start it.');
    case 'no_entrants':
      return failure(
        'A competition needs at least one selected contributing account before it can start.',
      );
    case 'start_locked':
      return failure('This competition has already started or can no longer be started.');
  }
}

function failure(message: string) {
  return { kind: 'failed' as const, message };
}

function invalid() {
  return failure('This interaction is no longer valid. Run the command again.');
}

function sessionFailure(result: 'expired' | 'mismatch' | undefined) {
  if (result === 'expired')
    return failure('This selection expired. Run `/competition start` again.');
  if (result === 'mismatch')
    return failure('This interaction belongs to another member or server.');
  return invalid();
}

function menu(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string }[],
) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([...options]),
  );
}

function memberRoleIds(interaction: StringSelectMenuInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined || Array.isArray(roles) ? (roles ?? []) : [...roles.cache.keys()];
}

function encode(sessionId: string, page: number): string {
  return `${INTERACTION_PREFIX}:competition:${sessionId}:${page}`;
}

function decode(value: string): { page: number; sessionId: string } | undefined {
  const match = new RegExp(`^${INTERACTION_PREFIX}:competition:([^:]+):(\\d+)$`).exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const page = Number(match[2]);
  return Number.isSafeInteger(page) && page >= 0 ? { page, sessionId: match[1] } : undefined;
}

function nextPageFor(customId: string, value: string): number | undefined {
  const decoded = decode(customId);
  if (decoded === undefined) return undefined;
  if (value === NEXT_PAGE_VALUE) return decoded.page + 1;
  if (value === PREVIOUS_PAGE_VALUE) return Math.max(0, decoded.page - 1);
  return undefined;
}

function pageSlice<T>(items: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_ITEM_LIMIT));
  const page = Math.min(requestedPage, pageCount - 1);
  return {
    items: items.slice(page * PAGE_ITEM_LIMIT, (page + 1) * PAGE_ITEM_LIMIT),
    page,
    pageCount,
  };
}

function pagedOptions(
  options: readonly { label: string; value: string }[],
  page: number,
  pageCount: number,
) {
  const navigation: { label: string; value: string }[] = [];
  if (page > 0) navigation.push({ label: 'Previous page', value: PREVIOUS_PAGE_VALUE });
  if (page < pageCount - 1) navigation.push({ label: 'Next page', value: NEXT_PAGE_VALUE });
  return [...options, ...navigation];
}

function isSelection(result: unknown): result is {
  competitions: readonly { id: string; displayName: string }[];
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
