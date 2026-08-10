import { describe, expect, it, vi } from 'vitest';

import { InProcessCompetitionStartRetryScheduler } from '../src/infrastructure/discord/competition-start-retry-scheduler.js';

describe('competition start retry scheduler', () => {
  it('retries due starts at startup, bounds each pass, and stops', async () => {
    vi.useFakeTimers();
    const retryDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'started' })
      .mockResolvedValueOnce({ kind: 'started' })
      .mockResolvedValueOnce({ kind: 'started' })
      .mockResolvedValue({ kind: 'no_due_start' });
    const scheduler = new InProcessCompetitionStartRetryScheduler(
      { retryDue },
      { write: vi.fn() },
      60_000,
    );

    await scheduler.start();
    expect(retryDue).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retryDue).toHaveBeenCalledTimes(4);
    scheduler.stop();
    vi.useRealTimers();
  });

  it('logs unexpected retry failures', async () => {
    const write = vi.fn();
    const scheduler = new InProcessCompetitionStartRetryScheduler(
      { retryDue: vi.fn(() => Promise.reject(new Error('database unavailable'))) },
      { write },
    );

    await scheduler.start();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'competition.start_retry_failed' }),
    );
    scheduler.stop();
  });
});
