import { describe, expect, it } from 'vitest';

import { resolveScheduledCompetitionStart } from '../src/features/competitions/resolve-scheduled-start.js';

describe('scheduled competition start resolution', () => {
  it('resolves an unambiguous local wall-clock time to its UTC instant', () => {
    expect(resolveScheduledCompetitionStart('2026-08-10 15:30', 'Europe/Helsinki')).toEqual({
      kind: 'resolved',
      intendedStartAt: new Date('2026-08-10T12:30:00.000Z'),
    });
  });

  it('rejects invalid input, unknown timezones, daylight-saving gaps, and ambiguous times', () => {
    expect(resolveScheduledCompetitionStart('10 August 2026', 'Europe/Helsinki')).toEqual({
      kind: 'invalid_format',
    });
    expect(resolveScheduledCompetitionStart('2026-08-10 15:30', 'Not/A_Timezone')).toEqual({
      kind: 'invalid_timezone',
    });
    expect(resolveScheduledCompetitionStart('2026-03-29 03:30', 'Europe/Helsinki')).toEqual({
      kind: 'nonexistent_local_time',
    });
    expect(resolveScheduledCompetitionStart('2026-10-25 03:30', 'Europe/Helsinki')).toEqual({
      kind: 'ambiguous_local_time',
    });
  });
});
