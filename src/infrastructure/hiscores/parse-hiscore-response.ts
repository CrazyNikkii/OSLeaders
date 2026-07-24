import type {
  CompleteOsrsHiscores,
  HiscoreActivity,
  HiscoreParseResult,
  HiscoreSkill,
} from './hiscore-result.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  OSRS_SKILL_NAMES,
  type OsrsBossActivityName,
  type OsrsSkillName,
} from './osrs-hiscore-catalog.js';

const skillNames = new Set<string>(OSRS_SKILL_NAMES);
const bossNames = new Set<string>(OSRS_BOSS_ACTIVITY_NAMES);

interface ParsedRow {
  id: number;
  name: string;
  rank: number;
}

export function parseHiscoreJson(body: string): HiscoreParseResult {
  let decoded: unknown;

  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    return malformed('Response is not valid JSON.');
  }

  return parseHiscoreResponse(decoded);
}

export function parseHiscoreResponse(input: unknown): HiscoreParseResult {
  if (!isRecord(input)) {
    return malformed('Response must be an object.');
  }

  if (typeof input.name !== 'string' || input.name.length === 0) {
    return malformed('Response name must be a non-empty string.');
  }

  const parsedSkills = parseRows(input.skills, parseSkill);
  if (parsedSkills.kind === 'malformed_response') {
    return parsedSkills;
  }

  const parsedActivities = parseRows(input.activities, parseActivity);
  if (parsedActivities.kind === 'malformed_response') {
    return parsedActivities;
  }

  const missingSkills = missingNames(OSRS_SKILL_NAMES, parsedSkills.rows);
  const missingBosses = missingNames(OSRS_BOSS_ACTIVITY_NAMES, parsedActivities.rows);
  const missing = [
    ...missingSkills.map((name) => `skill:${name}`),
    ...missingBosses.map((name) => `activity:${name}`),
  ];

  if (missing.length > 0) {
    return { kind: 'incomplete_response', missing };
  }

  const skills = parsedSkills.rows.filter((row): row is HiscoreSkill => skillNames.has(row.name));
  const bosses = parsedActivities.rows.filter(
    (row): row is HiscoreActivity & { name: OsrsBossActivityName } => bossNames.has(row.name),
  );

  const data: CompleteOsrsHiscores = {
    activities: parsedActivities.rows,
    bosses,
    returnedName: input.name,
    skills,
  };

  return { kind: 'success', data };
}

function parseSkill(input: unknown, index: number): HiscoreSkill | string {
  const common = parseCommonRow(input, `skills[${index}]`);
  if (typeof common === 'string') {
    return common;
  }

  if (!isRecord(input)) {
    return `skills[${index}] must be an object.`;
  }

  if (!isIntegerAtLeast(input.level, 1)) {
    return `skills[${index}].level must be an integer of at least 1.`;
  }

  if (!isIntegerAtLeast(input.xp, -1)) {
    return `skills[${index}].xp must be an integer of at least -1.`;
  }

  return {
    experience: input.xp,
    id: common.id,
    level: input.level,
    name: common.name as OsrsSkillName,
    rank: common.rank,
  };
}

function parseActivity(input: unknown, index: number): HiscoreActivity | string {
  const common = parseCommonRow(input, `activities[${index}]`);
  if (typeof common === 'string') {
    return common;
  }

  if (!isRecord(input)) {
    return `activities[${index}] must be an object.`;
  }

  if (!isIntegerAtLeast(input.score, -1)) {
    return `activities[${index}].score must be an integer of at least -1.`;
  }

  return {
    ...common,
    score: input.score,
  };
}

function parseCommonRow(input: unknown, path: string): ParsedRow | string {
  if (!isRecord(input)) {
    return `${path} must be an object.`;
  }

  if (!isIntegerAtLeast(input.id, 0)) {
    return `${path}.id must be a non-negative integer.`;
  }

  if (typeof input.name !== 'string' || input.name.length === 0) {
    return `${path}.name must be a non-empty string.`;
  }

  if (!isIntegerAtLeast(input.rank, -1)) {
    return `${path}.rank must be an integer of at least -1.`;
  }

  return {
    id: input.id,
    name: input.name,
    rank: input.rank,
  };
}

function parseRows<Row extends ParsedRow>(
  input: unknown,
  parse: (value: unknown, index: number) => Row | string,
): { kind: 'success'; rows: Row[] } | Extract<HiscoreParseResult, { kind: 'malformed_response' }> {
  if (!Array.isArray(input)) {
    return malformed('Hiscore row collection must be an array.');
  }

  const rows: Row[] = [];
  const ids = new Set<number>();
  const names = new Set<string>();

  for (const [index, value] of input.entries()) {
    const row = parse(value, index);

    if (typeof row === 'string') {
      return malformed(row);
    }

    if (ids.has(row.id)) {
      return malformed(`Hiscore row ID ${row.id} is duplicated.`);
    }

    if (names.has(row.name)) {
      return malformed(`Hiscore row name ${row.name} is duplicated.`);
    }

    ids.add(row.id);
    names.add(row.name);
    rows.push(row);
  }

  return { kind: 'success', rows };
}

function missingNames<const Name extends string>(
  expected: readonly Name[],
  actual: readonly ParsedRow[],
): Name[] {
  const actualNames = new Set(actual.map((row) => row.name));
  return expected.filter((name) => !actualNames.has(name));
}

function malformed(reason: string): Extract<HiscoreParseResult, { kind: 'malformed_response' }> {
  return { kind: 'malformed_response', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
