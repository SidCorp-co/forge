import { jsonPointer as pointer } from '../lib/refusal.js';
import { missingElements } from './contract/upload-rules.js';
import type { EcosystemRefusal } from './refusals.js';
import { CONTRACT_REF, type EcosystemDocument, type InterfaceDocument } from './schema.js';

export interface ProviderView {
  projectId: string;
  interface: InterfaceDocument | null;
  activeIn: ReadonlySet<string>;
}

interface ConsumerEdge {
  consumer: { id: string; slug: string };
  contractSlug: string;
  ecosystemId: string;
}

export interface InterfaceWorld {
  project: { id: string; slug: string };
  activeEcosystems: ReadonlyMap<string, EcosystemDocument>;
  providers: ReadonlyMap<string, ProviderView>;
  versions: ReadonlyMap<string, ReadonlySet<string>>;
  elements: ReadonlyMap<string, ReadonlySet<string> | null>;
  consumersOfMine: readonly ConsumerEdge[];
}

export const versionKey = (providerId: string, contractSlug: string) =>
  `${providerId}/${contractSlug}`;

export function splitContractRef(ref: string): { provider: string; contract: string } {
  const m = CONTRACT_REF.exec(ref);
  if (!m?.[1] || !m[2]) {
    throw new Error(`ecosystem: "${ref}" passed the schema but is not <project>/<contract>`);
  }
  return { provider: m[1], contract: m[2] };
}

function publicationRefusals(doc: InterfaceDocument, world: InterfaceWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  for (const [slug, pub] of Object.entries(doc.publishes)) {
    if (pub.type === 'opaque' && pub.artifact !== null) {
      out.push({
        code: 'ARTIFACT_FOR_OPAQUE',
        path: pointer(['publishes', slug, 'artifact']),
        detail: `"${slug}" is opaque, so it has no artifact to measure; artifact must be null.`,
      });
    }
    if (pub.type !== 'opaque' && pub.artifact === null) {
      out.push({
        code: 'ARTIFACT_MISSING',
        path: pointer(['publishes', slug, 'artifact']),
        detail: `"${slug}" is ${pub.type}, which is measured from its artifact; name a { path } or { upload: true }, or declare it opaque.`,
      });
    }
    pub.ecosystems.forEach((eco, i) => {
      if (!world.activeEcosystems.has(eco)) {
        out.push({
          code: 'ECOSYSTEM_NOT_MEMBER',
          path: pointer(['publishes', slug, 'ecosystems', i]),
          detail: `${world.project.slug} is not an active member of ecosystem ${eco}; a project publishes only where it has accepted an invitation.`,
        });
      }
    });
  }
  return out;
}

/** The version and element checks a consumption owes once its provider and contract are known. */
function builtAgainstRefusals(
  c: InterfaceDocument['consumes'][number],
  providerId: string,
  contract: string,
  world: InterfaceWorld,
  at: (...rest: PropertyKey[]) => string,
): EcosystemRefusal[] {
  const versions = world.versions.get(versionKey(providerId, contract));
  if (!versions?.has(c.builtAgainst)) {
    const known = versions && versions.size > 0 ? [...versions].sort().join(', ') : 'none yet';
    return [
      {
        code: 'VERSION_UNKNOWN',
        path: at('builtAgainst'),
        detail: `${c.contract} has no recorded version "${c.builtAgainst}" (recorded: ${known}); builtAgainst names a version core has recorded for that contract.`,
      },
    ];
  }
  const known = world.elements.get(`${versionKey(providerId, contract)}@${c.builtAgainst}`);
  return missingElements(
    c.elements ?? [],
    known ?? null,
    (j) => at('elements', j),
    `${c.contract}@${c.builtAgainst}`,
  );
}

// cm:why a project consuming its own contract is the in-project case and names no ecosystem (Q11, 2026-10-03): its UI and its backend share one interface. Naming an ecosystem for it is still SELF_CONSUMPTION, because an ecosystem is where two projects meet, and another project's contract is consumed only inside an ecosystem both share
function ownConsumptionRefusals(
  doc: InterfaceDocument,
  c: InterfaceDocument['consumes'][number],
  contract: string,
  world: InterfaceWorld,
  at: (...rest: PropertyKey[]) => string,
): EcosystemRefusal[] {
  if (c.ecosystem !== undefined) {
    return [
      {
        code: 'SELF_CONSUMPTION',
        path: at('ecosystem'),
        detail: `${c.contract} is this project's own contract; a project consumes itself in-project, with no ecosystem, and never through one. Drop ecosystem to declare the in-project consumption.`,
      },
    ];
  }
  if (!doc.publishes[contract]) {
    return [
      {
        code: 'REF_NOT_PUBLISHED',
        path: at('contract'),
        detail: `${world.project.slug} publishes no contract "${contract}" in this interface; an in-project consumption names one of the project's own publications.`,
      },
    ];
  }
  return builtAgainstRefusals(c, world.project.id, contract, world, at);
}

function consumptionRefusals(doc: InterfaceDocument, world: InterfaceWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const seen = new Set<string>();
  doc.consumes.forEach((c, i) => {
    const at = (...rest: PropertyKey[]) => pointer(['consumes', i, ...rest]);
    const { provider, contract } = splitContractRef(c.contract);
    const pair = `${c.contract} ${c.ecosystem ?? 'in-project'}`;
    if (seen.has(pair)) {
      out.push({
        code: 'CONSUMPTION_DUPLICATE',
        path: at(),
        detail: `${c.contract} ${c.ecosystem ? `in ecosystem ${c.ecosystem}` : 'in-project'} is already declared above; a contract is consumed once per ecosystem, or once in-project, against one version.`,
      });
      return;
    }
    seen.add(pair);
    const view = world.providers.get(provider);
    if (provider === world.project.slug || view?.projectId === world.project.id) {
      out.push(...ownConsumptionRefusals(doc, c, contract, world, at));
      return;
    }
    if (!view) {
      out.push({
        code: 'REF_UNRESOLVED',
        path: at('contract'),
        detail: `no project has the slug "${provider}"; a contract reference is <project-slug>/<contract-slug>.`,
      });
      return;
    }
    if (c.ecosystem === undefined) {
      out.push({
        code: 'CONSUMPTION_ECOSYSTEM_MISSING',
        path: at(),
        detail: `${c.contract} is project ${provider}'s contract; only a project's own contract is consumed with no ecosystem. Name the ecosystem ${world.project.slug} and ${provider} share.`,
      });
      return;
    }
    if (!world.activeEcosystems.has(c.ecosystem) || !view.activeIn.has(c.ecosystem)) {
      out.push({
        code: 'ECOSYSTEM_NOT_SHARED',
        path: at('ecosystem'),
        detail: `${world.project.slug} and ${provider} are not both active members of ecosystem ${c.ecosystem}; a contract is consumed only inside an ecosystem both sides belong to.`,
      });
      return;
    }
    const pub = view.interface?.publishes[contract];
    if (!pub?.ecosystems.includes(c.ecosystem)) {
      out.push({
        code: 'REF_NOT_PUBLISHED',
        path: at('contract'),
        detail: `${provider} publishes no contract "${contract}" in ecosystem ${c.ecosystem}; only a published contract can be consumed, never a module or a guess.`,
      });
      return;
    }
    out.push(...builtAgainstRefusals(c, view.projectId, contract, world, at));
  });
  return out;
}

function responseWindowRefusals(doc: InterfaceDocument, world: InterfaceWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  for (const kind of ['rfi', 'change-request'] as const) {
    const promised = doc.commitments.responseDays[kind];
    for (const eco of world.activeEcosystems.values()) {
      const allowed = eco.channel.responseDays[kind];
      if (promised > allowed) {
        out.push({
          code: 'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
          path: pointer(['commitments', 'responseDays', kind]),
          detail: `${world.project.slug} promises ${promised} day(s) for a ${kind}, and ecosystem ${eco.ecosystem.slug} allows at most ${allowed}; a member may promise sooner, never later.`,
        });
      }
    }
  }
  return out;
}

function contractInUseRefusals(doc: InterfaceDocument, world: InterfaceWorld): EcosystemRefusal[] {
  const lost = new Map<string, ConsumerEdge[]>();
  for (const edge of world.consumersOfMine) {
    if (doc.publishes[edge.contractSlug]?.ecosystems.includes(edge.ecosystemId)) continue;
    const key = `${edge.contractSlug} ${edge.ecosystemId}`;
    lost.set(key, [...(lost.get(key) ?? []), edge]);
  }
  return [...lost.values()].map((edges) => {
    const [first] = edges;
    if (!first) throw new Error('ecosystem: an empty consumer group was built');
    const names = [...new Set(edges.map((e) => e.consumer.slug))].sort();
    const still = doc.publishes[first.contractSlug] !== undefined;
    return {
      code: 'CONTRACT_IN_USE' as const,
      path: still
        ? pointer(['publishes', first.contractSlug, 'ecosystems'])
        : pointer(['publishes', first.contractSlug]),
      detail: `${world.project.slug}/${first.contractSlug} is consumed in ecosystem ${first.ecosystemId} by ${names.join(', ')}; a contract with consumers stays published until they no longer consume it.`,
    };
  });
}

export function checkInterface(doc: InterfaceDocument, world: InterfaceWorld): EcosystemRefusal[] {
  return [
    ...publicationRefusals(doc, world),
    ...consumptionRefusals(doc, world),
    ...responseWindowRefusals(doc, world),
    ...contractInUseRefusals(doc, world),
  ];
}
