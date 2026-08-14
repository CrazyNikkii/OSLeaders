import { describe, expect, it, vi } from 'vitest';

import { InProcessCompetitionRoleRecoveryScheduler } from '../src/infrastructure/discord/competition-role-recovery-scheduler.js';

describe('competition role recovery scheduler', () => {
  it('does not install an interval when stopped during its initial recovery', async () => {
    vi.useFakeTimers();
    const initialRecovery = deferred<'no_operation'>();
    const recoverDue = vi.fn(() => initialRecovery.promise);
    const scheduler = new InProcessCompetitionRoleRecoveryScheduler(
      { recoverDue },
      { write: vi.fn() },
      60_000,
    );

    const start = scheduler.start();
    expect(recoverDue).toHaveBeenCalledOnce();
    scheduler.stop();
    initialRecovery.resolve('no_operation');
    await start;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(recoverDue).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      resolve?.(value);
    },
  };
}
