// REQ-89 BC-5 (ISS-1121): an entry names the change that means re-checking it (`recheckWhen`) and what
// it rests on (`source`). The paths, routes, config keys and rule slugs those name are its anchors.
// When a change meets one — a landing whose commit touched a named path, whose text names a named
// route or config key, or a rewrite of a named rule — the entry is flagged: `metadata.recheckDue` on a
// project entry, `recheck_due` on an org entry, the release flag on a memory (`memory/recheck.ts`).
// The next agent or the Audit confirms, rewrites or retires it; a rewrite clears the flag.

import type { RecheckDue } from '@forge/contracts/knowledge';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, orgKnowledgeEntries, projects } from '../db/schema.js';

/** What an entry names that a change can meet. */
export interface Anchors {
  paths: string[];
  routes: string[];
  config: string[];
  rules: string[];
}

/** One change, as the re-check weighs it. */
export interface RecheckChange {
  /** What changed, as a flag names it: `ISS-12` for a landing, `rule <slug>` for a rule. */
  by: string;
  /** The paths a landing changed; empty for a rule change. */
  paths: readonly string[];
  /** The landing's own words (title, description, plan, release notes); empty for a rule change. */
  text: string;
  /** The rule slugs a rule change rewrote. */
  rules: readonly string[];
}

const FILE_EXT = /\.(ts|tsx|mts|mjs|cjs|js|jsx|json|md|sql|rs|sh|yml|yaml|toml|css|html)$/i;
const ROUTE = /\/api\/[A-Za-z0-9_:{}./-]+/g;
const TOKEN = /[A-Za-z0-9_.*{}/:-]+/g;
const DOTTED = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const BACKTICKED = /`([^`\n]{2,200})`/g;

const trimToken = (t: string) => t.replace(/^[(:"'<]+|[).,;:"'>]+$/g, '');

/** A route as matched: params as `:x`, no trailing slash. */
const routeKey = (r: string) =>
  r
    .replace(/\{[^}]+\}/g, ':x')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':x')
    .replace(/\/+$/, '');

/** The anchors the text of an entry's `recheckWhen` and `source` name. */
export function anchorsOf(...texts: (string | null | undefined)[]): Anchors {
  const out: Anchors = { paths: [], routes: [], config: [], rules: [] };
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(ROUTE)) out.routes.push(routeKey(trimToken(m[0])));
    const withoutRoutes = text.replace(ROUTE, ' ').replace(/https?:\/\/\S+/g, ' ');
    for (const m of withoutRoutes.matchAll(TOKEN)) {
      const token = trimToken(m[0]).replace(/:[A-Za-z_$][\w$.]*$/, '');
      if (token.length < 3) continue;
      if (token.includes('/') || FILE_EXT.test(token)) out.paths.push(token.replace(/^\.\//, ''));
    }
    for (const m of text.matchAll(BACKTICKED)) {
      const inner = (m[1] ?? '').trim();
      if (DOTTED.test(inner) && !FILE_EXT.test(inner)) out.config.push(inner);
      else if (SLUG.test(inner)) out.rules.push(inner);
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    paths: uniq(out.paths),
    routes: uniq(out.routes),
    config: uniq(out.config),
    rules: uniq(out.rules),
  };
}

/** A glob as a path pattern: `**` any depth, `*` one segment's characters. */
const globRe = (glob: string) => {
  const escaped = (part: string) =>
    part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .split('*')
      .join('[^/]*');
  return new RegExp(`(^|/)${glob.split('**').map(escaped).join('.*')}$`);
};

/** Whether a changed path is the anchor's file, lies under the anchor's directory, or matches its glob. */
function pathMeets(anchor: string, changed: string): boolean {
  if (anchor.includes('*')) return globRe(anchor).test(changed);
  const a = anchor.replace(/\/+$/, '');
  return (
    changed === a ||
    changed.endsWith(`/${a}`) ||
    changed.startsWith(`${a}/`) ||
    changed.includes(`/${a}/`)
  );
}

/** Each anchor of `anchors` the change meets, as named. */
export function anchorsMet(anchors: Anchors, change: RecheckChange): string[] {
  const met: string[] = [];
  for (const p of anchors.paths) if (change.paths.some((c) => pathMeets(p, c))) met.push(p);
  const routesNamed = new Set(
    [...change.text.matchAll(ROUTE)].map((m) => routeKey(trimToken(m[0]))),
  );
  for (const r of anchors.routes) if (routesNamed.has(r)) met.push(r);
  for (const k of anchors.config) if (change.text.includes(k)) met.push(k);
  for (const r of anchors.rules) if (change.rules.includes(r)) met.push(r);
  return met;
}

const due = (change: RecheckChange, matched: string[], at: string): RecheckDue => ({
  since: at,
  by: change.by,
  matched,
});

/**
 * Flag the project's live knowledge entries, and its org's entries, whose anchors the change meets;
 * how many were flagged. A lesson is the lessons module's and is weighed like any other entry: its
 * `recheckWhen` names what it rests on too.
 */
export async function flagKnowledgeForChange(
  projectId: string,
  change: RecheckChange,
  at: string = new Date().toISOString(),
): Promise<number> {
  let flagged = 0;
  const own = await db
    .select({
      id: knowledgeEntries.id,
      slug: knowledgeEntries.slug,
      source: knowledgeEntries.source,
      recheckWhen: knowledgeEntries.recheckWhen,
    })
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.projectId, projectId),
        isNull(knowledgeEntries.archivedAt),
        or(isNotNull(knowledgeEntries.recheckWhen), isNotNull(knowledgeEntries.source)),
      ),
    );
  // the rule rewritten is the change itself, never a reader of it
  const rewritten = (slug: string) => change.rules.includes(slug);
  for (const row of own) {
    if (rewritten(row.slug)) continue;
    const matched = anchorsMet(anchorsOf(row.recheckWhen, row.source), change);
    if (matched.length === 0) continue;
    await db
      .update(knowledgeEntries)
      .set({
        metadata: sql`${knowledgeEntries.metadata} || jsonb_build_object('recheckDue', ${JSON.stringify(due(change, matched, at))}::jsonb)`,
      })
      .where(eq(knowledgeEntries.id, row.id));
    flagged++;
  }
  const org = await db
    .select({
      id: orgKnowledgeEntries.id,
      slug: orgKnowledgeEntries.slug,
      source: orgKnowledgeEntries.source,
      recheckWhen: orgKnowledgeEntries.recheckWhen,
    })
    .from(orgKnowledgeEntries)
    .innerJoin(projects, eq(projects.orgId, orgKnowledgeEntries.orgId))
    .where(eq(projects.id, projectId));
  for (const row of org) {
    if (rewritten(row.slug)) continue;
    const matched = anchorsMet(anchorsOf(row.recheckWhen, row.source), change);
    if (matched.length === 0) continue;
    await db
      .update(orgKnowledgeEntries)
      .set({ recheckDue: due(change, matched, at) })
      .where(eq(orgKnowledgeEntries.id, row.id));
    flagged++;
  }
  return flagged;
}

/** The re-check flagged on an entry, as a read answers it; null where none stands. */
export function recheckDueOf(v: unknown): RecheckDue | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.since === 'string' && typeof o.by === 'string' && Array.isArray(o.matched)
    ? {
        since: o.since,
        by: o.by,
        matched: o.matched.filter((m): m is string => typeof m === 'string'),
      }
    : null;
}

/** The change a rewrite of `slug` is, as the re-check weighs it. */
export const ruleChange = (slug: string): RecheckChange => ({
  by: `rule ${slug}`,
  paths: [],
  text: '',
  rules: [slug],
});
