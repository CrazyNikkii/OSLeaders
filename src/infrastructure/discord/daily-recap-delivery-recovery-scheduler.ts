import type { DailyRecapDeliveryService } from '../../features/recaps/deliver-daily-recap.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const RECOVERY_INTERVAL_MS = 60_000;
const MAX_DELIVERIES_PER_PASS = 3;

export interface DailyRecapDeliveryRecoveryScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessDailyRecapDeliveryRecoveryScheduler implements DailyRecapDeliveryRecoveryScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private recovering = false;

  public constructor(
    private readonly delivery: Pick<DailyRecapDeliveryService, 'recoverDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = RECOVERY_INTERVAL_MS,
  ) {}

  public async start(): Promise<void> {
    await this.recoverDueDeliveries();
    this.interval ??= setInterval(() => {
      void this.recoverDueDeliveries();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async recoverDueDeliveries(): Promise<void> {
    if (this.recovering) {
      return;
    }
    this.recovering = true;
    try {
      for (let index = 0; index < MAX_DELIVERIES_PER_PASS; index += 1) {
        const result = await this.delivery.recoverDue();
        if (result.kind === 'no_recoverable_delivery') {
          return;
        }
      }
    } catch {
      this.logger.write({
        operation: 'daily_recap.delivery_recovery_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.recovering = false;
    }
  }
}
