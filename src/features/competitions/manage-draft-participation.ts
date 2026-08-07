export type CompetitionEntrant =
  | {
      id: string;
      competitionId: string;
      guildId: string;
      type: 'discord_member';
      discordUserId: string;
      contributingAccountIds: readonly string[];
    }
  | {
      id: string;
      competitionId: string;
      guildId: string;
      type: 'watchlist';
      watchlistAccountId: string;
      contributingAccountIds: readonly [string];
    };

export interface CompetitionParticipationPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export interface CompetitionDraftParticipationRepository {
  join(request: {
    competitionId: string;
    contributingAccountIds: readonly string[];
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult>;
  add(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    entrant: CompetitionEntrantInput;
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult>;
  leave(request: {
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult>;
  remove(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult>;
}

export type CompetitionEntrantInput =
  | { type: 'discord_member'; discordUserId: string; contributingAccountIds: readonly string[] }
  | { type: 'watchlist'; watchlistAccountId: string };

export type CompetitionParticipationResult =
  | { kind: 'joined' | 'added'; entrant: CompetitionEntrant }
  | { kind: 'left' | 'removed'; entrant: CompetitionEntrant }
  | { kind: 'competition_not_found' }
  | { kind: 'membership_locked' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_accounts' }
  | { kind: 'already_joined' }
  | { kind: 'account_already_selected' }
  | { kind: 'entrant_not_found' };

export class CompetitionDraftParticipationService {
  public constructor(
    private readonly repository: CompetitionDraftParticipationRepository,
    private readonly permissions: CompetitionParticipationPermissionEvaluator,
    private readonly createId: () => string,
  ) {}

  public join(request: {
    competitionId: string;
    contributingAccountIds: readonly string[];
    guildId: string;
    requesterDiscordUserId: string;
    requesterIsPresent: boolean;
  }): Promise<CompetitionParticipationResult> {
    if (!request.requesterIsPresent || !hasUniqueAccountIds(request.contributingAccountIds)) {
      return Promise.resolve({ kind: 'invalid_accounts' });
    }
    return this.repository.join({
      competitionId: request.competitionId,
      contributingAccountIds: request.contributingAccountIds,
      entrantId: this.createId(),
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
  }

  public async add(request: {
    competitionId: string;
    entrant: CompetitionEntrantInput;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    if (!isValidEntrantInput(request.entrant)) {
      return { kind: 'invalid_accounts' };
    }
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    return this.repository.add({
      canManageCompetitions: permissions.canManageCompetitions,
      competitionId: request.competitionId,
      entrant: request.entrant,
      entrantId: this.createId(),
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
  }

  public leave(request: {
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    return this.repository.leave(request);
  }

  public async remove(request: {
    competitionId: string;
    entrantId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    return this.repository.remove({
      ...request,
      canManageCompetitions: permissions.canManageCompetitions,
    });
  }
}

function isValidEntrantInput(entrant: CompetitionEntrantInput): boolean {
  return entrant.type === 'watchlist'
    ? entrant.watchlistAccountId.length > 0
    : hasUniqueAccountIds(entrant.contributingAccountIds);
}

function hasUniqueAccountIds(accountIds: readonly string[]): boolean {
  return (
    accountIds.length > 0 &&
    accountIds.every((accountId) => accountId.length > 0) &&
    new Set(accountIds).size === accountIds.length
  );
}
