/**
 * ISS-1066 — the project as the benchmark read it, assembled once per run and handed to the judge
 * on every judged turn.
 *
 * The judge saw only the task's own filled fixtures and the earlier turns, so on a task declaring no
 * fixture it decided "served" from tone. On `forge-plugin` on 2026-09-17 the assistant answered
 * "763 open issues" against a project holding 682 and the judge said yes twice, having nothing of
 * the project to hold the number against.
 *
 * Two budgets, not one. The grounding block — counts, effective pipeline, filing rules, the waiting
 * issue — is what those claims are checked against and it is never truncated; it is bounded by the
 * project's shape rather than by anything an author typed. What is left of `BRIEF_MAX_CHARS` is
 * shared among the four author-text sections, each naming its own cut, so a 20,000-character
 * description cannot take the counts with it.
 */

import {
  type BenchClient,
  DeploymentRefusal,
  type IssueCounts,
  type IssueLine,
  type IssueRef,
  type KnowledgeIndex,
  type KnowledgeRow,
  type Project,
  type ProjectDetail,
} from './client.js';
import type { FixtureName, Task } from './task.js';

export const BRIEF_MAX_CHARS = 6000;
/** How many knowledge bodies the brief pulls: the always-injected ones are what the product itself puts in a prompt. */
export const BRIEF_KNOWLEDGE_BODIES = 6;
export const BRIEF_NEWEST_ISSUES = 20;
/** The bound `open-issues-linked` asks for; a task asking for every one of 682 measures patience, not linking. */
export const BRIEF_OPEN_ISSUES = 5;

export interface BriefKnowledgeEntry extends KnowledgeRow {
  /** The entry's own text, for the always-injected ones; null where the brief did not pull it. */
  body: string | null;
}

/** Everything the brief is rendered from, read from the deployment once per run. */
export interface ProjectBriefSource {
  slug: string;
  detail: ProjectDetail;
  counts: IssueCounts;
  /** The effective sequence, already resolved by `effectivePipelineStates`. */
  pipelineStates: string[];
  intakeGate: boolean;
  facts: Record<string, string>;
  knowledge: BriefKnowledgeEntry[];
  /** Entries the deployment's response cap left out of the index; disclosed rather than dropped. */
  knowledgeOmitted: number;
  newestIssues: IssueLine[];
  newestOpenIssues: IssueRef[];
  waitingIssue: IssueRef | null;
  readAt: string;
}

/** A read the brief cannot do without, named so an operator knows which credential to fix. */
export class BriefRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefRefusal';
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One line of author text inside the grounding block, clamped so "never truncated" stays true of it. */
const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

// cm:guard the grounding block is the half `projectBrief` never truncates, so every author-supplied
// string in it is clamped HERE: a project name or a waiting issue's title is unbounded, and one long
// enough would push the counts and the pipeline past the cap and out of the brief through the final
// slice — which is exactly the failure the two budgets exist to prevent (ISS-1066).
const NAME_MAX = 120;
const TITLE_MAX = 200;

const groundingLines = (src: ProjectBriefSource): string[] => {
  const counts = Object.entries(src.counts.byStatus).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  return [
    `# ${clamp(src.detail.name, NAME_MAX)} (${clamp(src.slug, NAME_MAX)})`,
    '',
    '## Issue counts by status',
    counts.length === 0
      ? 'The project holds no issues.'
      : `${counts.map(([status, n]) => `${status} ${n}`).join(' · ')} — ${total} in all.`,
    '',
    '## Effective pipeline, in order',
    src.pipelineStates.join(' → '),
    "This is the product's canonical ladder with this project's stage overrides applied. The stored `pipelineConfig.states` map is per-stage configuration over four optional keys and is NOT this sequence.",
    '',
    '## Filing rules',
    `- Issue keys on this project read \`${src.detail.issuePrefix ?? 'ISS'}-<number>\`.`,
    src.intakeGate
      ? '- The intake gate is ON: a new filing is parked at `draft` and a person admits it before any work starts.'
      : '- The intake gate is off: a new filing lands at `open`, where the pipeline picks it up.',
    '- The deployment serves no other per-project filing rule; anything else is the product-wide method.',
    '',
    '## Issue waiting on information',
    src.waitingIssue
      ? `${src.waitingIssue.key} — ${clamp(src.waitingIssue.title, TITLE_MAX)}`
      : 'The project holds no issue waiting on information.',
  ];
};

interface AuthorSection {
  name: string;
  body: string;
}

const authorSections = (src: ProjectBriefSource): AuthorSection[] => {
  const facts = Object.entries(src.facts);
  const knowledge = src.knowledge.map((e) => {
    const head = `- **${e.title}** [${e.kind}, injection ${e.injection}]`;
    return e.body ? `${head}\n${e.body.trim()}` : head;
  });
  if (src.knowledgeOmitted > 0)
    knowledge.push(
      `(${src.knowledgeOmitted} further entr${src.knowledgeOmitted === 1 ? 'y is' : 'ies are'} not listed: the deployment capped the index response.)`,
    );
  return [
    {
      name: 'What this project is',
      body: src.detail.description?.trim() || 'The project states no description.',
    },
    {
      name: 'Project facts',
      body:
        facts.length === 0
          ? 'The project states no facts.'
          : facts.map(([key, text]) => `- **${key}**: ${text.trim()}`).join('\n'),
    },
    {
      name: 'Knowledge entries',
      body:
        knowledge.length === 0 ? 'The project holds no knowledge entries.' : knowledge.join('\n'),
    },
    {
      name: `Newest ${src.newestIssues.length} issues`,
      body:
        src.newestIssues.length === 0
          ? 'The project holds no issues.'
          : src.newestIssues.map((i) => `- ${i.key} [${i.status}] ${i.title}`).join('\n'),
    },
  ];
};

/**
 * Each over-long section cut to its share of what the grounding block left, with the surplus of the
 * short ones handed back to the long ones. A section with no room at all says it was dropped, so a
 * reader is never left to infer a section's absence from silence.
 */
function allowances(sections: AuthorSection[], budget: number): number[] {
  const lengths = sections.map((s) => s.body.length);
  const out = lengths.map(() => 0);
  let left = Math.max(0, budget);
  const open = sections.map((_, i) => i);
  while (open.length > 0) {
    const share = Math.floor(left / open.length);
    const fits = open.filter((i) => (lengths[i] ?? 0) <= share);
    if (fits.length === 0) {
      for (const i of open) out[i] = share;
      return out;
    }
    for (const i of fits) {
      out[i] = lengths[i] ?? 0;
      left -= out[i] ?? 0;
      open.splice(open.indexOf(i), 1);
    }
  }
  return out;
}

const CUT = (n: number): string =>
  `\n…[cut: ${n} more character(s) of this section are not in the brief]`;
const DROPPED = '[dropped: the brief had no room left for this section]';

/** Pure: the brief as the judge reads it, never longer than `BRIEF_MAX_CHARS`. */
export function projectBrief(src: ProjectBriefSource): string {
  const grounding = groundingLines(src).join('\n');
  const sections = authorSections(src);
  const headings = sections.map((s) => `\n\n## ${s.name}\n`);
  const overhead = headings.reduce((sum, h) => sum + h.length, 0);
  const shares = allowances(sections, BRIEF_MAX_CHARS - grounding.length - overhead);
  const rendered = sections.map((section, i) => {
    const share = shares[i] ?? 0;
    const body = section.body;
    if (body.length <= share) return `${headings[i]}${body}`;
    const room = share - CUT(body.length).length;
    if (room <= 0) return `${headings[i]}${DROPPED}`;
    return `${headings[i]}${body.slice(0, room)}${CUT(body.length - room)}`;
  });
  return `${grounding}${rendered.join('')}`.slice(0, BRIEF_MAX_CHARS);
}

/** The fixture rules a project's own shape can make inapplicable; each names what the project lacks. */
const NOT_APPLICABLE: ReadonlyArray<{
  fixture: FixtureName;
  lacking: (src: ProjectBriefSource) => boolean;
  why: string;
}> = [
  {
    fixture: 'waitingIssue',
    lacking: (src) => src.waitingIssue === null,
    why: 'the project holds no issue waiting on information',
  },
  {
    fixture: 'newestOpenIssues',
    lacking: (src) => src.newestOpenIssues.length === 0,
    why: 'the project holds no open issue',
  },
];

/**
 * Why this task does not apply to this project, or null. A task the project cannot supply a fixture
 * for is recorded rather than run: the refusal was right and three failed trials were the wrong
 * figure for it (ISS-1066).
 */
export function fixtureNotApplicable(task: Task, src: ProjectBriefSource): string | null {
  const fixtures = task.fixtures ?? [];
  for (const rule of NOT_APPLICABLE) {
    if (fixtures.includes(rule.fixture) && rule.lacking(src)) return rule.why;
  }
  return null;
}

/**
 * The index as the brief lists it: the rows the index returned, plus any always-injected entry the
 * response cap left out of them. Fetching a body for an entry with no row to hang it on is how the
 * first draft of this dropped the very prose it had just paid a request for.
 */
function mergeKnowledge(
  rows: KnowledgeRow[],
  always: KnowledgeRow[],
  bodies: Map<string, string>,
): BriefKnowledgeEntry[] {
  const listed = new Set(rows.map((r) => r.slug));
  return [
    ...rows.map((e) => ({ ...e, body: bodies.get(e.slug) ?? null })),
    ...always
      .filter((e) => !listed.has(e.slug))
      .map((e) => ({ ...e, body: bodies.get(e.slug) ?? null })),
  ];
}

/** The first issue waiting on information, or null where the project has none; any other refusal stands. */
async function waitingOrNone(client: BenchClient, projectId: string): Promise<IssueRef | null> {
  try {
    return await client.waitingIssue(projectId);
  } catch (err) {
    // cm:guard status 200 is the route answering with an empty list, which is a fact about the project; a 403 or a 500 is not, and must not read as "no waiting issue"
    if (err instanceof DeploymentRefusal && err.status === 200) return null;
    throw err;
  }
}

/** Every read the brief needs, once per run. Refuses by name where the credential cannot see the knowledge. */
export async function readProjectBrief(
  client: BenchClient,
  project: Project,
  now: () => Date,
): Promise<ProjectBriefSource> {
  let index: KnowledgeIndex;
  try {
    index = await client.knowledge(project.id);
  } catch (err) {
    throw new BriefRefusal(
      `cannot read this project's knowledge: ${errorText(err)}. The benchmark's project brief is assembled from it and handed to the judge on every turn, so a run without it would grade every project answer against nothing. Give the credential membership of ${project.slug}, or run against a project it already holds.`,
    );
  }
  // cm:guard the always-injected entries are read with the route's own filter, NOT by filtering the
  // index: the index arrives as a prefix once it passes the deployment's 38,000-character response
  // cap (`knowledge/service.ts:MAX_RESPONSE_CHARS`), so a project whose always-injected rules fall
  // past that prefix would contribute none of its load-bearing prose while the brief read as
  // complete (codex F1).
  const always = await client.knowledge(project.id, 'always');
  const wanted = always.rows.slice(0, BRIEF_KNOWLEDGE_BODIES);
  const bodies = new Map<string, string>();
  for (const entry of wanted)
    bodies.set(entry.slug, await client.knowledgeEntry(project.id, entry.slug));
  const [detail, config, counts, facts, newestIssues, newestOpenIssues, waitingIssue] =
    await Promise.all([
      client.projectDetail(project.id),
      client.pipelineConfig(project.id),
      client.issueCounts(project.id),
      client.projectFacts(project.id),
      client.newestIssues(project.id, BRIEF_NEWEST_ISSUES),
      client.newestOpenIssues(project.id, BRIEF_OPEN_ISSUES),
      waitingOrNone(client, project.id),
    ]);
  return {
    slug: project.slug,
    detail,
    counts,
    pipelineStates: await client.pipelineStates(project.id),
    intakeGate: config.intakeGate,
    facts,
    knowledge: mergeKnowledge(index.rows, wanted, bodies),
    // cm:guard the omitted count is what the cap left out of the INDEX minus the always-injected
    // entries recovered by the filtered read, so an entry the brief does carry is never also
    // reported missing
    knowledgeOmitted: Math.max(
      0,
      index.total -
        index.rows.length -
        wanted.filter((e) => !index.rows.some((row) => row.slug === e.slug)).length,
    ),
    newestIssues,
    newestOpenIssues,
    waitingIssue,
    readAt: now().toISOString(),
  };
}
