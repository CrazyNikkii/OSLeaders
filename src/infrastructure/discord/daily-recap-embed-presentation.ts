import { EmbedBuilder } from 'discord.js';

import { dailyRecapEmbedFooter } from '../../features/recaps/send-daily-recap.js';
import { OSLEADERS_EMBED_COLOR } from './discord-embed-presentation.js';

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
      .setColor(OSLEADERS_EMBED_COLOR)
      .setDescription(page)
      .setFooter({
        text: [dailyRecapEmbedFooter, ...(presentation.footerDetails ?? [])].join(' · '),
      })
      .setTitle(
        `${presentation.title}${presentation.pages.length > 1 ? ` (${index + 1}/${presentation.pages.length})` : ''}`,
      ),
  );
}
