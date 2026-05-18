import type { Issue, IssueStatus } from '@/features/issue/types';
import type { PipelineStage } from './constants';
import { BOTTLENECK_THRESHOLDS } from './constants';

function safeTimestamp(dateStr: string): number {
  const t = new Date(dateStr).getTime();
  return isNaN(t) ? 0 : t;
}

export function getTimeInCurrentStage(issue: Issue): number {
  const history = issue.changeHistory ?? [];
  const statusChanges = history
    .filter((e) => typeof e === 'object' && e !== null && 'field' in e && e.field === 'status')
    .sort((a, b) => safeTimestamp(b.at) - safeTimestamp(a.at));

  if (statusChanges.length > 0) {
    const t = safeTimestamp(statusChanges[0].at);
    if (t > 0) return Date.now() - t;
  }

  // changeHistory may be string[] (serialized format) — parse timestamps
  if (history.length > 0 && typeof history[0] === 'string') {
    const timestamps = (history as unknown as string[])
      .filter((s) => s.includes('changed status'))
      .map((s) => {
        const match = s.match(/^\[(.+?)\]/);
        return match ? safeTimestamp(match[1]) : 0;
      })
      .filter((t) => t > 0)
      .sort((a, b) => b - a);

    if (timestamps.length > 0) {
      return Date.now() - timestamps[0];
    }
  }

  const created = safeTimestamp(issue.createdAt);
  return created > 0 ? Date.now() - created : 0;
}

export function getReopenCount(issue: Issue): number {
  const history = issue.changeHistory ?? [];

  // Object format
  const objCount = history.filter(
    (e) => typeof e === 'object' && e !== null && 'field' in e && e.field === 'status' && e.to === 'reopen'
  ).length;

  if (objCount > 0) return objCount;

  // String format
  if (history.length > 0 && typeof history[0] === 'string') {
    return (history as unknown as string[]).filter((s) => s.includes('"reopen"')).length;
  }

  return 0;
}

export function getStageKey(status: IssueStatus, stages: PipelineStage[]): string | null {
  for (const stage of stages) {
    if (stage.statuses.includes(status)) return stage.key;
  }
  return null;
}

export function isBottlenecked(issue: Issue, stages: PipelineStage[]): boolean {
  const stageKey = getStageKey(issue.status, stages);
  if (!stageKey) return false;
  // `done` aggregates terminal closed issues — never bottleneck. `released`
  // is its own stage with a short threshold so we surface stuck releases.
  if (stageKey === 'done') return false;
  const thresholdHours = BOTTLENECK_THRESHOLDS[stageKey];
  if (thresholdHours == null) return false;
  const ms = getTimeInCurrentStage(issue);
  return ms > thresholdHours * 60 * 60 * 1000;
}

export function formatStageDuration(ms: number): string {
  if (ms < 0) return '0m';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

export interface StageMetric {
  key: string;
  label: string;
  count: number;
  avgTimeMs: number;
  bottleneckedCount: number;
}

export interface StepDuration {
  step: string;
  from: string;
  to: string;
  duration: number;
  enteredAt: string;
}

export function getStepDurations(issue: Issue): StepDuration[] {
  const history = issue.changeHistory ?? [];
  const transitions: { status: string; at: number; atStr: string }[] = [];

  for (const entry of history) {
    if (typeof entry === 'object' && entry !== null && 'field' in entry && entry.field === 'status') {
      const t = safeTimestamp(entry.at);
      if (t > 0) transitions.push({ status: entry.to, at: t, atStr: entry.at });
    } else if (typeof entry === 'string' && (entry as string).includes('changed status')) {
      const tsMatch = (entry as string).match(/^\[(.+?)\]/);
      const toMatch = (entry as string).match(/to "(.+?)"/);
      if (tsMatch && toMatch) {
        const t = safeTimestamp(tsMatch[1]);
        if (t > 0) transitions.push({ status: toMatch[1], at: t, atStr: tsMatch[1] });
      }
    }
  }

  transitions.sort((a, b) => a.at - b.at);
  const durations: StepDuration[] = [];

  for (let i = 0; i < transitions.length - 1; i++) {
    const duration = transitions[i + 1].at - transitions[i].at;
    if (duration < 1000) continue; // skip sub-second auto-transitions
    durations.push({
      step: `${transitions[i].status}→${transitions[i + 1].status}`,
      from: transitions[i].status,
      to: transitions[i + 1].status,
      duration,
      enteredAt: transitions[i].atStr,
    });
  }

  return durations;
}

export function isOutlierDuration(duration: number, p90: number): boolean {
  return duration > p90 * 2;
}

export function computeStageMetrics(issues: Issue[], stages: PipelineStage[]): StageMetric[] {
  return stages.map((stage) => {
    const stageIssues = issues.filter((i) => stage.statuses.includes(i.status));
    const times = stageIssues.map((i) => getTimeInCurrentStage(i));
    const avgTimeMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const bottleneckedCount = stageIssues.filter((i) => isBottlenecked(i, stages)).length;

    return {
      key: stage.key,
      label: stage.label,
      count: stageIssues.length,
      avgTimeMs,
      bottleneckedCount,
    };
  });
}
