import type { AutomaticDailyRecapSchedulingService } from '../../features/recaps/schedule-automatic-daily-recaps.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const SCHEDULING_INTERVAL_MS = 60_000;

export interface AutomaticDailyRecapSchedulingScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessAutomaticDailyRecapSchedulingScheduler implements AutomaticDailyRecapSchedulingScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private scheduling = false;

  public constructor(
    private readonly schedules: Pick<AutomaticDailyRecapSchedulingService, 'scheduleDueRuns'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = SCHEDULING_INTERVAL_MS,
  ) {}

  public async start(): Promise<void> {
    await this.scheduleDueRuns(true);
    this.interval ??= setInterval(() => {
      void this.scheduleDueRuns(false);
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async scheduleDueRuns(includeOverdue: boolean): Promise<void> {
    if (this.scheduling) {
      return;
    }
    this.scheduling = true;
    try {
      await this.schedules.scheduleDueRuns(includeOverdue);
    } catch {
      this.logger.write({
        operation: 'daily_recap.automatic_scheduling_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.scheduling = false;
    }
  }
}
