import type { TimedCompetitionFinalizationService } from '../../features/competitions/finalize-timed-competition.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const INTERVAL_MS = 60_000;
const MAX_FINALIZATIONS_PER_PASS = 3;

export class InProcessTimedCompetitionFinalizationScheduler {
  private running = false;
  private interval: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly finalizations: Pick<TimedCompetitionFinalizationService, 'finalizeDue'>,
    private readonly logger: StructuredLocalLogger,
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
      for (let index = 0; index < MAX_FINALIZATIONS_PER_PASS; index += 1) {
        if ((await this.finalizations.finalizeDue()).kind === 'no_due_finalization') return;
      }
    } catch {
      this.logger.write({
        operation: 'competition.timed_finalization_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.running = false;
    }
  }
}
