// Stage ① of the Update Pipeline (ISS-795 §2): the platform invariant set.
//
// `tier: 'mandatory'` facts ARE the non-forking layer — `prompt/system.ts`
// renders them into every agent prompt, so they reach every project on deploy
// with no sync. This module turns that set into an identity + a delta so a
// change to it can be OBSERVED, which is what stage ② needs.
//
// The rendered text is deliberately NOT carried here: the agent already has it
// in its system prompt. What it cannot otherwise know is WHICH version is in
// force and WHAT just changed.

import { createHash } from 'node:crypto';
import { listFacts, renderFact } from './registry.js';

export interface PlatformInvariantEntry {
  id: string;
  title: string;
  version: number;
  sha: string;
}

export interface PlatformInvariantSet {
  digest: string;
  entries: PlatformInvariantEntry[];
  /** One line naming every invariant in force — becomes the event's `reason`. */
  summary: string;
}

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Snapshot the currently-effective platform invariant set.
 *
 * Pure and deterministic: same code → same digest, which is what lets the boot
 * sweep tell "nothing changed" from "a new invariant landed".
 */
export function buildPlatformInvariantSet(): PlatformInvariantSet {
  const entries = listFacts({ tier: 'mandatory' })
    .map((fact) => ({
      id: fact.id,
      title: fact.title,
      version: fact.version,
      // cm:why hash the RENDERED text, not the version — an edit that forgets to bump `version` still moves the digest
      sha: sha8(renderFact(fact.id, {}) ?? ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const digest = sha8(entries.map((e) => `${e.id}@${e.version}:${e.sha}`).join('|'));
  const summary = `${entries.length} platform invariant(s) in force: ${entries
    .map((e) => `${e.id} v${e.version} (${e.sha})`)
    .join(', ')}`;

  return { digest, entries, summary };
}

/** Human-readable delta between two snapshots — becomes the event's `deltaSummary`. */
export function describeInvariantDelta(
  previous: PlatformInvariantEntry[] | null,
  current: PlatformInvariantEntry[],
): string {
  if (previous === null) return `initial snapshot: ${current.length} invariant(s)`;

  const before = new Map(previous.map((e) => [e.id, e]));
  const after = new Map(current.map((e) => [e.id, e]));
  const parts: string[] = [];

  for (const [id, e] of after) {
    const was = before.get(id);
    if (!was) parts.push(`added ${id} v${e.version}`);
    else if (was.sha !== e.sha) parts.push(`changed ${id} v${was.version}→v${e.version}`);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) parts.push(`removed ${id}`);
  }

  return parts.length > 0 ? parts.join('; ') : 'no change';
}
