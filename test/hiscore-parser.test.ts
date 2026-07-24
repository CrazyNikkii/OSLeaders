import { describe, expect, it } from 'vitest';

import completeResponse from './fixtures/hiscores/complete-osrs-response.json' with { type: 'json' };
import {
  parseHiscoreJson,
  parseHiscoreResponse,
} from '../src/infrastructure/hiscores/parse-hiscore-response.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  OSRS_MODE_FETCH_STRATEGIES,
  OSRS_SKILL_NAMES,
} from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('OSRS Hiscores contract', () => {
  it('uses only Old School RuneScape endpoints', () => {
    for (const strategy of Object.values(OSRS_MODE_FETCH_STRATEGIES)) {
      expect(strategy.endpoint).toMatch(/^hiscore_oldschool/);
      expect(strategy.endpoint).not.toContain('rs3');
    }
  });

  it('keeps Group Ironman modes as server-managed labels', () => {
    expect(OSRS_MODE_FETCH_STRATEGIES.group_ironman).toEqual({
      endpoint: 'hiscore_oldschool',
      verification: 'server_managed',
    });
    expect(OSRS_MODE_FETCH_STRATEGIES.hardcore_group_ironman).toEqual({
      endpoint: 'hiscore_oldschool',
      verification: 'server_managed',
    });
  });

  it('requires specific-mode exclusion before verifying regular Ironman', () => {
    expect(OSRS_MODE_FETCH_STRATEGIES.ironman).toEqual({
      endpoint: 'hiscore_oldschool_ironman',
      verification: 'requires_specific_mode_exclusion',
    });
  });
});

describe('OSRS Hiscores JSON parser', () => {
  it('parses a complete named response including Sailing and current bosses', () => {
    const result = parseHiscoreResponse(completeResponse);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }

    expect(result.data.returnedName).toBe('Fixture Player');
    expect(result.data.skills.map(({ name }) => name)).toEqual(OSRS_SKILL_NAMES);
    expect(result.data.bosses.map(({ name }) => name)).toEqual(OSRS_BOSS_ACTIVITY_NAMES);
    expect(result.data.skills.at(-1)).toMatchObject({
      experience: 0,
      level: 1,
      name: 'Sailing',
      rank: -1,
    });
    expect(result.data.bosses.find(({ name }) => name === 'Maggot King')).toMatchObject({
      rank: -1,
      score: -1,
    });
  });

  it('retains an unknown additional activity without treating it as a boss', () => {
    const response = structuredClone(completeResponse);
    response.activities.push({
      id: 90,
      name: 'Future Jagex Activity',
      rank: -1,
      score: -1,
    });
    const result = parseHiscoreResponse(response);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }

    expect(result.data.activities.at(-1)?.name).toBe('Future Jagex Activity');
    expect(result.data.bosses.some(({ name }) => String(name) === 'Future Jagex Activity')).toBe(
      false,
    );
  });

  it('parses all 90 activities in the representative current response', () => {
    const result = parseHiscoreResponse(completeResponse);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') {
      return;
    }

    expect(result.data.activities).toHaveLength(90);
    expect(result.data.activities.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'Grid Points',
        'Clue Scrolls (master)',
        'Collections Logged',
        'Abyssal Sire',
        'Zulrah',
      ]),
    );
  });

  it.each([
    ['skill', 'skills', 'Sailing'],
    ['boss activity', 'activities', 'Abyssal Sire'],
  ] as const)('reports a missing required %s as incomplete', (_, collection, name) => {
    const response = structuredClone(completeResponse);
    response[collection] = response[collection].filter((row) => row.name !== name) as never;

    expect(parseHiscoreResponse(response)).toEqual({
      kind: 'incomplete_response',
      missing: [`${collection === 'skills' ? 'skill' : 'activity'}:${name}`],
    });
  });

  it.each([
    ['duplicate skill ID', 'skills', 'id'],
    ['duplicate skill name', 'skills', 'name'],
    ['duplicate activity ID', 'activities', 'id'],
    ['duplicate activity name', 'activities', 'name'],
  ] as const)('rejects a %s as malformed', (_, collection, field) => {
    const response = structuredClone(completeResponse);
    const rows = response[collection];
    const first = rows[0];
    const second = rows[1];

    if (first === undefined || second === undefined) {
      throw new Error('Fixture must contain at least two rows.');
    }

    Object.assign(second, { [field]: first[field] });

    expect(parseHiscoreResponse(response)).toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['non-object response', null],
    ['missing name', { ...completeResponse, name: undefined }],
    ['non-array skills', { ...completeResponse, skills: {} }],
    ['non-array activities', { ...completeResponse, activities: {} }],
  ])('rejects a %s', (_, input) => {
    expect(parseHiscoreResponse(input)).toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['fractional ID', 'id', 1.5],
    ['negative ID', 'id', -1],
    ['rank below sentinel', 'rank', -2],
    ['level below minimum', 'level', 0],
    ['XP below sentinel', 'xp', -2],
  ] as const)('rejects a skill with %s', (_, field, value) => {
    const response = structuredClone(completeResponse);
    const skill = response.skills[0];
    if (skill === undefined) {
      throw new Error('Fixture must contain a skill.');
    }
    Object.assign(skill, { [field]: value });

    expect(parseHiscoreResponse(response)).toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['rank below sentinel', 'rank', -2],
    ['score below sentinel', 'score', -2],
    ['fractional score', 'score', 1.5],
  ] as const)('rejects an activity with %s', (_, field, value) => {
    const response = structuredClone(completeResponse);
    const activity = response.activities[0];
    if (activity === undefined) {
      throw new Error('Fixture must contain an activity.');
    }
    Object.assign(activity, { [field]: value });

    expect(parseHiscoreResponse(response)).toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['skill ID', 'skills', 'id'],
    ['skill rank', 'skills', 'rank'],
    ['skill level', 'skills', 'level'],
    ['skill XP', 'skills', 'xp'],
    ['activity ID', 'activities', 'id'],
    ['activity rank', 'activities', 'rank'],
    ['activity score', 'activities', 'score'],
  ] as const)('rejects an unsafe integer in %s', (_, collection, field) => {
    const response = structuredClone(completeResponse);
    const row = response[collection][0];
    if (row === undefined) {
      throw new Error('Fixture must contain a row.');
    }
    Object.assign(row, { [field]: Number.MAX_SAFE_INTEGER + 1 });

    expect(parseHiscoreResponse(response)).toMatchObject({
      kind: 'malformed_response',
    });
  });

  it.each([
    ['skill ID', 'skills', 'id'],
    ['skill rank', 'skills', 'rank'],
    ['skill level', 'skills', 'level'],
    ['skill XP', 'skills', 'xp'],
    ['activity ID', 'activities', 'id'],
    ['activity rank', 'activities', 'rank'],
    ['activity score', 'activities', 'score'],
  ] as const)('accepts the safe-integer boundary in %s', (_, collection, field) => {
    const response = structuredClone(completeResponse);
    const row = response[collection][0];
    if (row === undefined) {
      throw new Error('Fixture must contain a row.');
    }
    Object.assign(row, { [field]: Number.MAX_SAFE_INTEGER });

    expect(parseHiscoreResponse(response)).toMatchObject({
      kind: 'success',
    });
  });

  it('rejects invalid JSON at the decoding boundary', () => {
    expect(parseHiscoreJson('{"name":')).toEqual({
      kind: 'malformed_response',
      reason: 'Response is not valid JSON.',
    });
  });

  it('parses a serialized complete fixture', () => {
    expect(parseHiscoreJson(JSON.stringify(completeResponse))).toMatchObject({
      kind: 'success',
    });
  });
});
