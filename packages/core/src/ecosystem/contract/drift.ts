/**
 * The drift check at landing: work built against a contract names the version it implemented when
 * it lands, and that version is the contract's current one (ISS-60).
 *
 * Refused, not flagged: the design names `CONTRACT_DRIFT` as a refusal at landing and says core
 * never publishes a version on a person's behalf. A landing that implemented a version that is not
 * current would record "merged" against a contract nobody approved as current, so the mark is held
 * until the version is approved or the work is rebuilt against the current one.
 *
 * A ref is weighed against the project it names, not the issue's: a consumer issue built against
 * another project's contract lands naming that provider's current version (ISS-219).
 */

import { LANDED_CONTRACT } from '@forge/contracts/ecosystem';
import { db } from '../../db/client.js';
import { projectsWhere } from '../store.js';
import { currentOf, versionsOf } from './store.js';

interface NamedContract {
  /** `<project>/<contract>` as the issue wrote it. */
  readonly ref: string;
  readonly contract: string;
  readonly version: string;
}

const NAMED =
  /contract:\s*`?([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})@([A-Za-z0-9][A-Za-z0-9._+-]{0,39})/g;

/** Every `contract:<project>/<contract>@<version>` an issue's text names, once each, in order. */
export function contractsNamedIn(text: string): NamedContract[] {
  const out = new Map<string, NamedContract>();
  for (const m of text.matchAll(NAMED)) {
    const version = (m[3] as string).replace(/[.]+$/, '');
    const ref = `${m[1]}/${m[2]}`;
    out.set(`${ref}@${version}`, { ref, contract: m[2] as string, version });
  }
  return [...out.values()];
}

export { LANDED_CONTRACT };

interface DriftRefusal {
  code: 'CONTRACT_DRIFT' | 'CONTRACT_LANDING_UNNAMED';
  detail: string;
  details: Record<string, unknown>;
}

export interface LandingWorld {
  /** The contracts the issue names, from its description, plan and acceptance criteria. */
  named: readonly NamedContract[];
  /** Per `<project>/<contract>` ref: the provider's recorded versions and its current one, or
   *  `null` when no project holds that slug. */
  contracts: ReadonlyMap<string, { recorded: ReadonlySet<string>; current: string | null } | null>;
}

const parsed = (landed: string): NamedContract | null => {
  const m = LANDED_CONTRACT.exec(landed.trim());
  return m ? { ref: `${m[1]}/${m[2]}`, contract: m[2] as string, version: m[3] as string } : null;
};

// a landing of work that names a contract names the version it implemented, and that version is current; otherwise the mark is refused CONTRACT_LANDING_UNNAMED or CONTRACT_DRIFT (ISS-60)
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
    const held = world.contracts.get(contract.ref);
    if (!held) {
      const project = contract.ref.slice(0, contract.ref.indexOf('/'));
      return [
        { landed: text, why: `names project ${project}, which no project holds as its slug` },
      ];
    }
    if (!held.recorded.has(contract.version)) {
      return [{ landed: text, why: `names a version ${contract.ref} never recorded` }];
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

/** Reads what the drift check weighs for one issue: what its text names, and each named or landed
 *  contract's versions in the project that provides it. An issue naming no contract, landed naming
 *  none, reads nothing. */
export async function landingWorld(
  issue: {
    description: string | null;
    plan: string | null;
    acceptanceCriteria: string | null;
  },
  landed: readonly string[],
): Promise<LandingWorld> {
  const text = [issue.description, issue.plan, issue.acceptanceCriteria].filter(Boolean).join('\n');
  const named = contractsNamedIn(text);
  const refs = new Map<string, NamedContract>();
  for (const n of [...named, ...landed.flatMap((l) => parsed(l) ?? [])]) refs.set(n.ref, n);
  const contracts = new Map<string, { recorded: Set<string>; current: string | null } | null>();
  if (refs.size === 0) return { named, contracts };
  const providerSlugs = [...new Set([...refs.keys()].map((ref) => ref.slice(0, ref.indexOf('/'))))];
  const providers = new Map(
    (await projectsWhere(db, { slugs: providerSlugs })).map((p) => [p.slug, p.id]),
  );
  for (const [ref, n] of refs) {
    const providerId = providers.get(ref.slice(0, ref.indexOf('/')));
    if (!providerId) {
      contracts.set(ref, null);
      continue;
    }
    const versions = await versionsOf(db, [providerId], n.contract);
    contracts.set(ref, {
      recorded: new Set(versions.map((v) => v.version)),
      current: currentOf(versions)?.version ?? null,
    });
  }
  return { named, contracts };
}
