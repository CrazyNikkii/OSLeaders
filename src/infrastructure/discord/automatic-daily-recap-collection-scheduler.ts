import type { AutomaticDailyRecapCollectionService } from '../../features/recaps/collect-automatic-daily-recap.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const COLLECTION_INTERVAL_MS = 60_000;
const MAX_COLLECTIONS_PER_PASS = 3;

export interface AutomaticDailyRecapCollectionScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessAutomaticDailyRecapCollectionScheduler implements AutomaticDailyRecapCollectionScheduler {
  private collecting = false;
  private interval: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly collection: Pick<AutomaticDailyRecapCollectionService, 'collectDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = COLLECTION_INTERVAL_MS,
  ) {}

  public async start(): Promise<void> {
    await this.collectDueRecaps();
    this.interval ??= setInterval(() => {
      void this.collectDueRecaps();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async collectDueRecaps(): Promise<void> {
    if (this.collecting) {
      return;
    }
    this.collecting = true;
    try {
      for (let index = 0; index < MAX_COLLECTIONS_PER_PASS; index += 1) {
        const result = await this.collection.collectDue();
        if (result.kind === 'no_due_recap') {
          return;
        }
      }
    } catch {
      this.logger.write({
        operation: 'daily_recap.automatic_collection_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.collecting = false;
    }
  }
}
