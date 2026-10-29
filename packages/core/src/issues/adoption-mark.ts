/**
 * The mark of an issue whose whole deliverable is adopting a contract version (REQ-5 BC-17): the
 * record it lands on, read off the project's interface and links, and the stamp written from it.
 * The mark writer (`merge-marker.ts`) calls both; neither is a way past a commit (BC-18).
 */

import type { AdoptionHeld } from '@forge/contracts/ecosystem';
import type { MergeRefusalCode } from '@forge/contracts/issues';
import { adoptionArtifact, type LandingArtifact } from '@forge/contracts/landing-artifacts';
import type { Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import type { Actor } from './activity.js';
import type { HostMerge } from './host-mark.js';
import type { LandingShape } from './landing-evidence.js';
import { adoptionLandingOf } from './merge-mark-kind.js';
import { type MergeRecord, recordIssueMerge } from './merge-record.js';
import { adoptionRecord } from './ports.js';
import { codeEvidenceOf } from './work-evidence.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

interface AdoptionMarkArgs {
  issue: { id: string; projectId: string };
  commit?: string | undefined;
  changedPaths?: unknown;
  landing?: string | undefined;
  artifacts?: readonly LandingArtifact[] | undefined;
  target?: string | undefined;
  adoptions?: readonly string[] | undefined;
}

/**
 * The adoption record a mark naming `adoptions` lands on (REQ-5 BC-17), read off the project's
 * interface and links. It stands only for an issue that changed no code: one carrying code evidence,
 * or a mark naming a commit, paths, a landing, artifacts or a target beside it, is refused by name,
 * so the record is never a way past a commit (BC-18).
 */
export async function adoptionOf(args: AdoptionMarkArgs): Promise<AdoptionHeld[]> {
  const beside = [
    args.commit ? `commit ${args.commit}` : null,
    args.changedPaths ? '`changedPaths`' : null,
    args.landing ? '`landing`' : null,
    args.artifacts?.length ? '`artifacts`' : null,
    args.target ? `target \`${args.target}\`` : null,
  ].filter((x): x is string => x !== null);
  if (beside.length > 0) {
    throw refuse(
      'ADOPTION_BESIDE_CODE',
      `the mark names ${beside.join(', ')} beside \`adoptions\`, and an adoption record is the landing only of an issue that changed no code, so nothing was marked. Send \`adoptions\` alone, or, where code landed, mark the commit it landed at without \`adoptions\`.`,
      '/adoptions',
    );
  }
  const code = await codeEvidenceOf(args.issue.id);
  if (code.length > 0) {
    throw refuse(
      'ADOPTION_BESIDE_CODE',
      `this issue carries code evidence (${code.join('; ')}), so its landing is the commit that code landed at and an adoption record does not stand in for it; nothing was marked. Mark it naming \`commit\`, the whole sha it landed at.`,
      '/adoptions',
    );
  }
  const read = await adoptionRecord(args.issue.projectId, args.adoptions ?? []);
  if (!read.ok) throw refuse(read.code, read.detail, '/adoptions');
  return read.held;
}

/** The stamp of an adoption record: its `adoption` artifacts and, outside git, the landing naming
 *  them. A merge Forge observed for the issue is code that landed, which the record never shadows. */
export async function stampAdoption(
  tx: Tx,
  args: Pick<AdoptionMarkArgs, 'issue'> & { actor: { hookActor: Actor } },
  at: { shape: LandingShape; adopted: AdoptionHeld[]; observed: HostMerge | null },
): Promise<MergeRecord> {
  const { shape, adopted, observed } = at;
  if (observed) {
    throw refuse(
      'ADOPTION_BESIDE_CODE',
      `Forge holds a merge of this issue's code at ${observed.commitSha} on \`${observed.target}\`, so that merge is its landing and an adoption record does not stand in for it; nothing was marked. Mark it without \`adoptions\`.`,
      '/adoptions',
    );
  }
  const refs = adopted.map((a) => a.ref);
  return recordIssueMerge(tx, {
    issueId: args.issue.id,
    via: 'mark',
    actor: args.actor.hookActor,
    evidence: {
      kind: 'adopted',
      artifacts: refs.map(adoptionArtifact),
      landing: shape === 'outside_git' ? adoptionLandingOf(refs) : null,
    },
  });
}
