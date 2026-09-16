import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ISS-1003 — `users.display_name` decides nothing.
 *
 * The column is a LABEL a person reads: free text, not unique, accented,
 * changeable by whoever owns it. The address a mention resolves against is
 * `organization_members.handle`, which is unique within its org. Keeping those
 * apart is the whole reason there are two columns, and the reason is in
 * `assistant_speaker_links`' own words one table over — a re-assignable name
 * used as a key hands the next holder of that name the previous holder's
 * authority.
 *
 * That rule cannot be proved by a behavioural test, because the claim is a
 * negative over every module: the first authorization, lookup or mention
 * resolver to read the label would pass every test in the suite. So this is a
 * SCAN, and it names what it can see: which files may mention the column at
 * all. A reader that reaches it through a variable named something else is out
 * of its sight, which is why the allowlist is short enough for a reviewer to
 * check by eye rather than a filter that lets most files through.
 */

const SRC = new URL('..', import.meta.url).pathname;

/**
 * The files allowed to name the column, each for a stated reason. A new entry
 * is a decision about what the label is for, so it needs a sentence and not
 * just a path.
 */
const PRESENTATION_AND_MAPPING: Record<string, string> = {
  'db/schema.ts': 'the declaration itself',
  'auth/me.ts': 'a person reads and sets their own label',
  'orgs/agent-accounts.ts': 'an org admin reads and sets an agent’s label',
  'orgs/service.ts': 'the org member list returns it beside the address',
  'issues/actor-resolution.ts': 'the label an activity row is rendered by',
  'assistant/conversation-routes.ts':
    'the name a person’s own message is attributed by in a conversation transcript, which is a label read by whoever opens the room and by the model answering in it — it addresses nobody and resolves nothing',
  'assistant/conversation-people.ts':
    'the name a room’s member list and its candidate list are PRINTED by, attached on the way out of the request. It exists because `conversations/` is named below as a place the column may not be read, and a roster still has to say who somebody is: an agent prints its address, which is what resolves, and a person prints this label, which resolves nothing (ISS-1011)',
};

/**
 * Every spelling of the column this scan can see. The snake_case form catches
 * raw SQL; the rest catch a query builder read.
 */
const SELF = 'db/display-name-readers.test.ts';

const SPELLINGS = [
  /\busers\s*\.\s*displayName\b/,
  /\busers\s*\[\s*['"`]displayName['"`]\s*\]/,
  /\{[^{}]*\bdisplayName\b[^{}]*\}\s*=\s*users\b/,
  /\bdisplay_name\b/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Comment lines are blanked, so a `cm:guard` explaining the rule is not a breach of it. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const t = line.trim();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line;
    })
    .join('\n');
}

function mentionsColumn(source: string): boolean {
  const code = stripComments(source);
  return SPELLINGS.some((re) => re.test(code));
}

/**
 * Whether this file imports the `users` table at all, under any local name.
 */
function importsUsersAndNamesTheLabel(source: string): boolean {
  const code = stripComments(source);
  const imports = /import\s*\{[^}]*\busers\b[^}]*\}\s*from\s*['"][^'"]*schema[^'"]*['"]/.test(code);
  return imports && /\bdisplayName\b/.test(code);
}

describe('displayName is rendered, never read to decide anything (ISS-1003)', () => {
  const files = walk(SRC);

  it('scans the whole source tree rather than a subset', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it('names the column only in the presentation and response-mapping modules that own it', () => {
    const offenders = files
      .map((f) => relative(SRC, f))
      .filter((rel) => rel !== SELF)
      .filter((rel) => !(rel in PRESENTATION_AND_MAPPING))
      .filter((rel) => mentionsColumn(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is imported beside the table by nobody outside those modules, under any alias', () => {
    const offenders = files
      .map((f) => relative(SRC, f))
      .filter((rel) => rel !== SELF)
      .filter((rel) => !(rel in PRESENTATION_AND_MAPPING))
      .filter((rel) => importsUsersAndNamesTheLabel(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('lists no file that has stopped naming it', () => {
    const stale = Object.keys(PRESENTATION_AND_MAPPING).filter((rel) => {
      try {
        return !mentionsColumn(readFileSync(join(SRC, rel), 'utf8'));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it('is named by no authorization or mention-resolution module', () => {
    const loadBearing = [
      'lib/authz.ts',
      'middleware/auth.ts',
      'middleware/require-pat.ts',
      'middleware/pat-rest-surface.ts',
      'auth/pat.ts',
      'auth/agent-account.ts',
      'conversations/participants.ts',
      'conversations/scope.ts',
      'conversations/handles.ts',
      'comments/mentions.ts',
    ];
    const reading = loadBearing.filter((rel) =>
      mentionsColumn(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(reading).toEqual([]);
  });
});
