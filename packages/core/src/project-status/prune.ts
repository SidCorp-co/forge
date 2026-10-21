// What the chat's `forge_project_status` sends (REQ-48 BC-8, section 6): the read with every section
// that holds nothing left out, and one line naming what was, so the model never reads a column of
// zeros as a finding. The web report keeps every section; this is the tool's shape only.

import type { ProjectStatus } from '@forge/contracts/project-status';

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

export type PrunedStatus = Partial<ProjectStatus> & { omitted: string | null };

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
  return {
    ...(out as Partial<ProjectStatus>),
    omitted: left.length > 0 ? `Left out, holding nothing: ${left.join(', ')}.` : null,
  };
}
