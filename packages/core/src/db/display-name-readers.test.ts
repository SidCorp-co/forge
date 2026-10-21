import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  'orgs/service.ts':
    'the org member list returns it beside the address, and a personal workspace is named by it, else "Personal", in place of the address (ISS-1229 r21). It decides nothing: whose workspace it is is read off `created_by`',
  'issues/actor-resolution.ts': 'the label an activity row is rendered by',
  'comments/forge-author.ts':
    'writes the label Forge’s own account is minted with, and reads nothing back: it is decided by its fixed id (ISS-1421)',
  'issues/creator.ts':
    'the label an issue’s creator is rendered by on every issue list and detail, which is the same job `actor-resolution.ts` does for an activity row. It decides nothing: `users.kind` decides whether the writer is an agent, and this is only what that writer is CALLED (ISS-1137)',
  'projects/members-routes.ts':
    'the project member list returns it beside the address, exactly as `orgs/service.ts` does for the org member list. The creator filter is built from this list and cannot name an agent it is only told the address of (ISS-1137)',
  'projects/stuck-issue-kinds.ts':
    'the name a park somebody else owes is printed by on Needs you, the Attention page and the bell, so a reader is told whose decision it waits for (ISS-1229 r16). It decides nothing: who owes the park is read off the assignee and creator ids',
  'projects/pending-invitations.ts':
    'the name the bell’s invitation row prints its inviter by, in place of their address (ISS-1229 r18). It decides nothing: which invitations are offered is read off the invitee’s address and the invitation rows',
  'notifications/notify-mentions.ts':
    'the name a mention notice prints its mentioner by, through `personName`, in place of the part of their address before the "@" (ISS-1229 r20). It decides nothing: who is told is read off the mentioned user ids',
  'projects/health-aggregates.ts':
    'the name a project card’s member avatars take their initials from, through `personName`, in place of their address (ISS-1229 r20). It decides nothing: who is a member is read off the membership rows',
  'conversations/speaker-names.ts':
    'the name a person’s own message is attributed by in a conversation transcript, read from the person each time it is shown and never stored, through `personNameSql` (ISS-1229 r25). It is a label read by whoever opens the room and by the model answering in it — it addresses nobody and resolves nothing',
  'conversations/membership.ts':
    'the name the line a room is told when somebody joins or leaves prints them by, through `personName`, in place of their address (ISS-1229 r21). It decides nothing: who is in the room is read off the participant rows',
  'issues/attributes/read.ts':
    'the name an issue attribute that refers to a person is printed by, through `personName`, in place of their address (ISS-1229 r21). It decides nothing: the attribute holds the user id',
  'pipeline/runs-attempts.ts':
    'the name a cancelled step is printed by in the run drawer ("Cancelled by Sam"), through `personNameSql`, so an address reads as the unnamed person (ISS-1228 r19). It decides nothing: who cancelled is read off the cancel transition’s actor',
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
        const source = readFileSync(join(SRC, rel), 'utf8');
        return !mentionsColumn(source) && !importsUsersAndNamesTheLabel(source);
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
