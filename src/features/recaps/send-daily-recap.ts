import { randomUUID } from 'node:crypto';

import type { InitialRecapBaseline } from '../accounts/register-account.js';
import type {
  DailyRecapCollectionOutcome,
  DailyRecapCollectionResult,
} from './daily-recap-collection.js';
import {
  MINIMUM_VISIBLE_DAILY_RECAP_XP,
  type DailyRecapAccountPresentation,
  type DailyRecapFailurePresentation,
  type DailyRecapPresentation,
  presentDailyRecap,
} from './daily-recap-presentation.js';
import type { DailyRecapFailureReporter } from './report-daily-recap-failures.js';

export interface PendingDailyRecapRun {
  recapChannelId: string;
  recapRunId: string;
}

export type StartManualDailyRecapRunResult =
  | { kind: 'started'; run: PendingDailyRecapRun }
  | { kind: 'recap_not_configured' }
  | { kind: 'recap_already_running' };

export interface FinalizeManualDailyRecapRunRequest {
  collection: DailyRecapCollectionResult;
  deliveryContent: string;
  guildId: string;
  recapChannelId: string;
  recapRunId: string;
}

export interface ManualDailyRecapSendRepository {
  finalizeManualRun(request: FinalizeManualDailyRecapRunRequest): Promise<void>;
  failManualRun(guildId: string, recapRunId: string, failureSummary: string): Promise<void>;
  startManualRun(guildId: string, recapRunId: string): Promise<StartManualDailyRecapRunResult>;
}

export interface ManualDailyRecapCollector {
  collect(guildId: string): Promise<DailyRecapCollectionResult>;
}

export interface ManualDailyRecapSendReady {
  collection: DailyRecapCollectionResult;
  kind: 'ready_for_delivery';
  presentation: DailyRecapPresentation;
  recapChannelId: string;
  recapRunId: string;
}

export type ManualDailyRecapSendResult =
  ManualDailyRecapSendReady | { kind: 'recap_not_configured' } | { kind: 'recap_already_running' };

export class ManualDailyRecapSendService {
  public constructor(
    private readonly repository: ManualDailyRecapSendRepository,
    private readonly collector: ManualDailyRecapCollector,
    private readonly createId: () => string = randomUUID,
    private readonly failureReporter: DailyRecapFailureReporter = {
      report: () => Promise.resolve(),
    },
  ) {}

  public async send(guildId: string): Promise<ManualDailyRecapSendResult> {
    const started = await this.repository.startManualRun(guildId, this.createId());
    if (started.kind !== 'started') {
      return started;
    }

    try {
      const collection = await this.collector.collect(guildId);
      assertCollectionBelongsToGuild(collection, guildId);
      const presentation = presentDailyRecap(collection);
      await this.repository.finalizeManualRun({
        collection,
        deliveryContent: renderDailyRecapDeliveryContent(presentation),
        guildId,
        recapChannelId: started.run.recapChannelId,
        recapRunId: started.run.recapRunId,
      });
      try {
        await this.failureReporter.report(collection);
      } catch {
        // Audit delivery is optional and must not fail a finalized recap send.
      }
      return {
        collection,
        kind: 'ready_for_delivery',
        presentation,
        recapChannelId: started.run.recapChannelId,
        recapRunId: started.run.recapRunId,
      };
    } catch (error) {
      await this.repository.failManualRun(guildId, started.run.recapRunId, failureSummary(error));
      throw error;
    }
  }
}

export function successfulBaselineReplacements(
  outcomes: readonly DailyRecapCollectionOutcome[],
): readonly { accountId: string; baseline: InitialRecapBaseline }[] {
  return outcomes.flatMap((outcome) =>
    outcome.kind === 'success'
      ? [{ accountId: outcome.account.id, baseline: outcome.candidateBaseline }]
      : [],
  );
}

export function assertCollectionBelongsToGuild(
  collection: DailyRecapCollectionResult,
  guildId: string,
): void {
  if (collection.guildId !== guildId) {
    throw new Error('Daily recap collection belongs to a different guild.');
  }
  if (collection.outcomes.some((outcome) => outcome.account.guildId !== guildId)) {
    throw new Error('Daily recap collection contains an account from a different guild.');
  }
}

export function renderDailyRecapDeliveryContent(presentation: DailyRecapPresentation): string {
  const sections = [
    ...presentation.linkedMembers.map((member) => ({
      heading: `<@${member.discordUserId}>`,
      lines: member.accounts.flatMap(accountLines),
    })),
    ...(presentation.watchlistAccounts.length === 0
      ? []
      : [
          {
            heading: 'Watchlist accounts',
            lines: presentation.watchlistAccounts.flatMap(accountLines),
          },
        ]),
    ...(presentation.noActivity
      ? [
          {
            heading: 'Activity',
            lines: ['No notable activity today.'],
          },
        ]
      : []),
    ...(presentation.failures.length === 0
      ? []
      : [{ heading: 'Unavailable accounts', lines: presentation.failures.map(formatFailure) }]),
  ];
  return sections.flatMap((section) => [`**${section.heading}**`, ...section.lines]).join('\n');
}

function accountLines(entry: DailyRecapAccountPresentation): string[] {
  const lines = [
    `**${entry.account.displayUsername} · ${accountModeLabel(entry.account)}**`,
    `*Since <t:${Math.floor(entry.previousBaselineCapturedAt.getTime() / 1_000)}:R>*`,
  ];
  if (entry.changes.bosses.length > 0) {
    lines.push(
      '**Boss activities**',
      ...entry.changes.bosses.map(
        (change) => `• ${change.boss}: +${change.killCountGained.toLocaleString('en-US')} KC`,
      ),
    );
  }
  if (entry.changes.skills.length > 0) {
    lines.push('**Skills**', ...entry.changes.skills.map(formatSkillChange));
  }
  return lines;
}

function formatSkillChange(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): string {
  const gains: string[] = [];
  if (change.experienceGained > 0) {
    gains.push(`+${change.experienceGained.toLocaleString('en-US')} XP`);
  }
  if (change.levelGained > 0) {
    gains.push(
      `+${change.levelGained} ${change.levelGained === 1 ? 'level' : 'levels'} → ${change.currentLevel}`,
    );
  }
  return `• ${change.skill}: ${gains.join(', ')}`;
}

export const dailyRecapEmbedFooter = `Showing XP gains of ${MINIMUM_VISIBLE_DAILY_RECAP_XP.toLocaleString('en-US')}+`;

function formatFailure(entry: DailyRecapFailurePresentation): string {
  return `**${entry.account.displayUsername}** (${accountModeLabel(entry.account)}) — ${failureMessage(entry)}`;
}

function failureMessage(entry: DailyRecapFailurePresentation): string {
  switch (entry.failure.kind) {
    case 'not_found':
      return 'not found on Hiscores';
    case 'timeout':
      return 'Hiscores timed out';
    case 'temporary_upstream_failure':
      return 'Hiscores is temporarily unavailable';
    case 'mode_incompatible':
      return 'the selected mode is incompatible with Hiscores';
    case 'malformed_response':
      return 'Hiscores returned malformed data';
    case 'incomplete_response':
      return 'Hiscores returned incomplete data';
    case 'baseline_incomplete':
      return 'its stored recap baseline is incomplete';
  }
}

function accountModeLabel(account: DailyRecapAccountPresentation['account']): string {
  return account.accountMode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function failureSummary(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unexpected recap collection failure.';
}
