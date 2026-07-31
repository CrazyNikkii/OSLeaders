import { randomUUID } from 'node:crypto';

import type { GuildConfiguration } from '../guild-configuration/guild-configuration-service.js';

export interface AutomaticDailyRecapScheduleRepository {
  createAutomaticRun(guildId: string, recapRunId: string, scheduledFor: Date): Promise<boolean>;
  listEnabledRecapConfigurations(): Promise<readonly GuildConfiguration[]>;
}

export interface AutomaticDailyRecapClock {
  now(): Date;
}

export class AutomaticDailyRecapSchedulingService {
  private readonly scheduledOccurrences = new Map<string, string>();

  public constructor(
    private readonly repository: AutomaticDailyRecapScheduleRepository,
    private readonly clock: AutomaticDailyRecapClock = systemClock,
    private readonly createId: () => string = randomUUID,
  ) {}

  public async scheduleDueRuns(includeOverdue = false): Promise<number> {
    const now = this.clock.now();
    const configurations = await this.repository.listEnabledRecapConfigurations();
    let scheduled = 0;

    for (const configuration of configurations) {
      const scheduledDate = dueRecapLocalDate(configuration, now, includeOverdue);
      if (scheduledDate === undefined) {
        continue;
      }
      const occurrenceKey = `${configuration.recapChannelId}:${configuration.recapLocalTime}:${configuration.timezone}:${scheduledDate.year}-${scheduledDate.month}-${scheduledDate.day}`;
      if (this.scheduledOccurrences.get(configuration.guildId) === occurrenceKey) {
        continue;
      }
      const scheduledFor = resolveUniqueLocalInstant(
        scheduledDate.year,
        scheduledDate.month,
        scheduledDate.day,
        configuration.recapLocalTime!,
        configuration.timezone,
      );
      if (scheduledFor === undefined) {
        continue;
      }
      if (
        await this.repository.createAutomaticRun(
          configuration.guildId,
          this.createId(),
          scheduledFor,
        )
      ) {
        scheduled += 1;
      }
      this.scheduledOccurrences.set(configuration.guildId, occurrenceKey);
    }
    return scheduled;
  }
}

export function dueRecapInstant(
  configuration: GuildConfiguration,
  now: Date,
  includeOverdue = false,
): Date | undefined {
  const scheduledDate = dueRecapLocalDate(configuration, now, includeOverdue);
  if (scheduledDate === undefined) {
    return undefined;
  }
  return resolveUniqueLocalInstant(
    scheduledDate.year,
    scheduledDate.month,
    scheduledDate.day,
    configuration.recapLocalTime!,
    configuration.timezone,
  );
}

function dueRecapLocalDate(
  configuration: GuildConfiguration,
  now: Date,
  includeOverdue: boolean,
): ReturnType<typeof localDateTime> | undefined {
  if (
    !configuration.recapEnabled ||
    configuration.recapChannelId === null ||
    configuration.recapLocalTime === null ||
    !isValidTimezone(configuration.timezone)
  ) {
    return undefined;
  }
  const localNow = localDateTime(now, configuration.timezone);
  const recapMinutes = localTimeMinutes(configuration.recapLocalTime);
  const nowMinutes = localNow.hour * 60 + localNow.minute;
  if (nowMinutes < recapMinutes && !includeOverdue) {
    return undefined;
  }
  const scheduledDate = nowMinutes < recapMinutes ? addDays(localNow, -1) : localNow;
  return scheduledDate;
}

export function resolveUniqueLocalInstant(
  year: number,
  month: number,
  day: number,
  localTime: string,
  timezone: string,
): Date | undefined {
  if (!isLocalTime(localTime) || !isValidTimezone(timezone)) {
    return undefined;
  }
  const [hourText, minuteText] = localTime.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const target = { day, hour, minute, month, year };
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const matches: Date[] = [];

  for (let offsetMinutes = -1_560; offsetMinutes <= 1_560; offsetMinutes += 1) {
    const candidate = new Date(naive + offsetMinutes * 60_000);
    if (sameLocalDateTime(localDateTime(candidate, timezone), target)) {
      matches.push(candidate);
      if (matches.length > 1) {
        return undefined;
      }
    }
  }
  return matches[0];
}

export function isSafeRecurringLocalTime(localTime: string, timezone: string, now: Date): boolean {
  if (!isLocalTime(localTime) || !isValidTimezone(timezone)) {
    return false;
  }
  const today = localDateTime(now, timezone);
  let previousOffset = timezoneOffsetMinutes(addDays(today, -1), timezone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = addDays(today, offset);
    const timezoneOffset = timezoneOffsetMinutes(date, timezone);
    if (timezoneOffset !== previousOffset) {
      for (const nearbyDate of [addDays(date, -1), date, addDays(date, 1)]) {
        if (
          resolveUniqueLocalInstant(
            nearbyDate.year,
            nearbyDate.month,
            nearbyDate.day,
            localTime,
            timezone,
          ) === undefined
        ) {
          return false;
        }
      }
    }
    previousOffset = timezoneOffset;
  }
  return true;
}

function isLocalTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function localTimeMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function localDateTime(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(value);
  const numeric = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    day: numeric('day'),
    hour: numeric('hour'),
    minute: numeric('minute'),
    month: numeric('month'),
    year: numeric('year'),
  };
}

function sameLocalDateTime(
  actual: ReturnType<typeof localDateTime>,
  expected: ReturnType<typeof localDateTime>,
): boolean {
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute
  );
}

function timezoneOffsetMinutes(
  date: Pick<ReturnType<typeof localDateTime>, 'day' | 'month' | 'year'>,
  timezone: string,
): number {
  const instant = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  const local = localDateTime(instant, timezone);
  return (
    (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
      instant.getTime()) /
    60_000
  );
}

function addDays(
  date: ReturnType<typeof localDateTime>,
  days: number,
): ReturnType<typeof localDateTime> {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    day: result.getUTCDate(),
    hour: 0,
    minute: 0,
    month: result.getUTCMonth() + 1,
    year: result.getUTCFullYear(),
  };
}

const systemClock: AutomaticDailyRecapClock = { now: () => new Date() };
