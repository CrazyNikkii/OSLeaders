export type ResolveScheduledStartResult =
  | { kind: 'resolved'; intendedStartAt: Date }
  | {
      kind:
        'invalid_format' | 'invalid_timezone' | 'nonexistent_local_time' | 'ambiguous_local_time';
    };

/**
 * Resolves a local, minute-precision competition start time without silently
 * choosing a daylight-saving transition. One-time competition boundaries are
 * stored as UTC instants; the timezone remains with the competition for display.
 */
export function resolveScheduledCompetitionStart(
  localDateTime: string,
  timezone: string,
): ResolveScheduledStartResult {
  if (!isIanaTimezone(timezone)) return { kind: 'invalid_timezone' };
  const parts = parseLocalDateTime(localDateTime);
  if (parts === undefined) return { kind: 'invalid_format' };

  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const matches: Date[] = [];
  for (
    let milliseconds = wallClockAsUtc - 26 * 60 * 60 * 1_000;
    milliseconds <= wallClockAsUtc + 26 * 60 * 60 * 1_000;
    milliseconds += 60_000
  ) {
    const instant = new Date(milliseconds);
    if (sameLocalTime(instant, timezone, parts)) matches.push(instant);
  }
  if (matches.length === 0) return { kind: 'nonexistent_local_time' };
  if (matches.length > 1) return { kind: 'ambiguous_local_time' };
  return { kind: 'resolved', intendedStartAt: matches[0]! };
}

interface LocalDateTime {
  day: number;
  hour: number;
  minute: number;
  month: number;
  year: number;
}

function parseLocalDateTime(value: string): LocalDateTime | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const valid = new Date(Date.UTC(year, month - 1, day));
  return valid.getUTCFullYear() === year &&
    valid.getUTCMonth() === month - 1 &&
    valid.getUTCDate() === day &&
    hour < 24 &&
    minute < 60
    ? { year, month, day, hour, minute }
    : undefined;
}

function sameLocalTime(instant: Date, timezone: string, expected: LocalDateTime): boolean {
  const values = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(instant);
  const value = (kind: Intl.DateTimeFormatPartTypes) =>
    Number(values.find((part) => part.type === kind)?.value);
  return (
    value('year') === expected.year &&
    value('month') === expected.month &&
    value('day') === expected.day &&
    value('hour') === expected.hour &&
    value('minute') === expected.minute
  );
}

function isIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
