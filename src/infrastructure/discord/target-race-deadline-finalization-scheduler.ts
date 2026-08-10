import type { TargetRaceDeadlineFinalizationService } from '../../features/competitions/finalize-target-race-deadline.js';
import type { TargetRaceClaimService } from '../../features/competitions/claim-target-race.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const INTERVAL_MS = 60_000;
const MAX_FINALIZATIONS_PER_PASS = 3;

export class InProcessTargetRaceDeadlineFinalizationScheduler {
  private running = false;
  private interval: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly finalizations: Pick<TargetRaceDeadlineFinalizationService, 'finalizeDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly claims?: Pick<TargetRaceClaimService, 'retryDue'>,
    private readonly intervalMs = INTERVAL_MS,
  ) {}

  public async start(): Promise<void> {
    await this.finalizeDue();
    this.interval ??= setInterval(() => void this.finalizeDue(), this.intervalMs);
  }

  public stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
  }

  private async finalizeDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.claims !== undefined) {
        for (let index = 0; index < MAX_FINALIZATIONS_PER_PASS; index += 1) {
          const result = await this.claims.retryDue();
          if (result.kind === 'no_due_claim' || result.kind === 'verification_pending') break;
        }
      }
      for (let index = 0; index < MAX_FINALIZATIONS_PER_PASS; index += 1) {
        if ((await this.finalizations.finalizeDue()).kind === 'no_due_finalization') return;
      }
    } catch {
      this.logger.write({
        operation: 'competition.target_race_deadline_finalization_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.running = false;
    }
  }
}
