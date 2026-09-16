/**
 * ISS-1053 - the history file: the window, the deployment it was read from, the budgets the grades
 * were taken at, what was excluded, and the summary. A file missing a key is refused by name.
 */

import type { Summary } from './summarize.js';

export interface HistoryResult extends Summary {
  at: string;
  api: string;
  commit: string | null;
  version: string;
  window: { projectSlug: string; from: string; to: string; source: string | null };
  budgetSeconds: number;
  maxIterations: number;
  /** Whether UUID links were looked up (`--resolve`). */
  resolved: boolean;
  excludedSessions: string[];
}

const KEYS = [
  'at',
  'api',
  'commit',
  'version',
  'window',
  'budgetSeconds',
  'maxIterations',
  'resolved',
  'excludedSessions',
  'excludedRows',
  'groups',
  'flagged',
] as const;

export class HistoryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryShapeError';
  }
}

export function readHistoryResult(text: string, where = 'history'): HistoryResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new HistoryShapeError(`${where} is not an object`);
  const obj = parsed as Record<string, unknown>;
  for (const key of KEYS) {
    if (!(key in obj)) throw new HistoryShapeError(`${where} lacks ${key}`);
  }
  if (!Array.isArray(obj.groups) || !Array.isArray(obj.flagged))
    throw new HistoryShapeError(`${where}.groups and .flagged must be lists`);
  return obj as unknown as HistoryResult;
}

export const serializeHistory = (result: HistoryResult): string =>
  `${JSON.stringify(result, null, 2)}\n`;
