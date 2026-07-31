import type { DailyRecapPreview, DailyRecapPreviewService } from './daily-recap-presentation.js';

export interface PreviewDailyRecapRequest {
  guildId: string;
  isGuildMember: boolean;
  requesterDiscordUserId: string;
}

export type PreviewDailyRecapResult =
  { kind: 'forbidden' } | { kind: 'previewed'; preview: DailyRecapPreview };

export class PreviewDailyRecapService {
  public constructor(private readonly previews: Pick<DailyRecapPreviewService, 'preview'>) {}

  public async preview(request: PreviewDailyRecapRequest): Promise<PreviewDailyRecapResult> {
    if (!request.isGuildMember) {
      return { kind: 'forbidden' };
    }

    return { kind: 'previewed', preview: await this.previews.preview(request.guildId) };
  }
}
