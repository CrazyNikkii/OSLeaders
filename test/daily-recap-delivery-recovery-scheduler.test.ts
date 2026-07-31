import { describe, expect, it, vi } from 'vitest';

import { InProcessDailyRecapDeliveryRecoveryScheduler } from '../src/infrastructure/discord/daily-recap-delivery-recovery-scheduler.js';

describe('daily recap delivery recovery scheduler', () => {
  it('recovers due deliveries at startup, bounds each pass, and stops its interval', async () => {
    vi.useFakeTimers();
    const recoverDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'delivered', discordMessageId: 'message-one' })
      .mockResolvedValueOnce({ kind: 'delivered', discordMessageId: 'message-two' })
      .mockResolvedValueOnce({ kind: 'delivered', discordMessageId: 'message-three' })
      .mockResolvedValue({ kind: 'no_recoverable_delivery' });
    const scheduler = new InProcessDailyRecapDeliveryRecoveryScheduler(
      { recoverDue },
      { write: vi.fn() },
      60_000,
    );

    await scheduler.start();
    expect(recoverDue).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverDue).toHaveBeenCalledTimes(4);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverDue).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('logs unexpected recovery failures without overlapping later passes', async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const recoverDue = vi.fn(() => Promise.reject(new Error('database unavailable')));
    const scheduler = new InProcessDailyRecapDeliveryRecoveryScheduler(
      { recoverDue },
      { write },
      60_000,
    );

    await scheduler.start();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'daily_recap.delivery_recovery_failed' }),
    );
    scheduler.stop();
    vi.useRealTimers();
  });

  it('does not start a second recovery while a prior interval pass is in flight', async () => {
    vi.useFakeTimers();
    let resolveRecovery: (() => void) | undefined;
    const recoverDue = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'no_recoverable_delivery' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRecovery = () => resolve({ kind: 'no_recoverable_delivery' });
          }),
      );
    const scheduler = new InProcessDailyRecapDeliveryRecoveryScheduler(
      { recoverDue },
      { write: vi.fn() },
      60_000,
    );

    await scheduler.start();
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(recoverDue).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(recoverDue).toHaveBeenCalledTimes(2);
    resolveRecovery?.();
    await Promise.resolve();
    scheduler.stop();
    vi.useRealTimers();
  });
});
