/**
 * The guide index a prompt carries (owner rule prompt-is-a-map, 2026-11-01): the slugs of the
 * project's on-demand knowledge and of its org's (ISS-867), never their text. An agent reads one
 * through the project's own knowledge door, which answers an org entry the project does not shadow
 * (`knowledge/service.ts:readKnowledgeEntry`). The index has a hard character budget,
 * `GUIDE_INDEX_MAX_CHARS`: past it the rest are counted and the door that lists them is named.
 */

/** The most characters the index takes in any prompt, however many guides there are. */
export const GUIDE_INDEX_MAX_CHARS = 1500;

export interface GuideIndexInput {
  projectId: string;
  /** The project's on-demand slugs, in their order. */
  project: readonly string[];
  /** Its org's on-demand slugs the project does not shadow, in their order. */
  org: readonly string[];
  /**
   * What each named entry rests on, by slug (ISS-1064), shown on its line; null for an entry written
   * before a source was asked for, shown as owing one. Absent, the lines name the slugs alone.
   */
  sources?: Readonly<Record<string, string | null>> | undefined;
  /** How this agent reads one: `forge-runner api` from a pane, a REST path elsewhere. */
  read: (path: string) => string;
  depth: 2 | 3;
}

/** The most characters of a source one line shows; the entry's read gives the whole of it. */
export const GUIDE_SOURCE_MAX_CHARS = 80;

/** One entry's line: its slug, `(org)` where its org wrote it, and what it rests on where known. */
function guideLine(slug: string, org: boolean, sources: GuideIndexInput['sources']): string {
  const line = `- ${slug}${org ? ' (org)' : ''}`;
  if (!sources) return line;
  const source = sources[slug]?.replace(/\s+/g, ' ').trim();
  if (!source) return `${line} — source: none recorded`;
  const shown =
    source.length > GUIDE_SOURCE_MAX_CHARS
      ? `${source.slice(0, GUIDE_SOURCE_MAX_CHARS - 1)}…`
      : source;
  return `${line} — source: ${shown}`;
}

/** The index's text, or null where neither the project nor its org holds an on-demand guide. */
export function guideIndexText(input: GuideIndexInput): string | null {
  const items = [
    ...input.project.map((s) => guideLine(s, false, input.sources)),
    ...input.org.map((s) => guideLine(s, true, input.sources)),
  ];
  if (items.length === 0) return null;
  const head = [
    `${'#'.repeat(input.depth)} Project guides (fetch on demand)`,
    `Guides written for this project, and by its organisation where marked (org). When the task needs one, read it with ${input.read(`projects/${input.projectId}/knowledge/<slug>`)}; do NOT guess its contents:`,
  ].join('\n');
  const rest = (n: number) =>
    n > 0
      ? `\n- and ${n} more: ${input.read(`projects/${input.projectId}/knowledge?injection=on_demand`)} lists the project's`
      : '';
  let shown = 0;
  let used = head.length;
  for (const item of items) {
    const next = used + 1 + item.length;
    if (next + rest(items.length - shown - 1).length > GUIDE_INDEX_MAX_CHARS) break;
    used = next;
    shown += 1;
  }
  const text = [head, ...items.slice(0, shown)].join('\n') + rest(items.length - shown);
  if (text.length > GUIDE_INDEX_MAX_CHARS) {
    throw new Error(
      `prompt: the guide index takes ${text.length} characters, over its budget of ${GUIDE_INDEX_MAX_CHARS}`,
    );
  }
  return text;
}
