import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import type { TrackedAccount } from '../../features/accounts/register-account.js';
import {
  CompetitionDraftParticipationService,
  type CompetitionEntrant,
  type CompetitionParticipationResult,
} from '../../features/competitions/manage-draft-participation.js';

const COMMAND_NAME = 'competition';
const INTERACTION_PREFIX = 'osleaders:competition-participation';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;
const MAX_SELECT_OPTIONS = 25;
const PAGE_ITEM_LIMIT = MAX_SELECT_OPTIONS - 2;
const NEXT_PAGE_VALUE = '__next_page__';
const PREVIOUS_PAGE_VALUE = '__previous_page__';

export interface CompetitionDraftParticipationChoices {
  listDrafts(guildId: string): Promise<readonly { id: string; displayName: string }[]>;
  listEntrants(guildId: string, competitionId: string): Promise<readonly CompetitionEntrant[]>;
}

export interface CompetitionDraftParticipationAccounts {
  listForGuild(guildId: string): Promise<TrackedAccount[]>;
  listLinkedForMember(guildId: string, discordUserId: string): Promise<TrackedAccount[]>;
}

type Action = 'join' | 'leave' | 'add' | 'remove';
type AddKind = 'linked' | 'watchlist';

interface Session {
  action: Action;
  competitionId?: string;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  addKind?: AddKind;
}

export class InMemoryCompetitionDraftParticipationSessionStore {
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

  public get(
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
    return session;
  }

  public update(id: string, session: Session): void {
    this.sessions.set(id, session);
  }

  public consume(id: string): void {
    this.sessions.delete(id);
  }

  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) this.sessions.delete(id);
    }
  }
}

export class CompetitionDraftParticipationCommandHandler {
  public constructor(
    private readonly participation: CompetitionDraftParticipationService,
    private readonly choices: CompetitionDraftParticipationChoices,
    private readonly accounts: CompetitionDraftParticipationAccounts,
    private readonly sessions = new InMemoryCompetitionDraftParticipationSessionStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start(guildId: string | null, requesterDiscordUserId: string, action: Action) {
    if (guildId === null) return failure('This command can only be used in a server.');
    const drafts = await this.choices.listDrafts(guildId);
    if (drafts.length === 0) return failure('There are no open competition drafts in this server.');
    const sessionId = this.sessions.create({
      action,
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return competitionSelection(sessionId, drafts, 0);
  }

  public async selectCompetition(request: {
    customId: string;
    guildId: string | null;
    requesterDiscordUserId: string;
    competitionId: string;
  }) {
    const decoded = decode(request.customId, 'competition');
    if (decoded === undefined || request.guildId === null) return invalid();
    const session = this.sessions.get(decoded, request.guildId, request.requesterDiscordUserId);
    if (typeof session !== 'object') return sessionFailure(session);
    const drafts = await this.choices.listDrafts(request.guildId);
    const nextPage = nextPageFor(request.customId, 'competition', request.competitionId);
    if (nextPage !== undefined) return competitionSelection(decoded, drafts, nextPage);
    if (!drafts.some((draft) => draft.id === request.competitionId)) return invalid();
    const updated = { ...session, competitionId: request.competitionId };
    this.sessions.update(decoded, updated);
    if (updated.action === 'leave') {
      this.sessions.consume(decoded);
      return participationResult(
        await this.participation.leave({
          competitionId: request.competitionId,
          guildId: request.guildId,
          requesterDiscordUserId: request.requesterDiscordUserId,
        }),
      );
    }
    if (updated.action === 'remove') {
      const entrants = await this.choices.listEntrants(request.guildId, request.competitionId);
      if (entrants.length === 0)
        return failure('This competition draft has no participants to remove.');
      return this.entrantSelection(decoded, entrants, request.guildId, 0);
    }
    if (updated.action === 'add') {
      return { kind: 'add_kind_selection' as const, customId: encode('kind', decoded) };
    }
    return this.accountSelection(
      decoded,
      updated,
      request.guildId,
      request.requesterDiscordUserId,
      0,
    );
  }

  public async selectAddKind(
    customId: string,
    guildId: string | null,
    requesterDiscordUserId: string,
    addKind: string,
  ) {
    const decoded = decode(customId, 'kind');
    if (
      decoded === undefined ||
      guildId === null ||
      (addKind !== 'linked' && addKind !== 'watchlist')
    ) {
      return invalid();
    }
    const session = this.sessions.get(decoded, guildId, requesterDiscordUserId);
    if (
      typeof session !== 'object' ||
      session.action !== 'add' ||
      session.competitionId === undefined
    ) {
      return typeof session === 'object' ? invalid() : sessionFailure(session);
    }
    const updated: Session = { ...session, addKind };
    this.sessions.update(decoded, updated);
    return this.accountSelection(decoded, updated, guildId, requesterDiscordUserId, 0);
  }

  public async selectAccounts(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
    accountIds: readonly string[];
  }) {
    const decoded = decode(request.customId, 'accounts');
    if (decoded === undefined || request.guildId === null) return invalid();
    const session = this.sessions.get(decoded, request.guildId, request.requesterDiscordUserId);
    if (typeof session !== 'object' || session.competitionId === undefined) {
      return typeof session === 'object' ? invalid() : sessionFailure(session);
    }
    const nextPage = nextPageFor(request.customId, 'accounts', request.accountIds[0] ?? '');
    if (nextPage !== undefined && request.accountIds.length === 1) {
      return this.accountSelection(
        decoded,
        session,
        request.guildId,
        request.requesterDiscordUserId,
        nextPage,
      );
    }
    this.sessions.consume(decoded);
    if (session.action === 'join') {
      return participationResult(
        await this.participation.join({
          competitionId: session.competitionId,
          contributingAccountIds: request.accountIds,
          guildId: request.guildId,
          requesterDiscordUserId: request.requesterDiscordUserId,
          requesterIsPresent: true,
        }),
      );
    }
    if (session.action !== 'add' || session.addKind === undefined) return invalid();
    const accounts = await this.accounts.listForGuild(request.guildId);
    const selected = accounts.filter((account) => request.accountIds.includes(account.id));
    if (selected.length !== request.accountIds.length) return invalid();
    const entrant =
      session.addKind === 'watchlist'
        ? selected.length === 1 && selected[0]?.association.type === 'watchlist'
          ? { type: 'watchlist' as const, watchlistAccountId: selected[0].id }
          : undefined
        : linkedEntrant(selected);
    if (entrant === undefined)
      return failure('Choose accounts that belong to one linked member, or one watchlist account.');
    return participationResult(
      await this.participation.add({
        competitionId: session.competitionId,
        entrant,
        guildId: request.guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
      }),
    );
  }

  public async selectEntrant(request: {
    customId: string;
    guildId: string | null;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
    entrantId: string;
  }) {
    const decoded = decode(request.customId, 'entrant');
    if (decoded === undefined || request.guildId === null) return invalid();
    const session = this.sessions.get(decoded, request.guildId, request.requesterDiscordUserId);
    if (
      typeof session !== 'object' ||
      session.action !== 'remove' ||
      session.competitionId === undefined
    ) {
      return typeof session === 'object' ? invalid() : sessionFailure(session);
    }
    const nextPage = nextPageFor(request.customId, 'entrant', request.entrantId);
    if (nextPage !== undefined) {
      return this.entrantSelection(
        decoded,
        await this.choices.listEntrants(request.guildId, session.competitionId),
        request.guildId,
        nextPage,
      );
    }
    this.sessions.consume(decoded);
    return participationResult(
      await this.participation.remove({
        competitionId: session.competitionId,
        entrantId: request.entrantId,
        guildId: request.guildId,
        hasAdministratorPermission: request.hasAdministratorPermission,
        memberRoleIds: request.memberRoleIds,
        requesterDiscordUserId: request.requesterDiscordUserId,
      }),
    );
  }

  private async accountSelection(
    sessionId: string,
    session: Session,
    guildId: string,
    requesterDiscordUserId: string,
    page: number,
  ) {
    const accounts =
      session.action === 'join'
        ? await this.accounts.listLinkedForMember(guildId, requesterDiscordUserId)
        : (await this.accounts.listForGuild(guildId)).filter((account) =>
            session.addKind === 'watchlist'
              ? account.association.type === 'watchlist'
              : account.association.type === 'linked',
          );
    if (accounts.length === 0)
      return failure('There are no eligible tracked accounts for this selection.');
    const paging = pageSlice(accounts, page);
    return {
      kind: 'account_selection' as const,
      accounts: paging.items,
      customId: encode('accounts', sessionId, paging.page),
      maximumValues:
        session.addKind === 'watchlist' ? 1 : Math.min(paging.items.length, MAX_SELECT_OPTIONS),
      page: paging.page,
      pageCount: paging.pageCount,
    };
  }

  private async entrantSelection(
    sessionId: string,
    entrants: readonly CompetitionEntrant[],
    guildId: string,
    page: number,
  ) {
    const accountNames = new Map(
      (await this.accounts.listForGuild(guildId)).map((account) => [
        account.id,
        account.displayUsername,
      ]),
    );
    return entrantSelection(
      sessionId,
      entrants.map((entrant) => ({
        id: entrant.id,
        label:
          entrant.type === 'watchlist'
            ? `Watchlist: ${accountNames.get(entrant.watchlistAccountId) ?? 'Unknown account'}`
            : `<@${entrant.discordUserId}>: ${accountNames.get(entrant.contributingAccountIds[0] ?? '') ?? 'Unknown account'}`,
      })),
      page,
    );
  }
}

export class DiscordCompetitionDraftParticipationCommandAdapter {
  public constructor(private readonly handler: CompetitionDraftParticipationCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== COMMAND_NAME) return;
      const action = interaction.options.getSubcommand();
      if (!isAction(action)) return;
      await interaction.reply({
        ...response(await this.handler.start(interaction.guildId, interaction.user.id, action)),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith(INTERACTION_PREFIX))
      return;
    const value = interaction.values[0] ?? '';
    if (decode(interaction.customId, 'competition') !== undefined) {
      await interaction.update(
        response(
          await this.handler.selectCompetition({
            customId: interaction.customId,
            competitionId: value,
            guildId: interaction.guildId,
            requesterDiscordUserId: interaction.user.id,
          }),
        ),
      );
    } else if (decode(interaction.customId, 'kind') !== undefined) {
      await interaction.update(
        response(
          await this.handler.selectAddKind(
            interaction.customId,
            interaction.guildId,
            interaction.user.id,
            value,
          ),
        ),
      );
    } else if (decode(interaction.customId, 'accounts') !== undefined) {
      await interaction.update(
        response(
          await this.handler.selectAccounts({
            accountIds: interaction.values,
            customId: interaction.customId,
            guildId: interaction.guildId,
            hasAdministratorPermission:
              interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
            memberRoleIds: memberRoleIds(interaction),
            requesterDiscordUserId: interaction.user.id,
          }),
        ),
      );
    } else if (decode(interaction.customId, 'entrant') !== undefined) {
      await interaction.update(
        response(
          await this.handler.selectEntrant({
            customId: interaction.customId,
            entrantId: value,
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
}

export function bindDiscordCompetitionDraftParticipationCommandAdapter(
  client: Client,
  adapter: DiscordCompetitionDraftParticipationCommandAdapter,
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

function response(result: unknown) {
  if (isSelection(result, 'competition_selection')) {
    const selection = result as unknown as {
      customId: string;
      drafts: readonly { id: string; displayName: string }[];
      page: number;
      pageCount: number;
    };
    return {
      components: [
        menu(
          selection.customId,
          'Choose a competition draft',
          pagedOptions(
            selection.drafts.map((draft) => ({ label: draft.displayName, value: draft.id })),
            selection.page,
            selection.pageCount,
          ),
        ),
      ],
    };
  }
  if (isSelection(result, 'add_kind_selection')) {
    const selection = result as unknown as { customId: string };
    return {
      components: [
        menu(selection.customId, 'Choose participant type', [
          { label: 'Linked member', value: 'linked' },
          { label: 'Watchlist account', value: 'watchlist' },
        ]),
      ],
    };
  }
  if (isSelection(result, 'account_selection')) {
    const selection = result as unknown as {
      accounts: readonly TrackedAccount[];
      customId: string;
      maximumValues: number;
      page: number;
      pageCount: number;
    };
    return {
      components: [
        menu(
          selection.customId,
          'Choose contributing accounts',
          pagedOptions(
            selection.accounts.map((account) => ({
              label: account.displayUsername,
              value: account.id,
            })),
            selection.page,
            selection.pageCount,
          ),
          selection.maximumValues,
        ),
      ],
    };
  }
  if (isSelection(result, 'entrant_selection')) {
    const selection = result as unknown as {
      customId: string;
      entrants: readonly { id: string; label: string }[];
      page: number;
      pageCount: number;
    };
    return {
      components: [
        menu(
          selection.customId,
          'Choose a participant to remove',
          pagedOptions(
            selection.entrants.map((entrant) => ({ label: entrant.label, value: entrant.id })),
            selection.page,
            selection.pageCount,
          ),
        ),
      ],
    };
  }
  const message =
    typeof result === 'object' && result !== null && 'message' in result
      ? String(result.message)
      : 'This interaction is no longer valid. Run the command again.';
  return { components: [], content: message };
}

function menu(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string }[],
  maximumValues = 1,
) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(maximumValues)
      .addOptions([...options]),
  );
}

function linkedEntrant(accounts: readonly TrackedAccount[]) {
  const discordUserId =
    accounts[0]?.association.type === 'linked' ? accounts[0].association.discordUserId : undefined;
  return discordUserId !== undefined &&
    accounts.every(
      (account) =>
        account.association.type === 'linked' &&
        account.association.discordUserId === discordUserId,
    )
    ? {
        type: 'discord_member' as const,
        discordUserId,
        contributingAccountIds: accounts.map((account) => account.id),
      }
    : undefined;
}

function participationResult(result: CompetitionParticipationResult) {
  const messages: Record<CompetitionParticipationResult['kind'], string> = {
    account_already_selected: 'One of those accounts is already contributing to this competition.',
    already_joined: 'That participant has already joined this competition.',
    competition_not_found: 'That competition no longer exists in this server.',
    entrant_not_found: 'That participant is not in this competition.',
    forbidden: 'Only the competition creator or a competition manager can do that.',
    invalid_accounts: 'Those accounts are not eligible for this participant.',
    joined: 'You joined the competition draft.',
    added: 'Participant added to the competition draft.',
    left: 'You left the competition draft.',
    membership_locked: 'Competition membership is locked.',
    removed: 'Participant removed from the competition draft.',
  };
  return { kind: 'completed' as const, message: messages[result.kind] };
}

function competitionSelection(
  sessionId: string,
  drafts: readonly { id: string; displayName: string }[],
  page: number,
) {
  const paging = pageSlice(drafts, page);
  return {
    kind: 'competition_selection' as const,
    customId: encode('competition', sessionId, paging.page),
    drafts: paging.items,
    page: paging.page,
    pageCount: paging.pageCount,
  };
}

function entrantSelection(
  sessionId: string,
  entrants: readonly { id: string; label: string }[],
  page: number,
) {
  const paging = pageSlice(entrants, page);
  return {
    kind: 'entrant_selection' as const,
    customId: encode('entrant', sessionId, paging.page),
    entrants: paging.items,
    page: paging.page,
    pageCount: paging.pageCount,
  };
}

function pageSlice<T>(items: readonly T[], requestedPage: number) {
  const pageCount = Math.ceil(items.length / PAGE_ITEM_LIMIT);
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
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
  return [
    ...(page > 0 ? [{ label: 'Previous page', value: PREVIOUS_PAGE_VALUE }] : []),
    ...options,
    ...(page + 1 < pageCount ? [{ label: 'Next page', value: NEXT_PAGE_VALUE }] : []),
  ];
}

function nextPageFor(customId: string, step: string, value: string): number | undefined {
  const page = pageFor(customId, step);
  if (page === undefined) return undefined;
  if (value === PREVIOUS_PAGE_VALUE) return page - 1;
  if (value === NEXT_PAGE_VALUE) return page + 1;
  return undefined;
}

function encode(step: string, sessionId: string, page = 0) {
  return `${INTERACTION_PREFIX}:${step}:${sessionId}:${page}`;
}
function decode(value: string, step: string) {
  const match = new RegExp(`^${INTERACTION_PREFIX}:${step}:([0-9a-f-]+):\\d+$`).exec(value);
  return match?.[1];
}
function pageFor(value: string, step: string) {
  const match = new RegExp(`^${INTERACTION_PREFIX}:${step}:[0-9a-f-]+:(\\d+)$`).exec(value);
  return match === null ? undefined : Number(match[1]);
}
function isAction(value: string): value is Action {
  return value === 'join' || value === 'leave' || value === 'add' || value === 'remove';
}
function failure(message: string) {
  return { kind: 'failed' as const, message };
}
function invalid() {
  return failure('This competition participation flow is no longer valid. Run the command again.');
}
function sessionFailure(session: 'expired' | 'mismatch' | undefined) {
  return failure(
    session === 'expired'
      ? 'This competition participation flow has expired. Run the command again.'
      : session === 'mismatch'
        ? 'This interaction belongs to another member or server.'
        : 'This competition participation flow is no longer valid. Run the command again.',
  );
}
function isSelection<T extends string>(
  value: unknown,
  kind: T,
): value is { kind: T } & Record<string, never> {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind;
}
function memberRoleIds(interaction: StringSelectMenuInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined || Array.isArray(roles) ? (roles ?? []) : [...roles.cache.keys()];
}
