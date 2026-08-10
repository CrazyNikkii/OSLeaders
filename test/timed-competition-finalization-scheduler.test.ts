import { describe, expect, it, vi } from 'vitest';

import { InProcessTimedCompetitionFinalizationScheduler } from '../src/infrastructure/discord/timed-competition-finalization-scheduler.js';

describe('timed competition finalization scheduler', () => {
  it('bounds due finalizations in each startup pass', async () => {
    const finalizeDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'finished' })
      .mockResolvedValueOnce({ kind: 'finished' })
      .mockResolvedValueOnce({ kind: 'finished' });
    const scheduler = new InProcessTimedCompetitionFinalizationScheduler(
      { finalizeDue },
      { write: vi.fn() },
    );

    await scheduler.start();
    expect(finalizeDue).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('stops when no work is due', async () => {
    const finalizeDue = vi.fn().mockResolvedValue({ kind: 'no_due_finalization' });
    const scheduler = new InProcessTimedCompetitionFinalizationScheduler(
      { finalizeDue },
      { write: vi.fn() },
    );

    await scheduler.start();
    expect(finalizeDue).toHaveBeenCalledOnce();
    scheduler.stop();
  });
});
