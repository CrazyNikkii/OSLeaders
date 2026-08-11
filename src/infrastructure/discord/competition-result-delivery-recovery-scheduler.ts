import type { CompetitionResultDeliveryService } from '../../features/competitions/deliver-competition-result.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const INTERVAL_MS = 60_000;
const MAX_PER_PASS = 3;
export interface CompetitionResultDeliveryRecoveryScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessCompetitionResultDeliveryRecoveryScheduler implements CompetitionResultDeliveryRecoveryScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private recovering = false;
  public constructor(
    private readonly deliveries: Pick<CompetitionResultDeliveryService, 'recoverDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = INTERVAL_MS,
  ) {}
  public async start(): Promise<void> {
    await this.recover();
    this.interval ??= setInterval(() => {
      void this.recover();
    }, this.intervalMs);
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
        if ((await this.deliveries.recoverDue()) === 'no_delivery') return;
    } catch {
      this.logger.write({
        operation: 'competition_result.delivery_recovery_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.recovering = false;
    }
  }
}
