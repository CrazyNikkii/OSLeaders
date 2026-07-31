import { describe, expect, it, vi } from 'vitest';

import { InProcessAutomaticDailyRecapSchedulingScheduler } from '../src/infrastructure/discord/automatic-daily-recap-scheduling-scheduler.js';

describe('automatic daily recap scheduling scheduler', () => {
  it('schedules due runs at startup and on a restrained interval', async () => {
    vi.useFakeTimers();
    const scheduleDueRuns = vi.fn(() => Promise.resolve(1));
    const scheduler = new InProcessAutomaticDailyRecapSchedulingScheduler(
      { scheduleDueRuns },
      { write: vi.fn() },
      60_000,
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(scheduleDueRuns).toHaveBeenCalledTimes(2);
    expect(scheduleDueRuns).toHaveBeenNthCalledWith(1, true);
    expect(scheduleDueRuns).toHaveBeenNthCalledWith(2, false);
    vi.useRealTimers();
  });

  it('logs failures and does not overlap scheduling passes', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    let resolveSchedule: (() => void) | undefined;
    const scheduleDueRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveSchedule = () => resolve(0);
          }),
      );
    const scheduler = new InProcessAutomaticDailyRecapSchedulingScheduler(
      { scheduleDueRuns },
      { write },
      60_000,
    );

    await scheduler.start();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'daily_recap.automatic_scheduling_failed' }),
    );
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    expect(scheduleDueRuns).toHaveBeenCalledTimes(2);
    resolveSchedule?.();
    scheduler.stop();
    vi.useRealTimers();
  });
});
