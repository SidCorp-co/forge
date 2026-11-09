// What the chat's `forge_project_status` sends (REQ-48 BC-8, section 6): the read with every section
// that holds nothing left out, and one line naming what was, so the model never reads a column of
// zeros as a finding. The web report keeps every section; this is the tool's shape only.
//
// It is also compact: a release names its requirements and its issue count but not its issue list
// (`releases.get` reads that), and a requirement carries its wait and its dates as the Requirements
// list reads them, not the forecast's working. The full read was ~110 KB on forge, which an MCP
// client refuses outright (debt 19747987).

import { type DeliveryDates, deliveryDatesOf } from '@forge/contracts/forecast';
import type {
  ProjectStatus,
  StatusRequirement,
  StatusShipped,
  StatusShippedRelease,
} from '@forge/contracts/project-status';

type Section = Exclude<
  keyof ProjectStatus,
  'projectId' | 'slug' | 'name' | 'asOf' | 'days' | 'viewer'
>;

/** Whether a section holds nothing a reader could act on; a section absent from the read is not listed. */
const EMPTY: { [K in Section]: (s: NonNullable<ProjectStatus[K]>) => boolean } = {
  stuck: (s) => s.count === 0,
  needsYou: (s) => s.total === 0,
  shipped: (s) => s.releaseCount === 0 && s.issueCount === 0,
  inFlight: (s) => s.open === 0 && s.runningCount === 0,
  waits: (s) => s.peopleCount === 0,
  requirements: (s) => s.items.length === 0,
  nextRelease: (s) => s.version === null,
  late: (s) => s.items.length === 0,
  roadmap: (s) => s.now.length + s.next.length + s.later.length === 0,
};

const releaseLine = (r: StatusShippedRelease) => ({
  version: r.version,
  releasedAt: r.releasedAt,
  name: r.name,
  issueCount: r.issueCount,
  requirements: r.requirements,
  verified: { level: r.verified.level, proven: r.verified.proven, total: r.verified.total },
});

const requirementLine = (r: StatusRequirement) => ({
  key: r.key,
  title: r.title,
  state: r.state,
  criteria: r.criteria,
  progress: r.progress,
  waitingOn: {
    who: r.waitingOn.who,
    act: r.waitingOn.act,
    ref: r.waitingOn.ref,
    dueAt: r.waitingOn.dueAt,
  },
  /** In hands, else the landing alone; null where shipped or nothing is forecast. */
  eta: deliveryDatesOf(r.delivery) satisfies DeliveryDates | null,
  shipped: r.delivery?.shipped ?? null,
  ...(r.moved ? { moved: r.moved } : {}),
});

const compactShipped = (s: StatusShipped) => ({
  ...s,
  latest: s.latest ? releaseLine(s.latest) : null,
  releases: s.releases.map(releaseLine),
});

type Compact = {
  shipped?: ReturnType<typeof compactShipped>;
  requirements?: Omit<NonNullable<ProjectStatus['requirements']>, 'items'> & {
    items: ReturnType<typeof requirementLine>[];
  };
};

export type PrunedStatus = Omit<Partial<ProjectStatus>, 'shipped' | 'requirements'> &
  Compact & { omitted: string | null };

export function pruneStatus(s: ProjectStatus): PrunedStatus {
  const out: Record<string, unknown> = { ...s };
  const left: Section[] = [];
  for (const key of Object.keys(EMPTY) as Section[]) {
    const section = s[key];
    if (section === undefined) continue;
    if ((EMPTY[key] as (x: unknown) => boolean)(section)) {
      delete out[key];
      left.push(key);
    }
  }
  if (out.shipped) out.shipped = compactShipped(s.shipped as StatusShipped);
  if (out.requirements && s.requirements)
    out.requirements = { ...s.requirements, items: s.requirements.items.map(requirementLine) };
  return {
    ...(out as PrunedStatus),
    omitted: left.length > 0 ? `Left out, holding nothing: ${left.join(', ')}.` : null,
  };
}
