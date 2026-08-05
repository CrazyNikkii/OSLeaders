import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

import {
  OSRS_BOSS_ACTIVITY_NAMES,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';

const MAX_BOSS_OPTIONS_PER_MENU = 25;

export interface BossChoice {
  label: OsrsBossActivityName;
  value: OsrsBossActivityName;
}

export const bossChoiceGroups: readonly (readonly BossChoice[])[] =
  chunkBossChoices(OSRS_BOSS_ACTIVITY_NAMES);

export function bossChoiceMenuRows(
  customIdForGroup: (groupIndex: number) => string,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return bossChoiceGroups.map((choices, index) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customIdForGroup(index))
        .setPlaceholder(`Choose boss (${bossChoiceGroupLabel(choices)})`)
        .addOptions([...choices]),
    ),
  );
}

export function chunkBossChoices(
  bosses: readonly OsrsBossActivityName[],
): readonly (readonly BossChoice[])[] {
  const orderedBosses = [...bosses].sort((left, right) =>
    bossChoiceSortKey(left).localeCompare(bossChoiceSortKey(right), 'en'),
  );
  const groups: BossChoice[][] = [];
  for (let index = 0; index < orderedBosses.length; index += MAX_BOSS_OPTIONS_PER_MENU) {
    groups.push(
      orderedBosses
        .slice(index, index + MAX_BOSS_OPTIONS_PER_MENU)
        .map((value) => ({ label: value, value })),
    );
  }
  return groups;
}

export function bossChoiceSortKey(name: string): string {
  return name.replace(/^the\s+/i, '');
}

export function bossChoiceGroupLabel(choices: readonly BossChoice[]): string {
  const first = choices[0];
  const last = choices.at(-1);
  if (first === undefined || last === undefined) return '?';
  const firstLetter = bossChoiceSortKey(first.label).at(0)?.toUpperCase() ?? '?';
  const lastLetter = bossChoiceSortKey(last.label).at(0)?.toUpperCase() ?? '?';
  return firstLetter === lastLetter ? firstLetter : `${firstLetter}–${lastLetter}`;
}
