import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  TargetRaceClaimService,
  type TargetRaceClaimPermissionEvaluator,
  type TargetRaceClaimResult,
} from '../../features/competitions/claim-target-race.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-claim';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;
const MAX_SELECT_OPTIONS = 25;
const PAGE_ITEM_LIMIT = MAX_SELECT_OPTIONS - 2;
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';

export interface TargetRaceClaimChoices {
  listClaimableEntrants(request: {
    canManageCompetitions: boolean;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<readonly { competitionId: string; displayName: string; entrantId: string }[]>;
}

interface SelectionSession {
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

interface RetrySession extends SelectionSession {
  claimId: string;
}

export class CompetitionTargetRaceClaimCommandHandler {
  private readonly selections = new Map<string, SelectionSession>();
  private readonly retries = new Map<string, RetrySession>();

  public constructor(
    private readonly claims: Pick<TargetRaceClaimService, 'claim' | 'retry'>,
    private readonly choices: TargetRaceClaimChoices,
    private readonly permissions: TargetRaceClaimPermissionEvaluator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(request: {
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }) {
    if (request.guildId === null) return failure('This command can only be used in a server.');
    const guildId = request.guildId;
    const permissions = await this.permissions.evaluate({ ...request, guildId });
    const entrants = await this.choices.listClaimableEntrants({
      canManageCompetitions: permissions.canManageCompetitions,
      guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    if (entrants.length === 0)
      return failure('You have no active target-race entries that can be claimed.');
    return this.selection(entrants, guildId, request.requesterDiscordUserId, 0);
  }

  public async selectEntrant(request: {
    customId: string;
    entrantId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }) {
    const decoded = decodeSelection(request.customId);
    if (decoded === undefined || request.guildId === null) return invalid();
    const guildId = request.guildId;
    const session = this.consume(this.selections, decoded.sessionId, { ...request, guildId });
    if (typeof session === 'string') return sessionFailure(session);
    const permissions = await this.permissions.evaluate({ ...request, guildId });
    const entrants = await this.choices.listClaimableEntrants({
      canManageCompetitions: permissions.canManageCompetitions,
      guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    if (request.entrantId === NEXT_PAGE_VALUE || request.entrantId === PREVIOUS_PAGE_VALUE) {
      return this.selection(
        entrants,
        guildId,
        request.requesterDiscordUserId,
        request.entrantId === NEXT_PAGE_VALUE ? decoded.page + 1 : Math.max(0, decoded.page - 1),
      );
    }
    const entrant = entrants.find((candidate) => candidate.entrantId === request.entrantId);
    if (entrant === undefined) return invalid();
    return claimResult(
      await this.claims.claim({
        competitionId: entrant.competitionId,
        entrantId: entrant.entrantId,
        guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
        requesterIsPresent: true,
      }),
      (claimId) => this.createRetry({ ...session, claimId }),
    );
  }

  public async retry(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }) {
    const sessionId = decodeRetry(request.customId);
    if (sessionId === undefined || request.guildId === null) return invalid();
    const guildId = request.guildId;
    const session = this.consume(this.retries, sessionId, { ...request, guildId });
    if (typeof session === 'string') return sessionFailure(session);
    return claimResult(
      await this.claims.retry({
        claimId: session.claimId,
        guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
        requesterIsPresent: true,
      }),
      (claimId) => this.createRetry({ ...session, claimId }),
    );
  }

  private selection(
    entrants: readonly { competitionId: string; displayName: string; entrantId: string }[],
    guildId: string,
    requesterDiscordUserId: string,
    requestedPage: number,
  ) {
    const pageCount = Math.max(1, Math.ceil(entrants.length / PAGE_ITEM_LIMIT));
    const page = Math.min(requestedPage, pageCount - 1);
    const sessionId = this.create(this.selections, {
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return {
      customId: encodeSelection(sessionId, page),
      entrants: entrants.slice(page * PAGE_ITEM_LIMIT, (page + 1) * PAGE_ITEM_LIMIT),
      kind: 'selection' as const,
      page,
      pageCount,
    };
  }

  private createRetry(session: RetrySession): string {
    return this.create(this.retries, session);
  }

  private create<T extends SelectionSession>(sessions: Map<string, T>, session: T): string {
    this.prune(sessions);
    while (sessions.size >= MAX_PENDING_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const id = randomUUID();
    sessions.set(id, session);
    return id;
  }

  private consume<T extends SelectionSession>(
    sessions: Map<string, T>,
    id: string,
    request: { guildId: string; requesterDiscordUserId: string },
  ): T | 'expired' | 'mismatch' | 'invalid' {
    const session = sessions.get(id);
    if (session === undefined) return 'invalid';
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      sessions.delete(id);
      return 'expired';
    }
    if (
      session.guildId !== request.guildId ||
      session.requesterDiscordUserId !== request.requesterDiscordUserId
    )
      return 'mismatch';
    sessions.delete(id);
    return session;
  }

  private prune(sessions: Map<string, SelectionSession>): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) sessions.delete(id);
    }
  }
}

export class DiscordCompetitionTargetRaceClaimCommandAdapter {
  public constructor(private readonly handler: CompetitionTargetRaceClaimCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (
        interaction.commandName !== COMMAND_NAME ||
        interaction.options.getSubcommand() !== 'claim'
      )
        return;
      await interaction.reply({
        ...response(await this.handler.start(requestFor(interaction))),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith(`${INTERACTION_PREFIX}:select:`)
    ) {
      await interaction.deferUpdate();
      await this.respond(
        interaction,
        await this.handler.selectEntrant({
          ...requestFor(interaction),
          customId: interaction.customId,
          entrantId: interaction.values[0] ?? '',
        }),
      );
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${INTERACTION_PREFIX}:retry:`)) {
      await interaction.deferUpdate();
      await this.respond(
        interaction,
        await this.handler.retry({ ...requestFor(interaction), customId: interaction.customId }),
      );
    }
  }

  private async respond(
    interaction: StringSelectMenuInteraction | ButtonInteraction,
    result: unknown,
  ): Promise<void> {
    if (!isWinner(result)) {
      await interaction.editReply(response(result));
      return;
    }
    try {
      await publishWinner(interaction, result.message);
    } catch (error) {
      await interaction.editReply({
        components: [],
        content: 'Your claim was verified, but I could not publish the public announcement.',
      });
      throw error;
    }
    try {
      await interaction.deleteReply();
    } catch (error) {
      await interaction.editReply({
        components: [],
        content:
          'Your claim was verified and announced publicly, but I could not remove this private confirmation.',
      });
      throw error;
    }
  }
}

export function bindDiscordCompetitionTargetRaceClaimCommandAdapter(
  client: Client,
  adapter: DiscordCompetitionTargetRaceClaimCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !shouldHandleInteraction(interaction) ||
      (!interaction.isChatInputCommand() &&
        !interaction.isStringSelectMenu() &&
        !interaction.isButton())
    )
      return;
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

function requestFor(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
) {
  const roles = interaction.member?.roles;
  return {
    guildId: interaction.guildId,
    hasAdministratorPermission:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
    memberRoleIds:
      roles === undefined || Array.isArray(roles) ? (roles ?? []) : [...roles.cache.keys()],
    requesterDiscordUserId: interaction.user.id,
  };
}

function claimResult(result: TargetRaceClaimResult, createRetry: (claimId: string) => string) {
  switch (result.kind) {
    case 'won':
      return {
        kind: 'won' as const,
        message: `Target-race claim verified: +${number(result.finalValue)} progress.`,
      };
    case 'target_not_reached':
      return failure(
        `Target not reached: +${number(result.finalValue)} of ${number(result.targetValue)} progress (${number(result.targetValue - result.finalValue)} remaining).`,
      );
    case 'verification_pending':
      return {
        claimId: result.claimId,
        customId: encodeRetry(createRetry(result.claimId)),
        kind: 'retry' as const,
        message:
          'Hiscores is temporarily unavailable. Your claim is pending; retry verification shortly.',
      };
    case 'verification_failed':
      return failure(
        'Claim verification failed because Hiscores did not return complete account data.',
      );
    case 'earlier_claim_pending':
      return failure('An earlier claim is still being verified. Please try again shortly.');
    case 'competition_not_found':
      return failure('That competition no longer exists in this server.');
    case 'not_target_race':
      return failure('That competition is not a target race.');
    case 'not_active':
    case 'claim_not_active':
      return failure('That target race is no longer active.');
    case 'forbidden':
      return failure('You cannot submit a claim for that entrant.');
    case 'entrant_not_found':
      return failure('That competition entrant is no longer available.');
    case 'deadline_passed':
      return failure('The target-race deadline has passed.');
    case 'claim_not_found':
    case 'claim_not_retryable':
      return failure('That claim can no longer be retried.');
  }
}

function response(result: unknown) {
  if (isSelection(result)) {
    const options = result.entrants.map((entrant) => ({
      label: entrant.displayName,
      value: entrant.entrantId,
    }));
    if (result.page > 0) options.push({ label: 'Previous page', value: PREVIOUS_PAGE_VALUE });
    if (result.page < result.pageCount - 1)
      options.push({ label: 'Next page', value: NEXT_PAGE_VALUE });
    return {
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(result.customId)
            .setPlaceholder('Choose a target-race entry')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options),
        ),
      ],
      content: 'Choose a target-race entry to claim.',
    };
  }
  if (isRetry(result)) {
    return {
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(result.customId)
            .setLabel('Retry verification')
            .setStyle(ButtonStyle.Primary),
        ),
      ],
      content: result.message,
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

function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This interaction is no longer valid. Run the command again.');
}
function sessionFailure(result: 'expired' | 'mismatch' | 'invalid') {
  if (result === 'expired')
    return failure('This interaction expired. Run `/competition claim` again.');
  if (result === 'mismatch')
    return failure('This interaction belongs to another member or server.');
  return invalid();
}
function number(value: bigint): string {
  return value.toLocaleString('en-US');
}
function encodeSelection(sessionId: string, page: number): string {
  return `${INTERACTION_PREFIX}:select:${sessionId}:${page}`;
}
function decodeSelection(value: string): { page: number; sessionId: string } | undefined {
  const match = new RegExp(`^${INTERACTION_PREFIX}:select:([^:]+):(\\d+)$`).exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const page = Number(match[2]);
  return Number.isSafeInteger(page) && page >= 0 ? { page, sessionId: match[1] } : undefined;
}
function encodeRetry(sessionId: string): string {
  return `${INTERACTION_PREFIX}:retry:${sessionId}`;
}
function decodeRetry(value: string): string | undefined {
  return new RegExp(`^${INTERACTION_PREFIX}:retry:([^:]+)$`).exec(value)?.[1];
}
function isSelection(result: unknown): result is {
  customId: string;
  entrants: readonly { competitionId: string; displayName: string; entrantId: string }[];
  kind: 'selection';
  page: number;
  pageCount: number;
} {
  return (
    typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'selection'
  );
}
function isRetry(result: unknown): result is { customId: string; kind: 'retry'; message: string } {
  return (
    typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'retry'
  );
}
function isWinner(result: unknown): result is { kind: 'won'; message: string } {
  return typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'won';
}
async function publishWinner(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  content: string,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable())
    throw new Error('The target-race claim channel is not available for public results.');
  await channel.send({ content });
}
