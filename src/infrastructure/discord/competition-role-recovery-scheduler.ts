import type { CompetitionRoleLifecycleService } from '../../features/competitions/manage-competition-role.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const INTERVAL_MS = 60_000;
const MAX_PER_PASS = 3;

export interface CompetitionRoleRecoveryScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessCompetitionRoleRecoveryScheduler implements CompetitionRoleRecoveryScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private recovering = false;
  public constructor(
    private readonly roles: Pick<CompetitionRoleLifecycleService, 'recoverDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = INTERVAL_MS,
  ) {}
  public async start(): Promise<void> {
    await this.recover();
    this.interval ??= setInterval(() => void this.recover(), this.intervalMs);
  }
  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      for (let index = 0; index < MAX_PER_PASS; index += 1)
        if ((await this.roles.recoverDue()) === 'no_operation') return;
    } catch {
      this.logger.write({
        operation: 'competition_role.recovery_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.recovering = false;
    }
  }
}
