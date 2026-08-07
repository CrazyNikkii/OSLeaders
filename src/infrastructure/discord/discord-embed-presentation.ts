import type { OsrsAccountMode } from '../hiscores/osrs-hiscore-catalog.js';

export const OSLEADERS_EMBED_COLOR = 0xd99b36;
export const OSLEADERS_SUCCESS_EMBED_COLOR = 0x57a773;

export function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export function formatHiscoreRank(rank: number): string {
  return rank === -1 ? 'Unranked' : `#${rank.toLocaleString('en-US')}`;
}
