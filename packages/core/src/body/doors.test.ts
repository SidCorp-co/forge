import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectIssueFieldUpdates } from '../issues/patch-fields.js';
import { bodySlots, bodyText } from './prepare.js';

/**
 * `refuseUnrecordedClose` states the shape of the rule this file gates: a rule
 * with two doors has to stand at both. A body reaches core through seven
 * caller-supplied doors, and a gate on six of them is a gate on none — so this
 * suite is what turns the enumeration in ISS-898's plan from a claim into a
 * check. The chat-guard suite is the precedent, and it works: it caught
 * `descriptionFormat` reaching chat unclassified within the hour.
 */

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every write path that takes a body from its CALLER. Each must gate it. */
const DOORS: Record<string, RegExp> = {
  'comments/service.ts': /prepareBody\(/,
  'comments/routes.ts': /prepareBodyOrThrow\(|updateCommentBody\(/,
  'issues/create-service.ts': /prepareBody\(/,
  'issues/patch-fields.ts': /prepareBody\(/,
  'mcp/tools/forge-comments.ts': /insertComment\(|updateCommentBody\(/,
  'mcp/tools/forge-issues.ts': /collectIssueFieldUpdates\(|createIssue\(/,
};

/**
 * Write paths that format their OWN text and take the `markdown` column
 * default. Listed rather than ignored: a new file here is a decision, and the
 * only wrong answer is the one nobody made.
 */
const KERNEL_AUTHORED = [
  'agent-sessions/steer-session.ts',
  'issues/apply-transition.ts',
  'issues/drop-unblock.ts',
  'issues/merge-marker.ts',
  'issues/transition-reason.ts',
  'issues/extras-routes.ts',
  'issues/merged-at.ts',
  'jobs/budget-check.ts',
  'memory/knowledge-promotion.ts',
  'pipeline/autonomous-rescue-comment.ts',
  'pipeline/decomposition-subscribers.ts',
  'pipeline/missing-skill-guard.ts',
  'pipeline/stage-stall-guard.ts',
  'pm/routes.ts',
  'release-batch/claim-subscriber.ts',
  'release-batch/service.ts',
  'webhooks/github-adapter.ts',
];

/**
 * Executors that write a body someone else already prepared. `updateIssueFields`
 * takes an opaque `updates` map built by `collectIssueFieldUpdates`, which is
 * the gate — validating again here would be a second copy of the rule.
 */
const PREPARED_UPSTREAM = ['issues/update-service.ts'];

/**
 * The four read paths that must see the PROJECTION rather than the markup.
 *
 * ISS-898's proposal named only the first two. Under thin-init the per-state
 * include lists default EMPTY, so `prompt/user.ts` inlines the title alone and
 * the MCP serializers are what actually carry a description or a comment to an
 * agent — wiring only the named pair would project almost none of the bytes.
 */
const READ_PATHS: Record<string, RegExp> = {
  'prompt/user.ts': /bodyText\(/,
  'memory/indexer.ts': /bodyText\(/,
  'mcp/tools/forge-issues.ts': /bodyText\(/,
  'mcp/tools/forge-comments.ts': /bodyText\(/,
};

const WRITES_A_BODY = /\.(insert|update)\((comments|issues)\)/;

/**
 * A strip is only reported if the TRANSPORT hands it back. `prepareBody`
 * returns `warnings` on every door, but two of them dropped it on the floor
 * until the ISS-898 live walk hit them: REST comment create and MCP
 * `forge_issues` create. AC 6/7 measure this response, not the stored row, so
 * a caller who typed `<div>` and got a 201 had no way to learn it was
 * unwrapped. Each entry is the pair of writes that file answers.
 */
const WARNING_SURFACES: Record<string, RegExp[]> = {
  'comments/routes.ts': [/\{ \.\.\.inserted, warnings/, /\{ \.\.\.updated, warnings/],
  'issues/routes.ts': [/response\.warnings = /, /\{ \.\.\.patched, warnings/],
  'mcp/tools/forge-comments.ts': [
    /result\.warnings = bodyWarnings/,
    /result\.warnings = written\.warnings/,
  ],
  'mcp/tools/forge-issues.ts': [/out\.warnings = /, /updateResult\.warnings = /],
};

// cm:why comments are stripped before the scan because a cm:guard that QUOTES `db.insert(comments)` to explain the rule is not a write path — the first one written flagged `db/schema.ts` as an unclassified writer
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') out.push(...walk(p));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('every caller-supplied body door is gated', () => {
  it('each declared door calls the gate', () => {
    for (const [rel, pattern] of Object.entries(DOORS)) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(pattern.test(src), `${rel} no longer reaches the body gate`).toBe(true);
    }
  });

  it('all four read paths project the body instead of handing over markup', () => {
    for (const [rel, pattern] of Object.entries(READ_PATHS)) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(pattern.test(src), `${rel} no longer projects the body`).toBe(true);
    }
  });

  it('every door that answers its caller hands back the strips it made', () => {
    for (const [rel, patterns] of Object.entries(WARNING_SURFACES)) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      for (const pattern of patterns) {
        expect(
          pattern.test(src),
          `${rel} performs a strip and answers 201/200 without reporting it (${pattern.source})`,
        ).toBe(true);
      }
    }
  });

  it('no new writer of comments.body or issues.description appears unclassified', () => {
    const classified = new Set([...Object.keys(DOORS), ...KERNEL_AUTHORED, ...PREPARED_UPSTREAM]);
    const writers = walk(SRC)
      .filter((f) => WRITES_A_BODY.test(codeOf(f)))
      .map((f) => relative(SRC, f).split('\\').join('/'));
    expect(
      writers.filter((w) => !classified.has(w)),
      'a new write path must be added to DOORS (it takes a caller body → gate it) or to KERNEL_AUTHORED (it formats its own text → column default)',
    ).toEqual([]);
  });
});

/**
 * `IssueSnapshot.descriptionFormat` is optional so an absent value degrades to
 * the raw body rather than throwing. That makes the type no longer the guard —
 * this is.
 */
const FORMAT_PRODUCERS = ['issues/create-service.ts'];

describe('every issueCreated producer names the description format', () => {
  it('or the memory indexer embeds raw markup and the vector describes the template', () => {
    for (const rel of FORMAT_PRODUCERS) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      expect(/descriptionFormat/.test(src), `${rel} emits a snapshot with no format`).toBe(true);
    }
  });
});

describe('the issue-patch convergence point', () => {
  const patch = (input: Record<string, unknown>) =>
    collectIssueFieldUpdates(input, ['title', 'description']);

  it('normalizes an html description and records its template', () => {
    const { updates, warnings } = patch({
      description: '<forge-blocked on="decision"><p>which one?</p></forge-blocked>',
      descriptionFormat: 'html',
    });
    expect(updates.descriptionFormat).toBe('html');
    expect(updates.descriptionTemplate).toBe('forge-blocked');
    expect(warnings).toEqual([]);
  });

  it('refuses an invalid component body, naming the attribute and its legal set', () => {
    expect(() =>
      patch({
        description: '<forge-blocked on="vibes">x</forge-blocked>',
        descriptionFormat: 'html',
      }),
    ).toThrow(/forge-blocked@on.*decision\|resource\|person/s);
  });

  it('leaves a markdown description byte-identical and untemplated', () => {
    const raw = '## Problem\n\nIt 500s.\n';
    const { updates } = patch({ description: raw });
    expect(updates.description).toBe(raw);
    expect(updates.descriptionFormat).toBe('markdown');
    expect(updates.descriptionTemplate).toBeNull();
  });

  it('resets the format when the description is cleared', () => {
    const { updates } = patch({ description: null });
    expect(updates.descriptionFormat).toBe('markdown');
    expect(updates.descriptionTemplate).toBeNull();
  });

  it('reports the format change so the memory indexer can project the new body', () => {
    const changed: string[] = [];
    collectIssueFieldUpdates(
      { description: '<forge-blocked on="decision">x</forge-blocked>', descriptionFormat: 'html' },
      ['description'],
      (f) => changed.push(f),
    );
    expect(changed).toContain('descriptionFormat');
  });

  it('does not touch the format when the patch carries no description', () => {
    const { updates } = patch({ title: 'renamed' });
    expect(updates).toEqual({ title: 'renamed' });
  });
});

describe('the read projection is safe on stored rows', () => {
  it('degrades an unparseable stored html body to its own bytes rather than throwing', () => {
    const broken = '<forge-review sha="abc1234"><p>never closed';
    expect(bodyText(broken, 'html')).toBe(broken);
  });

  it('passes a markdown row through untouched', () => {
    expect(bodyText('**Triage** — m', 'markdown')).toBe('**Triage** — m');
    expect(bodyText('**Triage** — m', null)).toBe('**Triage** — m');
  });

  /**
   * `issueUpdated` carries only the fields whose VALUE moved, and `track` in
   * `issues/routes.ts` is what drops the rest — so editing an html description
   * that was already html emits `description` with no format. Measured live on
   * forge-beta: ISS-899's body was re-embedded as raw `<forge-problem>` markup.
   */
  it('projects a component body whose format was lost in transit, rather than embedding markup', () => {
    const body = '<forge-symptom><forge-opening>patched</forge-opening></forge-symptom>';
    const text = bodyText(body, null);
    expect(text).not.toContain('<forge-');
    expect(text).toContain('patched');
    expect(bodySlots(body, null)).not.toBeNull();
  });

  it('still refuses to sniff a row that SAYS markdown, whatever it contains', () => {
    const body = '<forge-symptom><forge-opening>x</forge-opening></forge-symptom>';
    expect(bodyText(body, 'markdown')).toBe(body);
    expect(bodySlots(body, 'markdown')).toBeNull();
  });
});
