import { EmbedBuilder } from 'discord.js';

import { dailyRecapEmbedFooter } from '../../features/recaps/send-daily-recap.js';

const DAILY_RECAP_EMBED_COLOR = 0xd99b36;

export interface DailyRecapEmbedPresentation {
  footerDetails?: readonly string[];
  pages: readonly string[];
  title: string;
}

export function createDailyRecapEmbeds(
  presentation: DailyRecapEmbedPresentation,
): readonly EmbedBuilder[] {
  return presentation.pages.map((page, index) =>
    new EmbedBuilder()
      .setColor(DAILY_RECAP_EMBED_COLOR)
      .setDescription(page)
      .setFooter({
        text: [dailyRecapEmbedFooter, ...(presentation.footerDetails ?? [])].join(' · '),
      })
      .setTitle(
        `${presentation.title}${presentation.pages.length > 1 ? ` (${index + 1}/${presentation.pages.length})` : ''}`,
      ),
  );
}
