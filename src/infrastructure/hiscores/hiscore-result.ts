import type {
  OsrsAccountMode,
  OsrsBossActivityName,
  OsrsHiscoreEndpoint,
  OsrsSkillName,
} from './osrs-hiscore-catalog.js';

export interface HiscoreSkill {
  experience: number;
  id: number;
  level: number;
  name: OsrsSkillName;
  rank: number;
}

export interface HiscoreActivity {
  id: number;
  name: string;
  rank: number;
  score: number;
}

export interface CompleteOsrsHiscores {
  activities: readonly HiscoreActivity[];
  bosses: readonly (HiscoreActivity & { name: OsrsBossActivityName })[];
  returnedName: string;
  skills: readonly HiscoreSkill[];
}

export type HiscoreFailure =
  | { kind: 'not_found' }
  | { kind: 'mode_incompatible' }
  | { kind: 'timeout' }
  | { kind: 'temporary_upstream_failure' }
  | { kind: 'malformed_response'; reason: string }
  | { kind: 'incomplete_response'; missing: readonly string[] };

export type HiscoreResult =
  | {
      kind: 'success';
      accountMode: OsrsAccountMode;
      data: CompleteOsrsHiscores;
      endpoint: OsrsHiscoreEndpoint;
      modeVerification: 'endpoint_verified' | 'server_managed';
    }
  | HiscoreFailure;

export type HiscoreParseResult =
  | { kind: 'success'; data: CompleteOsrsHiscores }
  | Extract<HiscoreFailure, { kind: 'malformed_response' | 'incomplete_response' }>;
