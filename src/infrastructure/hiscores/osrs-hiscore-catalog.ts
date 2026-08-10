export const OSRS_ACCOUNT_MODES = [
  'main',
  'ironman',
  'hardcore_ironman',
  'ultimate_ironman',
  'group_ironman',
  'hardcore_group_ironman',
] as const;

export type OsrsAccountMode = (typeof OSRS_ACCOUNT_MODES)[number];

export const OSRS_HISCORE_ENDPOINTS = {
  standard: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  hardcoreIronman: 'hiscore_oldschool_hardcore_ironman',
  ultimateIronman: 'hiscore_oldschool_ultimate',
} as const;

export type OsrsHiscoreEndpoint =
  (typeof OSRS_HISCORE_ENDPOINTS)[keyof typeof OSRS_HISCORE_ENDPOINTS];

export interface OsrsModeFetchStrategy {
  endpoint: OsrsHiscoreEndpoint;
  verification: 'endpoint_verified' | 'requires_specific_mode_exclusion' | 'server_managed';
}

export const OSRS_MODE_FETCH_STRATEGIES: Readonly<Record<OsrsAccountMode, OsrsModeFetchStrategy>> =
  {
    main: {
      endpoint: OSRS_HISCORE_ENDPOINTS.standard,
      verification: 'server_managed',
    },
    ironman: {
      endpoint: OSRS_HISCORE_ENDPOINTS.ironman,
      verification: 'requires_specific_mode_exclusion',
    },
    hardcore_ironman: {
      endpoint: OSRS_HISCORE_ENDPOINTS.hardcoreIronman,
      verification: 'endpoint_verified',
    },
    ultimate_ironman: {
      endpoint: OSRS_HISCORE_ENDPOINTS.ultimateIronman,
      verification: 'endpoint_verified',
    },
    group_ironman: {
      endpoint: OSRS_HISCORE_ENDPOINTS.standard,
      verification: 'server_managed',
    },
    hardcore_group_ironman: {
      endpoint: OSRS_HISCORE_ENDPOINTS.standard,
      verification: 'server_managed',
    },
  };

export const OSRS_SKILL_NAMES = [
  'Overall',
  'Attack',
  'Defence',
  'Strength',
  'Hitpoints',
  'Ranged',
  'Prayer',
  'Magic',
  'Cooking',
  'Woodcutting',
  'Fletching',
  'Fishing',
  'Firemaking',
  'Crafting',
  'Smithing',
  'Mining',
  'Herblore',
  'Agility',
  'Thieving',
  'Slayer',
  'Farming',
  'Runecraft',
  'Hunter',
  'Construction',
  'Sailing',
] as const;

export type OsrsSkillName = (typeof OSRS_SKILL_NAMES)[number];

// These are the boss and boss-like activity values used by OSLeaders. Jagex
// may add unrelated activities without making an otherwise complete response
// unusable, so parsing requires these names and retains additional rows.
export const OSRS_BOSS_ACTIVITY_NAMES = [
  'Abyssal Sire',
  'Alchemical Hydra',
  'Amoxliatl',
  'Araxxor',
  'Artio',
  'Barrows Chests',
  'Brutus',
  'Bryophyta',
  'Callisto',
  "Calvar'ion",
  'Cerberus',
  'Chambers of Xeric',
  'Chambers of Xeric: Challenge Mode',
  'Chaos Elemental',
  'Chaos Fanatic',
  'Commander Zilyana',
  'Corporeal Beast',
  'Crazy Archaeologist',
  'Dagannoth Prime',
  'Dagannoth Rex',
  'Dagannoth Supreme',
  'Deranged Archaeologist',
  'Doom of Mokhaiotl',
  'Duke Sucellus',
  'General Graardor',
  'Giant Mole',
  'Grotesque Guardians',
  'Hespori',
  'Kalphite Queen',
  'King Black Dragon',
  'Kraken',
  "Kree'Arra",
  "K'ril Tsutsaroth",
  'Lunar Chests',
  'Mad Angel',
  'Mimic',
  'Maggot King',
  'Nex',
  'Nightmare',
  "Phosani's Nightmare",
  'Obor',
  'Phantom Muspah',
  'Sarachnis',
  'Scorpia',
  'Scurrius',
  'Shellbane Gryphon',
  'Skotizo',
  'Sol Heredit',
  'Spindel',
  'Tempoross',
  'The Gauntlet',
  'The Corrupted Gauntlet',
  'The Hueycoatl',
  'The Leviathan',
  'The Royal Titans',
  'The Whisperer',
  'Theatre of Blood',
  'Theatre of Blood: Hard Mode',
  'Thermonuclear Smoke Devil',
  'Tombs of Amascut',
  'Tombs of Amascut: Expert Mode',
  'TzKal-Zuk',
  'TzTok-Jad',
  'Vardorvis',
  'Venenatis',
  "Vet'ion",
  'Vorkath',
  'Wintertodt',
  'Yama',
  'Zalcano',
  'Zulrah',
] as const;

export type OsrsBossActivityName = (typeof OSRS_BOSS_ACTIVITY_NAMES)[number];
