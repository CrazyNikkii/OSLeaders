import type { CompetitionStartService } from '../../features/competitions/start-competition.js';
import type { StructuredLocalLogger } from '../../shared/structured-logging.js';

const RETRY_INTERVAL_MS = 60_000;
const MAX_RETRIES_PER_PASS = 3;

export interface CompetitionStartRetryScheduler {
  start(): Promise<void>;
  stop(): void;
}

export class InProcessCompetitionStartRetryScheduler implements CompetitionStartRetryScheduler {
  private retrying = false;
  private interval: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly starts: Pick<CompetitionStartService, 'retryDue'>,
    private readonly logger: StructuredLocalLogger,
    private readonly intervalMs = RETRY_INTERVAL_MS,
  ) {}

  public async start(): Promise<void> {
    await this.retryDueStarts();
    this.interval ??= setInterval(() => {
      void this.retryDueStarts();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async retryDueStarts(): Promise<void> {
    if (this.retrying) {
      return;
    }
    this.retrying = true;
    try {
      for (let index = 0; index < MAX_RETRIES_PER_PASS; index += 1) {
        const result = await this.starts.retryDue();
        if (result.kind === 'no_due_start') {
          return;
        }
      }
    } catch {
      this.logger.write({
        operation: 'competition.start_retry_failed',
        severity: 'error',
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.retrying = false;
    }
  }
}
