export interface PendingCompetitionRoleOperation {
  attemptCount: number;
  competitionId: string;
  creatorDiscordUserId: string;
  displayName: string;
  discordRoleId: string | null;
  guildId: string;
  memberDiscordUserIds: readonly string[];
  operation: 'create' | 'cleanup' | 'sync';
}

export interface CompetitionRoleRepository {
  claimDueOperation(): Promise<PendingCompetitionRoleOperation | undefined>;
  recordCreated(request: {
    competitionId: string;
    discordRoleId: string;
    guildId: string;
  }): Promise<void>;
  recordCleaned(request: { competitionId: string; guildId: string }): Promise<void>;
  recordFailure(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
    operation: 'create' | 'cleanup' | 'sync';
  }): Promise<void>;
  recordSynced(request: {
    competitionId: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void>;
  recordMissingRole(request: { competitionId: string; guildId: string }): Promise<void>;
}

export interface CompetitionRolePublisher {
  createAndAssign(operation: PendingCompetitionRoleOperation): Promise<{ discordRoleId: string }>;
  cleanup(operation: PendingCompetitionRoleOperation): Promise<void>;
  syncAssignments(operation: PendingCompetitionRoleOperation): Promise<void>;
}

export class MissingCompetitionRoleError extends Error {}
export class CompetitionRolePermissionError extends Error {}

export interface CompetitionRoleFailureReporter {
  report(operation: PendingCompetitionRoleOperation, failureSummary: string): Promise<void>;
}

/** Runs optional Discord role work only after its owning competition state is durable. */
export class CompetitionRoleLifecycleService {
  public constructor(
    private readonly repository: CompetitionRoleRepository,
    private readonly publisher: CompetitionRolePublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly failures?: CompetitionRoleFailureReporter,
  ) {}

  public async recoverDue(): Promise<'completed' | 'failed' | 'no_operation'> {
    const operation = await this.repository.claimDueOperation();
    if (operation === undefined) return 'no_operation';
    try {
      if (operation.operation === 'create') {
        const created = await this.publisher.createAndAssign(operation);
        await this.repository.recordCreated({ ...operation, discordRoleId: created.discordRoleId });
      } else if (operation.operation === 'cleanup') {
        await this.publisher.cleanup(operation);
        await this.repository.recordCleaned(operation);
      } else {
        await this.publisher.syncAssignments(operation);
        await this.repository.recordSynced({
          ...operation,
          nextAttemptAt: new Date(this.now().getTime() + 60_000),
        });
      }
      return 'completed';
    } catch (error) {
      if (error instanceof MissingCompetitionRoleError) {
        await this.repository.recordMissingRole(operation);
        return 'failed';
      }
      if (error instanceof CompetitionRolePermissionError)
        await this.failures?.report(operation, error.message);
      await this.repository.recordFailure({
        ...operation,
        failureSummary:
          error instanceof Error ? error.message : 'Unexpected Discord competition-role failure.',
        nextAttemptAt: new Date(this.now().getTime() + retryDelayMs(operation.attemptCount)),
      });
      return 'failed';
    }
  }
}

export function retryDelayMs(attemptCount: number): number {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]!;
}
