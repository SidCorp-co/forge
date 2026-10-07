/** ISS-1368 — what `runtime-weighing.ts` reads a verdict to be weighed with, and its path rules. */

import { runtimePathPrefix } from '../pipeline/pipeline-config-schema.js';
import type { Carriage, ChangedPaths } from '../projects/repository-reader.js';
import type { ServingReading } from './serving-reading.js';

export interface RuntimeReading {
  readonly name: string;
  readonly paths: readonly string[];
  readonly serving: ServingReading;
}

export interface Weighing {
  /** False only for `UNWEIGHED`: then a pair absent below was never asked, not missed. */
  readonly read: boolean;
  readonly runtimes: readonly RuntimeReading[];
  readonly changed: ReadonlyMap<string, ChangedPaths>;
  readonly carriage: ReadonlyMap<string, Carriage>;
}

/** Nothing read: equality alone decides, which can hold a verdict and never earn one. */
export const UNWEIGHED: Weighing = {
  read: false,
  runtimes: [],
  changed: new Map(),
  carriage: new Map(),
};

export function carriageKey(judged: string, served: string): string {
  return `${judged.trim().toLowerCase()}\u0000${served.trim().toLowerCase()}`;
}

export function claimedBy(paths: readonly string[], file: string): boolean {
  return paths.some((p) => file === p || file.startsWith(runtimePathPrefix(p)));
}

export function claimedByAny(runtimes: readonly RuntimeReading[], file: string): boolean {
  return runtimes.some((r) => claimedBy(r.paths, file));
}

/** `items` from position `by` round to the one before it. */
export function rotated<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const at = by % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}
