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
  const accounts = [
    ...presentation.linkedMembers.flatMap((member) => member.accounts),
    ...presentation.watchlistAccounts,
  ];
  const sections = [
    ...(accounts.length === 0 ? [] : summaryLines(accounts)),
    ...presentation.linkedMembers.flatMap((member) => [
      `**<@${member.discordUserId}>**`,
      ...member.accounts.flatMap(accountLines),
    ]),
    ...(presentation.watchlistAccounts.length === 0
      ? []
      : ['**Watchlist accounts**', ...presentation.watchlistAccounts.flatMap(accountLines)]),
    ...(presentation.noActivity ? ['**Activity**', 'No notable activity today.'] : []),
    ...(presentation.failures.length === 0
      ? []
      : ['**Unavailable accounts**', ...presentation.failures.map(formatFailure)]),
  ];
  return sections.join('\n');
}

function accountLines(entry: DailyRecapAccountPresentation): string[] {
  const lines = [`**${entry.account.displayUsername}** · ${accountModeLabel(entry.account)}`];
  if (entry.changes.bosses.length > 0) {
    lines.push(
      `**+${formatNumber(totalBossKillCount(entry))} KC** · ${entry.changes.bosses
        .map((change) => `${change.boss} +${formatNumber(change.killCountGained)}`)
        .join(' · ')}`,
    );
  }
  if (entry.changes.skills.length > 0) {
    lines.push(
      `**+${formatCompactNumber(totalExperience(entry))} XP** · ${entry.changes.skills
        .map(formatSkillChange)
        .join(' · ')}`,
    );
  }
  return lines;
}

function summaryLines(accounts: readonly DailyRecapAccountPresentation[]): string[] {
  const totalXp = accounts.reduce((total, account) => total + totalExperience(account), 0);
  const totalBossKills = accounts.reduce(
    (total, account) => total + totalBossKillCount(account),
    0,
  );
  const totalLevels = accounts.reduce(
    (total, account) =>
      total +
      account.changes.skills.reduce((skillTotal, skill) => skillTotal + skill.levelGained, 0),
    0,
  );
  const gains = [
    ...(totalXp === 0 ? [] : [`**${formatCompactNumber(totalXp)} XP gained**`]),
    ...(totalBossKills === 0 ? [] : [`**${formatNumber(totalBossKills)} boss KC**`]),
    ...(totalLevels === 0
      ? []
      : [`**${formatNumber(totalLevels)} ${totalLevels === 1 ? 'level' : 'levels'}**`]),
  ];
  return [
    `*${accounts.length} active ${accounts.length === 1 ? 'account' : 'accounts'} · compared with account-specific baselines*`,
    ...gains,
  ];
}

function totalExperience(entry: DailyRecapAccountPresentation): number {
  return entry.changes.skills.reduce((total, change) => total + change.experienceGained, 0);
}

function totalBossKillCount(entry: DailyRecapAccountPresentation): number {
  return entry.changes.bosses.reduce((total, change) => total + change.killCountGained, 0);
}

function formatSkillChange(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): string {
  const experience =
    change.experienceGained === 0 ? '' : ` +${formatCompactNumber(change.experienceGained)}`;
  const level = change.levelGained === 0 ? '' : ` → ${change.currentLevel}`;
  return `${change.skill}${experience}${level}`;
}

function formatCompactNumber(value: number): string {
  if (value < 1_000) return formatNumber(value);
  const divisor = value >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = divisor === 1_000_000 ? 'M' : 'K';
  const scaled = value / divisor;
  const fractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(fractionDigits))}${suffix}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
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
