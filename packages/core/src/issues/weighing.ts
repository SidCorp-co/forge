/**
 * ISS-1368 — what a verdict is weighed with beside the deployment's reading: the release runtimes a
 * project declares, which paths each landing changed, and what each served commit holds of each
 * judged one. `release-batch/runtime-weighing.ts` reads it; this module only weighs it.
 */

import { runtimePathPrefix, type ServingReading } from '@forge/contracts/releases';

/** What a served commit holds of a judged one. */
export type Carriage =
  /** The served commit is the judged one or a descendant of it. */
  | { readonly kind: 'descends' }
  /** It is not: `paths` is every file the two trees may differ in, each side's since their merge base. */
  | { readonly kind: 'differs'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

/** The files a landing changed against its first parent. */
export type ChangedPaths =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

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
