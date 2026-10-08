// The report-queries registry: a Map keyed by the query's stable id, filled at boot by
// `registerReportQueries` (the process entry calls it before it serves). Same mechanism as
// `integrations/registry.ts`: a duplicate id is refused naming it, an unknown id is refused naming
// the ids that exist, and a read of an empty registry is refused naming the boot call that was
// skipped. Nothing here absorbs an unknown entry.

import {
  parseReportParams,
  type ReportFrame,
  type ReportQueryDescriptor,
} from '@forge/contracts/report-queries';
import type { z } from 'zod';
import type { StatusViewer } from '../project-status/index.js';

/** What a query is run as: the asker's own standing, never the process's. */
export interface ReportQueryContext {
  projectId: string;
  viewer: StatusViewer;
  now: Date;
}

/** What a query is declared with; `reads` names each existing read it summarises, never a second computation of it. */
export interface ReportQuery<P extends z.ZodObject = z.ZodObject> {
  descriptor: ReportQueryDescriptor<P>;
  /** Anchors (`path.ts:symbol`) of the reads this query is built over; at least one. */
  reads: readonly string[];
  run(ctx: ReportQueryContext, params: z.infer<P>): Promise<ReportFrame>;
}

/** The registered form: params arrive raw and leave parsed, so no caller holds a half-checked query. */
export interface RegisteredReportQuery {
  descriptor: ReportQueryDescriptor;
  reads: readonly string[];
  execute(
    ctx: ReportQueryContext,
    rawParams: unknown,
  ): Promise<{ params: Record<string, unknown>; frame: ReportFrame }>;
}

const registry = new Map<string, RegisteredReportQuery>();

export class UnknownReportQueryError extends Error {
  constructor(
    readonly queryId: string,
    readonly registered: readonly string[],
  ) {
    super(`report query "${queryId}" is not registered; registered: ${registered.join(', ')}`);
  }
}

/** The caller's params did not meet the query's declaration: unknown key, wrong type or a value outside the set. */
export class ReportParamsRefusedError extends Error {}

function assertPopulated(): void {
  if (registry.size > 0) return;
  throw new Error(
    'report-queries registry is empty: registerReportQueries() was never called in this process. ' +
      'Production calls it in src/index.ts; a test that reaches a registry-backed path calls it in its own setup.',
  );
}

export function registerReportQuery<P extends z.ZodObject>(query: ReportQuery<P>): void {
  const { id } = query.descriptor;
  if (registry.has(id)) throw new Error(`report query "${id}" is already registered`);
  if (query.reads.length === 0) {
    throw new Error(
      `report query "${id}" declares no reads; name each read it is built over, as path.ts:symbol`,
    );
  }
  registry.set(id, {
    descriptor: query.descriptor as unknown as ReportQueryDescriptor,
    reads: query.reads,
    async execute(ctx, rawParams) {
      let params: z.infer<P>;
      try {
        params = parseReportParams(query.descriptor, rawParams);
      } catch (e) {
        throw new ReportParamsRefusedError(e instanceof Error ? e.message : String(e));
      }
      return { params: params as Record<string, unknown>, frame: await query.run(ctx, params) };
    },
  });
}

export function getReportQuery(id: string): RegisteredReportQuery {
  assertPopulated();
  const found = registry.get(id);
  if (!found) throw new UnknownReportQueryError(id, [...registry.keys()]);
  return found;
}

export function listReportQueries(): RegisteredReportQuery[] {
  assertPopulated();
  return [...registry.values()];
}

/** For a test that registers its own queries; production never clears. */
export function clearReportQueriesForTest(): void {
  registry.clear();
}
