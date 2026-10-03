/**
 * The drift check at landing: work built against a contract names the version it implemented when
 * it lands, and that version is the contract's current one (ISS-60).
 *
 * Refused, not flagged: the design names `CONTRACT_DRIFT` as a refusal at landing and says core
 * never publishes a version on a person's behalf. A landing that implemented a version that is not
 * current would record "merged" against a contract nobody approved as current, so the mark is held
 * until the version is approved or the work is rebuilt against the current one.
 */

import { db } from '../../db/client.js';
import { projectsWhere } from '../store.js';
import { contractsNamedIn, type NamedContract } from './named-context.js';
import { currentOf, versionsOf } from './store.js';

/** `<project slug>/<contract slug>@<version>`, the form a landing names an implemented version in. */
export const LANDED_CONTRACT =
  /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})@([A-Za-z0-9][A-Za-z0-9._+-]{0,39})$/;

export interface DriftRefusal {
  code: 'CONTRACT_DRIFT' | 'CONTRACT_LANDING_UNNAMED';
  detail: string;
  details: Record<string, unknown>;
}

export interface LandingWorld {
  projectSlug: string;
  /** The contracts the issue names, from its description, plan and acceptance criteria. */
  named: readonly NamedContract[];
  /** Per contract slug of the issue's project: the versions recorded and the current one. */
  contracts: ReadonlyMap<string, { recorded: ReadonlySet<string>; current: string | null }>;
}

const parsed = (landed: string): NamedContract | null => {
  const m = LANDED_CONTRACT.exec(landed.trim());
  return m ? { ref: `${m[1]}/${m[2]}`, contract: m[2] as string, version: m[3] as string } : null;
};

// cm:guard a landing of work that names a contract names the version it implemented, and that version is current; otherwise the mark is refused CONTRACT_LANDING_UNNAMED or CONTRACT_DRIFT (ISS-60)
export function landingDriftRefusal(
  landed: readonly string[],
  world: LandingWorld,
): DriftRefusal | null {
  const claims = landed.map((l) => ({ text: l, contract: parsed(l) }));
  const said = new Set(claims.flatMap((c) => (c.contract ? [c.contract.ref] : [])));
  const unnamed = [...new Set(world.named.map((n) => n.ref))].filter((ref) => !said.has(ref));
  if (unnamed.length > 0) {
    return {
      code: 'CONTRACT_LANDING_UNNAMED',
      detail: `this issue is built against ${unnamed.join(', ')}, and the landing names no version of ${unnamed.length === 1 ? 'it' : 'them'}; send contracts: ["<project>/<contract>@<version>"] naming each version the work implemented.`,
      details: { unnamed },
    };
  }
  const drifted = claims.flatMap(({ text, contract }) => {
    if (!contract)
      return [{ landed: text, why: 'is not written as <project>/<contract>@<version>' }];
    if (!contract.ref.startsWith(`${world.projectSlug}/`)) {
      return [
        { landed: text, why: `is not a contract of this issue's project ${world.projectSlug}` },
      ];
    }
    const held = world.contracts.get(contract.contract);
    if (!held?.recorded.has(contract.version)) {
      return [{ landed: text, why: 'names a version this project never recorded' }];
    }
    if (held.current !== contract.version) {
      return [
        {
          landed: text,
          why: `is not the current version; ${contract.ref} is current at ${held.current ?? 'no version'}`,
        },
      ];
    }
    return [];
  });
  if (drifted.length === 0) return null;
  return {
    code: 'CONTRACT_DRIFT',
    detail: `${drifted.map((d) => `${d.landed} ${d.why}`).join('; ')}. Approve the version the work implemented, or rebuild against the current one, then mark it again.`,
    details: { drifted },
  };
}

/** Reads what the drift check weighs for one issue: what its text names, and each contract's
 *  versions. An issue naming no contract, landed naming none, reads nothing. */
export async function landingWorld(
  issue: {
    projectId: string;
    description: string | null;
    plan: string | null;
    acceptanceCriteria: string | null;
  },
  landed: readonly string[],
): Promise<LandingWorld> {
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  const named = contractsNamedIn(text);
  const slugs = new Set([
    ...named.map((n) => n.contract),
    ...landed.flatMap((l) => {
      const p = parsed(l);
      return p ? [p.contract] : [];
    }),
  ]);
  const contracts = new Map<string, { recorded: Set<string>; current: string | null }>();
  if (named.length === 0 && landed.length === 0) return { projectSlug: '', named, contracts };
  const [project] = await projectsWhere(db, { ids: [issue.projectId] });
  for (const slug of slugs) {
    const versions = await versionsOf(db, [issue.projectId], slug);
    contracts.set(slug, {
      recorded: new Set(versions.map((v) => v.version)),
      current: currentOf(versions)?.version ?? null,
    });
  }
  return { projectSlug: project?.slug ?? '', named, contracts };
}
