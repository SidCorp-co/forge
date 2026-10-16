import type { ReleaseBlockerCode } from '@forge/contracts';
import { statusLabel } from '../issues/status-sets.js';
import { agree, counted } from './counted.js';

/** What the caller sends for the issues a range carries, in the number it carries. */
export function carriedWaysOut(n: number): string {
  const w = (one: string, many: string) => agree(n, one, many);
  return `${w('It does not', 'None of them')} ship${w('', 's')} without a decision. Send one${w('', ' per issue')} with the batch: \`ship-unverified\` with what is unverified; \`revert\` once its landing is reverted on the branch being promoted; or \`cut-below\`, which releases only what landed before it. Or move ${w('it', 'each')} to the release gate and name it on the roster.`;
}

const shortSha = (sha: unknown) => `\`${String(sha).slice(0, 12)}\``;

/** The range and the issues it carries unnamed, then what to do about them in `waysOut`'s words. */
export function carriedUndecidedSentence(
  details: Record<string, unknown>,
  waysOut: (n: number) => string,
): string {
  const carried = details.carried as Array<{ displayId: string; status: string }>;
  const each = carried.map((i) => `\`${i.displayId}\` at ${statusLabel(i.status)}`).join(', ');
  return `This release promotes \`${String(details.start)}\` at ${shortSha(details.cut)} onto \`${String(details.live)}\`, and that range carries the landing of ${counted(carried.length, 'issue')} this batch does not name: ${each}. ${waysOut(carried.length)}`;
}

/** The three carried codes, composed from the range and the issues the check named (ISS-1386). */
export function carriedSentence(
  code: ReleaseBlockerCode,
  details: Record<string, unknown> | undefined,
): string | null {
  if (code === 'RELEASE_CARRIES_UNDECIDED' && Array.isArray(details?.carried)) {
    return carriedUndecidedSentence(details, carriedWaysOut);
  }
  if (code === 'RELEASE_CARRIED_DECISION_REFUSED' && Array.isArray(details?.refused)) {
    const refused = details.refused as Array<{ displayId: string; decision: string; why: string }>;
    const each = refused.map((r) => `\`${r.displayId}\` \`${r.decision}\`: ${r.why}`).join('; ');
    return `${counted(refused.length, 'decision')} sent with this batch ${agree(refused.length, 'does', 'do')} not hold — ${each}. Correct ${agree(refused.length, 'it', 'each one')} and send the batch again.`;
  }
  if (code === 'RELEASE_CUT_DROPS_ROSTER' && Array.isArray(details?.displayIds)) {
    const ids = details.displayIds as string[];
    const named = ids.map((id) => `\`${id}\``).join(', ');
    const w = (one: string, many: string) => agree(ids.length, one, many);
    return `A \`cut-below\` moves this release to ${shortSha(details.cut)}, which leaves the landing of roster ${w('issue', 'issues')} ${named} above the cut, so the batch would name ${w('an issue', 'issues')} it does not ship. Take ${w('it', 'them')} off the roster, or decide the carried issue another way.`;
  }
  return null;
}
