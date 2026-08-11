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
  const activityBlocks = [
    ...presentation.linkedMembers.map((member) =>
      [`**<@${member.discordUserId}>**`, ...accountBlocks(member.accounts)].join('\n'),
    ),
    ...(presentation.watchlistAccounts.length === 0
      ? []
      : [['**Watchlist accounts**', ...accountBlocks(presentation.watchlistAccounts)].join('\n')]),
  ];
  return [
    ...summaryLines(accounts),
    ...(activityBlocks.length === 0 ? [] : [activityBlocks.join(`\n\n${PLAYER_DIVIDER}\n\n`)]),
    ...(presentation.noActivity ? ['**Activity**', 'No notable activity today.'] : []),
    ...(presentation.failures.length === 0
      ? []
      : ['**Unavailable accounts**', ...presentation.failures.map(formatFailure)]),
  ].join('\n\n');
}

const PLAYER_DIVIDER = '──────────────';

function accountBlocks(entries: readonly DailyRecapAccountPresentation[]): string[] {
  return entries.flatMap((entry, index) =>
    index === 0 ? [accountLines(entry)] : ['', accountLines(entry)],
  );
}

function accountLines(entry: DailyRecapAccountPresentation): string {
  return [
    `**${entry.account.displayUsername}** · ${accountModeLabel(entry.account)}`,
    ...entry.changes.bosses.map(
      (change) => `• ${change.boss}: +${formatNumber(change.killCountGained)} KC`,
    ),
    ...(entry.changes.skills.length === 0
      ? []
      : [`**+${formatCompactNumber(overallExperience(entry))} XP**`]),
    ...entry.changes.skills.filter(isNonOverallSkill).map(formatSkillExperience),
    ...entry.changes.skills.filter(isNonOverallSkill).flatMap(formatLevelUp),
  ].join('\n');
}

function summaryLines(accounts: readonly DailyRecapAccountPresentation[]): string[] {
  const totalXp = accounts.reduce((total, account) => total + overallExperience(account), 0);
  const totalBossKills = accounts.reduce(
    (total, account) => total + totalBossKillCount(account),
    0,
  );
  const totalLevels = accounts.reduce(
    (total, account) =>
      total +
      account.changes.skills
        .filter(isNonOverallSkill)
        .reduce((skillTotal, skill) => skillTotal + skill.levelGained, 0),
    0,
  );
  const gains = [
    ...(totalXp === 0 ? [] : [`**${formatCompactNumber(totalXp)} XP gained**`]),
    ...(totalBossKills === 0 ? [] : [`**${formatNumber(totalBossKills)} boss KC**`]),
    ...(totalLevels === 0
      ? []
      : [`**${formatNumber(totalLevels)} ${totalLevels === 1 ? 'level' : 'levels'}**`]),
  ];
  return gains;
}

function overallExperience(entry: DailyRecapAccountPresentation): number {
  const overall = entry.changes.skills.find((change) => change.skill === 'Overall');
  return (
    overall?.experienceGained ??
    entry.changes.skills
      .filter(isNonOverallSkill)
      .reduce((total, change) => total + change.experienceGained, 0)
  );
}

function isNonOverallSkill(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): boolean {
  return change.skill !== 'Overall';
}

function totalBossKillCount(entry: DailyRecapAccountPresentation): number {
  return entry.changes.bosses.reduce((total, change) => total + change.killCountGained, 0);
}

function formatSkillExperience(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): string {
  return `• ${change.skill}: +${formatCompactNumber(change.experienceGained)} XP`;
}

function formatLevelUp(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): readonly string[] {
  if (change.levelGained === 0) return [];
  return [
    `> **${change.skill}: +${change.levelGained} ${change.levelGained === 1 ? 'level' : 'levels'} → ${change.currentLevel}**`,
  ];
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
