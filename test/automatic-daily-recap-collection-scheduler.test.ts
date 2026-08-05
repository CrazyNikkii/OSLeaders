import { describe, expect, it, vi } from 'vitest';

import { InProcessAutomaticDailyRecapCollectionScheduler } from '../src/infrastructure/discord/automatic-daily-recap-collection-scheduler.js';

describe('automatic daily recap collection scheduler', () => {
  it('collects due recaps at startup, bounds each pass, and stops', async () => {
    vi.useFakeTimers();
    const collectDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ready_for_delivery' })
      .mockResolvedValueOnce({ kind: 'ready_for_delivery' })
      .mockResolvedValueOnce({ kind: 'ready_for_delivery' })
      .mockResolvedValue({ kind: 'no_due_recap' });
    const scheduler = new InProcessAutomaticDailyRecapCollectionScheduler(
      { collectDue },
      { write: vi.fn() },
      60_000,
    );

    await scheduler.start();
    expect(collectDue).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collectDue).toHaveBeenCalledTimes(4);
    scheduler.stop();
    vi.useRealTimers();
  });

  it('logs unexpected scheduler failures', async () => {
    const write = vi.fn();
    const scheduler = new InProcessAutomaticDailyRecapCollectionScheduler(
      { collectDue: vi.fn(() => Promise.reject(new Error('database unavailable'))) },
      { write },
    );

    await scheduler.start();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'daily_recap.automatic_collection_failed' }),
    );
    scheduler.stop();
  });
});
