import { describe, expect, it } from 'vitest';

import {
  AutomaticDailyRecapSchedulingService,
  dueRecapInstant,
  resolveUniqueLocalInstant,
  type AutomaticDailyRecapScheduleRepository,
} from '../src/features/recaps/schedule-automatic-daily-recaps.js';
import type { GuildConfiguration } from '../src/features/guild-configuration/guild-configuration-service.js';

describe('automatic daily recap scheduling service', () => {
  it('creates one durable automatic run for a due guild-local recap time', async () => {
    const repository = new ScheduleRepository([configuration()]);
    const service = new AutomaticDailyRecapSchedulingService(
      repository,
      { now: () => new Date('2026-07-31T16:10:00.000Z') },
      () => 'automatic-run-one',
    );

    await expect(service.scheduleDueRuns()).resolves.toBe(1);
    await expect(service.scheduleDueRuns()).resolves.toBe(0);
    expect(repository.runs).toEqual([
      {
        guildId: 'guild-one',
        recapRunId: 'automatic-run-one',
        scheduledFor: '2026-07-31T15:00:00.000Z',
      },
    ]);
  });

  it('does not create a run before the configured local time or for disabled recaps', () => {
    expect(dueRecapInstant(configuration(), new Date('2026-07-31T06:30:00.000Z'))).toBeUndefined();
    expect(
      dueRecapInstant(
        { ...configuration(), recapEnabled: false },
        new Date('2026-07-31T16:10:00.000Z'),
      ),
    ).toBeUndefined();
  });

  it('creates the previous local-day occurrence only during startup overdue recovery', () => {
    expect(dueRecapInstant(configuration(), new Date('2026-08-01T06:30:00.000Z'), true)).toEqual(
      new Date('2026-07-31T15:00:00.000Z'),
    );
  });

  it('does not resolve daylight-saving gaps or repeated local times', () => {
    expect(resolveUniqueLocalInstant(2026, 3, 29, '03:30', 'Europe/Helsinki')).toBeUndefined();
    expect(resolveUniqueLocalInstant(2026, 10, 25, '03:30', 'Europe/Helsinki')).toBeUndefined();
  });
});

class ScheduleRepository implements AutomaticDailyRecapScheduleRepository {
  public readonly runs: { guildId: string; recapRunId: string; scheduledFor: string }[] = [];

  public constructor(private readonly configurations: readonly GuildConfiguration[]) {}

  public createAutomaticRun(
    guildId: string,
    recapRunId: string,
    scheduledFor: Date,
  ): Promise<boolean> {
    if (
      this.runs.some(
        (run) => run.guildId === guildId && run.scheduledFor === scheduledFor.toISOString(),
      )
    ) {
      return Promise.resolve(false);
    }
    this.runs.push({ guildId, recapRunId, scheduledFor: scheduledFor.toISOString() });
    return Promise.resolve(true);
  }

  public listEnabledRecapConfigurations(): Promise<readonly GuildConfiguration[]> {
    return Promise.resolve(this.configurations);
  }
}

function configuration(): GuildConfiguration {
  return {
    administrativeLogChannelId: null,
    administrativeLogMode: 'standard',
    botManagerRoleId: null,
    competitionManagerRoleId: null,
    guildId: 'guild-one',
    modeEmojis: {},
    recapChannelId: 'recap-channel',
    recapEnabled: true,
    recapLocalTime: '18:00',
    timezone: 'Europe/Helsinki',
  };
}
