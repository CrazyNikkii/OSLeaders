import { describe, expect, it, vi } from 'vitest';

import { InProcessTargetRaceDeadlineFinalizationScheduler } from '../src/infrastructure/discord/target-race-deadline-finalization-scheduler.js';

describe('target-race deadline finalization scheduler', () => {
  it('retries pending claims before fallback finalization and leaves temporary claims blocking', async () => {
    const retryDue = vi.fn().mockResolvedValue({ kind: 'verification_pending' });
    const finalizeDue = vi.fn().mockResolvedValue({ kind: 'no_due_finalization' });
    const scheduler = new InProcessTargetRaceDeadlineFinalizationScheduler(
      { finalizeDue },
      { write: vi.fn() },
      { retryDue },
    );

    await scheduler.start();
    expect(retryDue).toHaveBeenCalledOnce();
    expect(finalizeDue).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it('releases fallback after a permanent claim failure and bounds work per startup pass', async () => {
    const retryDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'verification_failed' })
      .mockResolvedValue({ kind: 'no_due_claim' });
    const finalizeDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'finished' })
      .mockResolvedValueOnce({ kind: 'finished' })
      .mockResolvedValueOnce({ kind: 'finished' });
    const scheduler = new InProcessTargetRaceDeadlineFinalizationScheduler(
      { finalizeDue },
      { write: vi.fn() },
      { retryDue },
    );

    await scheduler.start();
    expect(retryDue).toHaveBeenCalledTimes(2);
    expect(finalizeDue).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
});
