import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import type { ScheduleCompetitionResult } from '../../features/competitions/schedule-competition.js';
import { CompetitionSchedulingService } from '../../features/competitions/schedule-competition.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-schedule';
const DATE_TIME_INPUT_ID = 'local-date-time';
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';
const PAGE_ITEM_LIMIT = 23;
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;

export interface CompetitionScheduleChoices {
  listDrafts(guildId: string): Promise<readonly { displayName: string; id: string }[]>;
}

interface Session {
  competitionId?: string;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export class CompetitionScheduleCommandHandler {
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly competitions: CompetitionSchedulingService,
    private readonly choices: CompetitionScheduleChoices,
    private readonly now: () => Date = () => new Date(),
    private readonly maximumPendingSessions = MAX_PENDING_SESSIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingSessions) || maximumPendingSessions < 1)
      throw new Error('maximumPendingSessions must be a positive safe integer.');
  }

  public async start(guildId: string | null, requesterDiscordUserId: string) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const drafts = await this.choices.listDrafts(guildId);
    if (drafts.length === 0) return failure('There are no draft competitions to schedule.');
    return this.selection(drafts, guildId, requesterDiscordUserId, 0);
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
    const drafts = await this.choices.listDrafts(request.guildId);
    if (
      request.competitionId === NEXT_PAGE_VALUE ||
      request.competitionId === PREVIOUS_PAGE_VALUE
    ) {
      return this.selection(
        drafts,
        request.guildId,
        request.requesterDiscordUserId,
        request.competitionId === NEXT_PAGE_VALUE
          ? decoded.page + 1
          : Math.max(0, decoded.page - 1),
      );
    }
    if (!drafts.some((draft) => draft.id === request.competitionId)) return invalid();
    const modalSessionId = this.create({
      competitionId: request.competitionId,
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    return {
      customId: encodeModal(modalSessionId),
      kind: 'date_time_required' as const,
    };
  }

  public async submitDateTime(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    localDateTime: string;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<ScheduleCompetitionResult | { kind: 'failed'; message: string }> {
    const decoded = decodeModal(request.customId);
    if (decoded === undefined || request.guildId === null) return invalid();
    const session = this.consume(
      decoded.sessionId,
      request.guildId,
      request.requesterDiscordUserId,
    );
    if (typeof session === 'string') return sessionFailure(session);
    if (session.competitionId === undefined) return invalid();
    return this.competitions.schedule({
      competitionId: session.competitionId,
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      localDateTime: request.localDateTime,
      memberRoleIds: request.memberRoleIds,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
  }

  private selection(
    drafts: readonly { displayName: string; id: string }[],
    guildId: string,
    requesterDiscordUserId: string,
    requestedPage: number,
  ) {
    const pageCount = Math.max(1, Math.ceil(drafts.length / PAGE_ITEM_LIMIT));
    const page = Math.min(requestedPage, pageCount - 1);
    const sessionId = this.create({
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return {
      competitions: drafts.slice(page * PAGE_ITEM_LIMIT, (page + 1) * PAGE_ITEM_LIMIT),
      customId: encode(sessionId, page),
      kind: 'competition_selection' as const,
      page,
      pageCount,
    };
  }

  private create(session: Session): string {
    this.prune();
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  private consume(
    sessionId: string,
    guildId: string,
    requesterDiscordUserId: string,
  ): Session | 'expired' | 'mismatch' | 'invalid' {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return 'invalid';
    this.sessions.delete(sessionId);
    if (session.expiresAt.getTime() <= this.now().getTime()) return 'expired';
    return session.guildId === guildId && session.requesterDiscordUserId === requesterDiscordUserId
      ? session
      : 'mismatch';
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) this.sessions.delete(id);
    }
  }
}

export class DiscordCompetitionScheduleCommandAdapter {
  public constructor(private readonly handler: CompetitionScheduleCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'schedule'
      )
        return;
      await interaction.reply({
        ...response(await this.handler.start(interaction.guildId, interaction.user.id)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.isStringSelectMenu()) {
      if (!interaction.customId.startsWith(`${INTERACTION_PREFIX}:competition:`)) return;
      const result = await this.handler.selectCompetition({
        competitionId: interaction.values[0] ?? '',
        customId: interaction.customId,
        guildId: interaction.guildId,
        requesterDiscordUserId: interaction.user.id,
      });
      if (result.kind === 'date_time_required') {
        await interaction.showModal(dateTimeModal(result.customId));
      } else {
        await interaction.update(response(result));
      }
      return;
    }
    if (
      !interaction.isModalSubmit() ||
      !interaction.customId.startsWith(`${INTERACTION_PREFIX}:time:`)
    )
      return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(
      response(
        await this.handler.submitDateTime({
          customId: interaction.customId,
          guildId: interaction.guildId,
          hasAdministratorPermission:
            interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
          localDateTime: interaction.fields.getTextInputValue(DATE_TIME_INPUT_ID),
          memberRoleIds: memberRoleIds(interaction),
          requesterDiscordUserId: interaction.user.id,
        }),
      ),
    );
  }
}

export function bindDiscordCompetitionScheduleCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordCompetitionScheduleCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !shouldHandleInteraction(interaction) ||
      (!interaction.isChatInputCommand() &&
        !interaction.isStringSelectMenu() &&
        !interaction.isModalSubmit())
    )
      return;
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

function response(result: unknown) {
  if (isSelection(result))
    return { content: 'Choose a draft competition to schedule.', components: [menu(result)] };
  const message =
    typeof result === 'object' && result !== null && 'kind' in result
      ? messageFor(result as { kind: string; intendedStartAt?: Date })
      : undefined;
  return {
    components: [],
    content: message ?? 'This interaction is no longer valid. Run the command again.',
  };
}

function messageFor(result: { kind: string; intendedStartAt?: Date }): string | undefined {
  switch (result.kind) {
    case 'scheduled':
      return `Competition scheduled for <t:${Math.floor(result.intendedStartAt!.getTime() / 1_000)}:F> (<t:${Math.floor(result.intendedStartAt!.getTime() / 1_000)}:R>).`;
    case 'competition_not_found':
      return 'That competition no longer exists in this server.';
    case 'forbidden':
      return 'Only the competition creator or a competition manager can schedule it.';
    case 'schedule_locked':
      return 'This competition has already started or can no longer be scheduled.';
    case 'invalid_format':
      return 'Enter the local start time as `YYYY-MM-DD HH:mm`.';
    case 'invalid_timezone':
      return 'This competition has an invalid timezone. Ask a server administrator to correct it.';
    case 'nonexistent_local_time':
      return 'That local time does not exist because of a daylight-saving transition. Choose another time.';
    case 'ambiguous_local_time':
      return 'That local time is ambiguous because of a daylight-saving transition. Choose another time.';
    case 'failed':
      return (result as { message?: string }).message;
    default:
      return undefined;
  }
}

function menu(result: {
  competitions: readonly { displayName: string; id: string }[];
  customId: string;
  page: number;
  pageCount: number;
}) {
  const options = result.competitions.map((competition) => ({
    label: competition.displayName,
    value: competition.id,
  }));
  if (result.page > 0) options.push({ label: 'Previous page', value: PREVIOUS_PAGE_VALUE });
  if (result.page < result.pageCount - 1)
    options.push({ label: 'Next page', value: NEXT_PAGE_VALUE });
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(result.customId)
      .setPlaceholder('Choose a competition to schedule')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options),
  );
}

function dateTimeModal(customId: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Schedule competition')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(DATE_TIME_INPUT_ID)
          .setLabel('Local start time (YYYY-MM-DD HH:mm)')
          .setPlaceholder('2026-08-10 15:30')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
}

function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This interaction is no longer valid. Run the command again.');
}
function sessionFailure(result: 'expired' | 'mismatch' | 'invalid') {
  return result === 'expired'
    ? failure('This selection expired. Run `/competition schedule` again.')
    : result === 'mismatch'
      ? failure('This interaction belongs to another member or server.')
      : invalid();
}
function encode(sessionId: string, page: number) {
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
function encodeModal(sessionId: string) {
  return `${INTERACTION_PREFIX}:time:${sessionId}`;
}
function decodeModal(value: string): { sessionId: string } | undefined {
  const match = new RegExp(`^${INTERACTION_PREFIX}:time:([^:]+)$`).exec(value);
  return match?.[1] !== undefined ? { sessionId: match[1] } : undefined;
}
function memberRoleIds(interaction: ModalSubmitInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined || Array.isArray(roles) ? (roles ?? []) : [...roles.cache.keys()];
}
function isSelection(result: unknown): result is {
  competitions: readonly { displayName: string; id: string }[];
  customId: string;
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
