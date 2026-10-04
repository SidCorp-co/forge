import type { ReleaseBlockerCode, ReleaseRefusalCode } from '@forge/contracts/releases';
import { type LiveShortfall, notLiveSentence } from '../ecosystem/waits/rules.js';
import { type Refusal, RefusalError, refuser } from '../lib/refusal.js';
import {
  type ReleaseBlocker,
  type ReleaseBlockerReport,
  releaseBlockerSentence,
} from './blocker-sentences.js';

/** Every release refusal, at every door, in the one refusal envelope. */
export const refuseRelease = refuser<ReleaseRefusalCode>('RELEASE_REFUSED');

/** One blocker, answered under its code with the sentence readiness lists it with. */
export function blockerRefusal(code: ReleaseBlockerCode, details?: Record<string, unknown>) {
  return refuseRelease(code, releaseBlockerSentence(code, details));
}

/**
 * The probes did not agree that the release is live. The row carries the commit production was
 * found serving, which the finish record keeps beside the reason.
 */
export function notVerifiedRefusal(reason: string, live: string | null): RefusalError {
  const row: Refusal & { live: string | null } = {
    code: 'RELEASE_NOT_VERIFIED',
    path: '',
    detail: reason,
    live,
  };
  return new RefusalError([row], 'RELEASE_REFUSED');
}

/** The commit a `RELEASE_NOT_VERIFIED` refusal found serving, or null. */
export function liveOf(err: unknown): string | null {
  if (!(err instanceof RefusalError)) return null;
  const live = (err.refusals[0] as { live?: unknown } | undefined)?.live;
  return typeof live === 'string' ? live : null;
}

/** A finish worker's hold on its attempt was taken over; it must write nothing more. */
export const FENCE_LOST = 'RELEASE_FINISH_LEASE_LOST';

export const fenceLost = () =>
  refuseRelease(
    FENCE_LOST,
    'this finish worker no longer holds the attempt: another worker took it over, so this one writes nothing more',
  );

/**
 * A provider not yet serving a contract version holds back the issue that waits on it, so it
 * answers once per waiting issue, pointed at that issue in the call's `issueIds`.
 */
function asRefusals(b: ReleaseBlocker, named: readonly string[]): Refusal[] {
  const waits = b.code === 'CONTRACT_PROVIDER_NOT_LIVE' ? b.details?.waits : undefined;
  if (!Array.isArray(waits) || waits.length === 0) {
    return [{ code: b.code, path: '', detail: b.message }];
  }
  const byIssue = new Map<string, LiveShortfall[]>();
  for (const w of waits as LiveShortfall[]) {
    byIssue.set(w.issueId, [...(byIssue.get(w.issueId) ?? []), w]);
  }
  return [...byIssue].map(([issueId, own]) => {
    const at = named.findIndex((id) => id.toLowerCase() === issueId.toLowerCase());
    return { code: b.code, path: at >= 0 ? `/issueIds/${at}` : '', detail: notLiveSentence(own) };
  });
}

/**
 * Every reason standing in the report, the first first: an operator clearing one already knows
 * what else stands (ISS-1127). Null when nothing does.
 */
export function releaseBlockedRefusal(
  report: ReleaseBlockerReport,
  named: readonly string[] = [],
): RefusalError | null {
  if (report.blockers.length === 0) return null;
  return new RefusalError(
    report.blockers.flatMap((b) => asRefusals(b, named)),
    'RELEASE_REFUSED',
  );
}

/**
 * The named issues a refusal holds back on their own, where every row is a provider not live: the
 * rest of the roster may still release without them. Null where any other reason stands.
 */
export function heldBackByProviders(err: unknown, named: readonly string[]): string[] | null {
  if (!(err instanceof RefusalError)) return null;
  const held: string[] = [];
  for (const r of err.refusals) {
    const at = /^\/issueIds\/(\d+)$/.exec(r.path);
    const id = at ? named[Number(at[1])] : undefined;
    if (r.code !== 'CONTRACT_PROVIDER_NOT_LIVE' || !id) return null;
    held.push(id);
  }
  return held.length > 0 ? held : null;
}

/** The first code a thrown release refusal names, or null for anything else. */
export function firstRefusalCode(err: unknown): string | null {
  return err instanceof RefusalError ? (err.refusals[0]?.code ?? null) : null;
}

/** What a stored record says of a failure: a refusal's sentences, or an error's message. */
export function reasonOf(err: unknown): string {
  if (err instanceof RefusalError) return err.refusals.map((r) => r.detail).join(' ');
  return err instanceof Error ? err.message : String(err);
}

// The probes' reading is core's, so a caller sending it is told where it actually comes from, or the
// next caller sends it again under a different spelling.
export const MACHINE_ONLY_KEYS = [
  'health',
  'identity',
  'verdict',
  'verdictReason',
  'readings',
] as const;

export function refuseMachineKeys(body: Record<string, unknown>): void {
  const sent = MACHINE_ONLY_KEYS.filter((k) => k in body);
  if (sent.length === 0) return;
  throw new RefusalError(
    sent.map((k) => ({
      code: 'RELEASE_VERDICT_NOT_YOURS',
      path: `/${k}`,
      detail: `\`${k}\` is core's reading and not yours to send. Core takes it from this project's declared probes at the moment you record your account, and stores it beside it. Send \`account\`, and \`providerRef\` for the provider's own handle on what you did.`,
    })),
    'RELEASE_REFUSED',
  );
}
