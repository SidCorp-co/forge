// MJ-3, MJ-6: a memory is only as true as the records it names. Every read that shows one to a
// person or an agent reads the sources its text cites — issue and requirement keys, workflows by
// their flow (REQ-33 BC-4), commits and releases — and links each. A key is read in the project the text places it in: this project,
// unless a sibling project of the same organization is named beside it (`epod ISS-4`, `epod#ISS-4`).
// A key the text places in a project it does not name (`core ISS-96`) is `unchecked` and never read
// against this project's numbers. A sibling is read only for a reader who may read it (REQ-30 BC-10):
// a key placed in one they may not reads exactly as one placed in a project the text does not name,
// so nothing of that project — whether the row exists, its status, its prefix — reaches them. Each key that no longer resolves — no such record, dropped,
// archived — is named back as why the memory reads stale. Derived on read, never stored, so it
// cannot drift, and nothing here archives or deletes a row.

import type { MemoryCite, MemoryStaleRef } from '@forge/contracts/memory';
import type { ProjectReader } from '../lib/authz.js';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { memoryIssueReads } from './ports.js';

const KEY_RE = /\b([A-Z][A-Z0-9]{1,5})-(\d{1,6})\b/g;
const REQUIREMENT_PREFIX = 'REQ';
/** A commit sha as it is written in prose: 7 to 40 hex characters, not part of a uuid or a word. */
const SHA_RE = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;
/** A release version as a project's release runs record it (`0.2.0`, `0.4.0-dev.112`), `v` optional. */
const VERSION_RE = /(?<![\w.-])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![\w-])/g;
/** Words that put a key in another codebase without naming a project of this organization. */
const ELSEWHERE_WORDS = new Set(['core', 'forge-core', 'upstream', 'plugin', 'forge-plugin']);
/** Characters that end the clause a key's qualifier is read from. */
const CLAUSE_END = /[.;,()[\]\n]/;

/** A project a key may be read in. */
export interface CiteProject {
  id: string;
  slug: string;
  name: string;
  /** The issue prefixes its keys are written under. */
  prefixes: ReadonlySet<string>;
}

/** What a memory's text is read against: its own project and the organization's other projects. */
export interface CiteContext {
  self: CiteProject;
  siblings: readonly CiteProject[];
  /** The ids of the siblings this reader may not read: a key placed in one is never read there. */
  unreadable: ReadonlySet<string>;
  /** The flows this project's workflows are drawn under; a workflow is named only in its own project. */
  flows?: readonly string[];
}

/** A flow named as a whole word, any case: not inside a longer flow, key or path segment. */
function flowPattern(flow: string): RegExp {
  const escaped = flow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi');
}

/** One key or source as the text names it, before anything is resolved. */
export interface ParsedCite {
  at: number;
  ref: string;
  kind: MemoryCite['kind'];
  /** The project it is read in; null when the text places it in a project it does not name. */
  project: CiteProject | null;
  /** The sequence of an issue or requirement key. */
  seq?: number;
}

/** The issue prefixes a project's keys are written under: every one held, and `ISS` while it renders. */
export function issuePrefixSet(p: { active: string | null; held: readonly string[] }): Set<string> {
  const set = new Set(p.held.map((h) => h.toUpperCase()));
  set.add((p.active ?? LEGACY_ISSUE_PREFIX).toUpperCase());
  return set;
}

/** The words of the clause just before `at`, last three, lowercased: where a key's qualifier is. */
function qualifierWords(text: string, at: number): string[] {
  const before = text.slice(Math.max(0, at - 60), at);
  const clause = before.split(CLAUSE_END).pop() ?? '';
  return clause
    .split(/[\s#:/]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
    .slice(-3);
}

/** Where the text places a key: a named sibling, somewhere it does not name (null), or this project. */
function placement(text: string, at: number, ctx: CiteContext): CiteProject | null {
  const words = qualifierWords(text, at);
  const named = ctx.siblings.find(
    (p) => p.id !== ctx.self.id && words.includes(p.slug.toLowerCase()),
  );
  if (named) return named;
  if (words.includes(ctx.self.slug.toLowerCase())) return ctx.self;
  const own = `${ctx.self.slug} ${ctx.self.name}`.toLowerCase();
  if (words.some((w) => ELSEWHERE_WORDS.has(w) && !own.includes(w))) return null;
  return ctx.self;
}

/** Every source a text cites, in the order it names them, each once. */
export function parseCites(text: string, ctx: CiteContext): ParsedCite[] {
  const out: ParsedCite[] = [];
  const seen = new Set<string>();
  const push = (c: ParsedCite) => {
    const key = `${c.kind}:${c.ref}:${c.project?.id ?? '-'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const readable = [ctx.self, ...ctx.siblings].filter((p) => !ctx.unreadable.has(p.id));
  for (const m of text.matchAll(KEY_RE)) {
    const [ref, prefix, n] = m;
    if (!prefix || !n || m.index === undefined) continue;
    const placed = placement(text, m.index, ctx);
    const project = placed && ctx.unreadable.has(placed.id) ? null : placed;
    if (prefix === REQUIREMENT_PREFIX) {
      push({ at: m.index, ref, kind: 'requirement', project, seq: Number(n) });
    } else if (project ? project.prefixes.has(prefix) : true) {
      if (!project && !readable.some((p) => p.prefixes.has(prefix))) continue;
      push({ at: m.index, ref, kind: 'issue', project, seq: Number(n) });
    }
  }
  for (const flow of ctx.flows ?? []) {
    for (const m of text.matchAll(flowPattern(flow))) {
      if (m.index === undefined) continue;
      push({ at: m.index, ref: flow, kind: 'workflow', project: ctx.self });
    }
  }
  for (const m of text.matchAll(SHA_RE)) {
    const sha = m[0];
    if (m.index === undefined || !/[0-9]/.test(sha) || !/[a-f]/.test(sha)) continue;
    push({ at: m.index, ref: sha, kind: 'commit', project: ctx.self });
  }
  for (const m of text.matchAll(VERSION_RE)) {
    if (m.index === undefined || !m[1]) continue;
    push({ at: m.index, ref: m[1], kind: 'release', project: ctx.self });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** What one project holds for the keys and versions a page of memories cites in it. */
export interface ProjectHoldings {
  issues: ReadonlyMap<number, { status: string; archived: boolean; updatedAt: Date }>;
  requirements: ReadonlyMap<number, { status: string; updatedAt: Date }>;
  /** The project's workflows by flow, with their last change. */
  workflows: ReadonlyMap<string, Date>;
  releases: ReadonlySet<string>;
  repositoryWebUrl: string | null;
}

/** A commit's page on the repository host: GitLab under `/-/commit/`, every other host `/commit/`. */
function commitUrl(webUrl: string, sha: string): string {
  return /^https:\/\/[^/]*gitlab\./.test(webUrl)
    ? `${webUrl}/-/commit/${sha}`
    : `${webUrl}/commit/${sha}`;
}

/** Each parsed cite resolved against what its project holds; a release the project never had is no cite. */
export function resolveCites(
  parsed: readonly ParsedCite[],
  held: ReadonlyMap<string, ProjectHoldings>,
): MemoryCite[] {
  const out: MemoryCite[] = [];
  for (const c of parsed) {
    if (!c.project) {
      out.push({ ref: c.ref, kind: c.kind, project: null, state: 'unchecked' });
      continue;
    }
    const h = held.get(c.project.id);
    const base = { ref: c.ref, kind: c.kind, project: c.project.slug };
    if (!h) {
      out.push({ ...base, state: 'unchecked' });
    } else if (c.kind === 'issue') {
      const row = h.issues.get(c.seq as number);
      if (!row) out.push({ ...base, state: 'gone', why: 'missing' });
      else if (row.archived) out.push({ ...base, state: 'gone', why: 'archived' });
      else if (row.status === 'dropped') out.push({ ...base, state: 'gone', why: 'dropped' });
      else out.push({ ...base, state: 'resolved', changedAt: row.updatedAt.toISOString() });
    } else if (c.kind === 'requirement') {
      const row = h.requirements.get(c.seq as number);
      if (row === undefined) out.push({ ...base, state: 'gone', why: 'missing' });
      else if (row.status === 'dropped') out.push({ ...base, state: 'gone', why: 'dropped' });
      else out.push({ ...base, state: 'resolved', changedAt: row.updatedAt.toISOString() });
    } else if (c.kind === 'workflow') {
      const changedAt = h.workflows.get(c.ref);
      if (changedAt === undefined) out.push({ ...base, state: 'gone', why: 'missing' });
      else out.push({ ...base, state: 'resolved', changedAt: changedAt.toISOString() });
    } else if (c.kind === 'release') {
      if (h.releases.has(c.ref)) out.push({ ...base, state: 'resolved' });
    } else {
      out.push({
        ...base,
        state: 'unchecked',
        ...(h.repositoryWebUrl ? { url: commitUrl(h.repositoryWebUrl, c.ref) } : {}),
      });
    }
  }
  return out;
}

/** The cites that no longer resolve, as the stale list names them. */
export function staleRefsOf(cites: readonly MemoryCite[], selfSlug: string): MemoryStaleRef[] {
  return cites.flatMap((c) =>
    c.state === 'gone' &&
    c.why &&
    (c.kind === 'issue' || c.kind === 'requirement' || c.kind === 'workflow')
      ? [
          {
            ref: c.ref,
            kind: c.kind,
            why: c.why,
            ...(c.project && c.project !== selfSlug ? { project: c.project } : {}),
          },
        ]
      : [],
  );
}

/** The keys one memory cites, and those among them that no longer resolve. */
export interface Citations {
  cites: MemoryCite[];
  staleRefs: MemoryStaleRef[];
}

/**
 * Who a memory's citations are read for. A person reads a sibling's records only where the fence
 * of the credential they came on holds it and they hold `project.read` there. `own-project` is a
 * read made for no person (a gate, a port), which reads no sibling at all.
 */
export type CiteReader = ProjectReader | 'own-project';

/** The siblings the reader may not read; the project itself is the one the caller checked. */
async function unreadableOf(
  reader: CiteReader,
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const others = ids.filter((id) => id !== projectId);
  if (reader === 'own-project') return new Set(others);
  const { userId, fence } = reader;
  const may = await Promise.all(
    others.map((id) =>
      fence && !fence.includes(id)
        ? false
        : can(actorFor(userId), 'project.read', projectResource(id)),
    ),
  );
  return new Set(others.filter((_, i) => !may[i]));
}

async function contextOf(
  projectId: string,
  flows: readonly string[],
  reader: CiteReader,
): Promise<CiteContext> {
  const reads = memoryIssueReads();
  const rows = await reads.siblingProjects(projectId);
  const self = rows.find((r) => r.id === projectId);
  if (!self)
    throw new Error(`memory citations: project ${projectId} is not in its own organization's list`);
  const unreadable = await unreadableOf(
    reader,
    projectId,
    rows.map((r) => r.id),
  );
  const held = await reads.issuePrefixes(projectId);
  const project = (r: (typeof rows)[number]): CiteProject => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    prefixes:
      r.id === projectId
        ? issuePrefixSet(held)
        : issuePrefixSet({ active: r.issuePrefix, held: [] }),
  });
  return { self: project(self), siblings: rows.map(project), unreadable, flows };
}

async function holdingsOf(
  projectId: string,
  parsed: readonly ParsedCite[],
  workflows: ReadonlyMap<string, Date>,
): Promise<ProjectHoldings> {
  const reads = memoryIssueReads();
  const mine = parsed.filter((c) => c.project?.id === projectId);
  const seqs = (kind: ParsedCite['kind']) =>
    mine.filter((c) => c.kind === kind).map((c) => c.seq as number);
  const [issues, requirements, releases, repositoryWebUrl] = await Promise.all([
    reads.issueStandings(projectId, seqs('issue')),
    reads.requirementStatuses(projectId, seqs('requirement')),
    reads.releaseVersions(
      projectId,
      mine.filter((c) => c.kind === 'release').map((c) => c.ref),
    ),
    mine.some((c) => c.kind === 'commit')
      ? reads.repositoryWebUrl(projectId)
      : Promise.resolve(null),
  ]);
  return { issues, requirements, workflows, releases, repositoryWebUrl };
}

/**
 * For each text, every source it cites, linked, and the ones among them that no longer resolve, as
 * `reader` may see them: no record of a project they may not read is read.
 */
export async function resolveCitations(
  projectId: string,
  texts: readonly string[],
  reader: CiteReader,
): Promise<Citations[]> {
  if (texts.length === 0) return [];
  const drawn = await memoryIssueReads().workflowFlows(projectId);
  const ctx = await contextOf(
    projectId,
    drawn.map((w) => w.flow),
    reader,
  );
  const workflows = new Map(drawn.map((w) => [w.flow, w.updatedAt]));
  const parsed = texts.map((t) => parseCites(t, ctx));
  const projectIds = new Set(parsed.flat().flatMap((c) => (c.project ? [c.project.id] : [])));
  const held = new Map<string, ProjectHoldings>();
  await Promise.all(
    [...projectIds].map(async (id) => {
      held.set(id, await holdingsOf(id, parsed.flat(), id === projectId ? workflows : new Map()));
    }),
  );
  return parsed.map((p) => {
    const cites = resolveCites(p, held);
    return { cites, staleRefs: staleRefsOf(cites, ctx.self.slug) };
  });
}
