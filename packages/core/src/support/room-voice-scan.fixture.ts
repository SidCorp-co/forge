// The guard behind `room-voice-scan.test.ts` (ISS-1483): it reads every string and template literal of
// the files a room's agent or a users' room is handed text from, and returns each that names the
// master, a team or a hand-off as the one acting (`NAMES_THE_HAND`). Nothing is listed per string: a
// sentence added tomorrow is read the day it is written. What a literal may hold anyway is the small
// `ALLOWED` list below, each entry with its reason, and an entry that no longer matches anything fails.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { NAMES_THE_HAND } from './room-voice.js';

/** Where a sentence a room reads is worded: the support module, the chat-room assistant, the room agent's guide. */
const SCOPE = [
  /^support\//,
  /^assistant\/chat-room\//,
  /^conversations\//,
  /^guides\/room-agent-guide\.ts$/,
];

/** A file elsewhere that imports the room-voice rule says by that import that its text reaches a room. */
const IMPORTS_THE_RULE = /from '(?:\.\.\/support|\.)\/room-voice\.js'/;

/** A name or a code is not a sentence: an act (`support.record`), a door (`master-posts`), an error code. */
const NAMES =
  /forge-ops|support\.[a-z_]+|master-(?:posts?|asks?|tells?)\w*|forge_\w+|[A-Z][A-Z0-9]+_[A-Z0-9_]+/g;

export interface Allowed {
  /** The file (relative to `src/`) the entry covers, or any file where absent. */
  file?: string;
  /** The words it covers, removed before the rule reads the literal; the whole file where absent. */
  phrase?: string;
  /** Why saying it is no relay of whose hand did the work. */
  reason: string;
}

export const ALLOWED: readonly Allowed[] = [
  {
    phrase: 'never name a master, a team or a hand-off',
    reason: 'the rule itself, taught to the agent; it is an instruction, never a sentence to say',
  },
  {
    file: 'support/prompt.ts',
    phrase: 'team member',
    reason:
      "a person's role in the channel record (owner, team member, user), not a hand-off to anyone",
  },
  {
    file: 'support/screen.ts',
    phrase: 'team member',
    reason:
      "a person's role in the channel record (owner, team member, user), not a hand-off to anyone",
  },
  {
    file: 'support/room-cards.ts',
    phrase: 'team member',
    reason:
      "a person's role in the channel record (owner, team member, user), not a hand-off to anyone",
  },
  {
    file: 'guides/room-agent-guide.ts',
    phrase: 'nor "the AdminHub side"',
    reason: 'the rule as the guide teaches it, naming the phrase the agent must not say',
  },
  {
    file: 'guides/room-agent-guide.ts',
    phrase: 'the AdminHub side is fixing it',
    reason: 'a sentence the guide quotes to teach the agent never to say it',
  },
  {
    file: 'support/room-cards.ts',
    phrase: 'the AdminHub side’s check',
    reason: 'a card quoting the sentence a room once heard, to teach against it',
  },
  {
    file: 'support/master-post.ts',
    reason: 'the master-posts door: its refusals are read by the master that posts, never relayed',
  },
  {
    file: 'support/master-post-edit.ts',
    reason: 'the master-posts edit door: its refusals are read by the master that edits its post',
  },
  {
    file: 'support/post-edit-door.ts',
    reason: 'the card and schema of the master-posts edit door, read by the master that calls it',
  },
  {
    file: 'support/rest-cards.ts',
    reason:
      'the cards of the REST doors a master calls; they teach the master, a room never reads them',
  },
  {
    file: 'support/screen.ts',
    phrase: "a master's post is never the team's own report there",
    reason:
      "the master-posts door's refusal for a room its product's people read, read by the master",
  },
  {
    file: 'support/audit-tool.ts',
    reason: 'the audit door masters and builder runs write their audit with; never reaches a room',
  },
];

export interface Hit {
  file: string;
  line: number;
  text: string;
}

const inScope = (file: string, source: string): boolean =>
  SCOPE.some((re) => re.test(file)) || IMPORTS_THE_RULE.test(source);

const isProduction = (file: string): boolean =>
  /\.tsx?$/.test(file) && !/\.(?:test|fixture)\.tsx?$|\.d\.ts$/.test(file);

/** Every `.ts` file under `dir`, relative to it with `/` separators. */
export function sourceFilesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.filter(isProduction).sort();
}

const loggedOrImported = (node: ts.Node): boolean => {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  for (let a: ts.Node | undefined = parent; a && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isCallExpression(a) && /^(?:logger|log)\./.test(a.expression.getText())) return true;
  }
  return false;
};

/** Each string or template literal of `source` that names the hand, before the allowed list is applied. */
export function literalsNaming(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((s) => s.literal.text).join('\u0000');
    }
    if (text === null) {
      ts.forEachChild(node, visit);
      return;
    }
    // a template's `${...}` holds literals of its own (a refusal inside a call), read too
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) visit(span.expression);
    }
    // a sentence has a space; one word is a name, a role or a code
    if (
      /\s/.test(text.trim()) &&
      !loggedOrImported(node) &&
      NAMES_THE_HAND.test(text.replace(NAMES, ''))
    ) {
      hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
  };
  visit(sf);
  return hits;
}

/** What is left of a hit once the allowed words of its file are taken out. */
export function stillNames(hit: Hit): boolean {
  let text = hit.text.replace(NAMES, '');
  for (const a of ALLOWED) {
    if (a.file && a.file !== hit.file) continue;
    if (!a.phrase) return false;
    text = text.split(a.phrase).join('');
  }
  return NAMES_THE_HAND.test(text);
}

/** Every literal in scope under `srcDir` that names the hand, allowed or not. */
export function scanSrc(srcDir: string): Hit[] {
  return sourceFilesOf(srcDir).flatMap((file) => {
    const source = readFileSync(join(srcDir, file), 'utf8');
    return inScope(file, source) ? literalsNaming(file, source) : [];
  });
}

/**
 * Said-keys no room read renders, by the first segment of the key: the page text of these keys is
 * read by masters, operators and the web screens, never handed to a room agent. Everything else
 * that names an internal role has the room's own wording in `ROOM_SAID`.
 */
export const NOT_ROOM_SAID: Readonly<Record<string, string>> = {
  'standing.who':
    "an actor's name: a room reads it only through roomWho, which says no person for an internal hand",
  masters: "the masters' own passes, verdicts and refusals, read by masters and their screens",
  runs: 'a run page: runs, slots and holds, read by operators and masters',
  overview: "the project overview's slots and holds, a web screen",
  workflows: "a workflow's own rules, read in the design screens",
  designs: "a design revision's own wait, read in the design screens",
  integrations: "an integration's health line, read by an admin",
  requirements: "a requirement's own rules, read in the requirement screens",
};

/** Every said-key of `source` (the registry's text) whose English names an internal role, with its text. */
export function saidKeysNaming(source: string): { key: string; text: string }[] {
  const re = /\t"([^"]+)": \{\s*en:\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  const out: { key: string; text: string }[] = [];
  for (const m of source.matchAll(re)) {
    const text = (m[2] ?? m[3] ?? '').replace(/\{[^}]*\}/g, '');
    if (NAMES_THE_HAND.test(text) || /\brelease run\b/i.test(text)) {
      out.push({ key: m[1] as string, text: m[2] ?? m[3] ?? '' });
    }
  }
  return out;
}

/** Whether a key is one no room read renders. */
export const notRoomSaid = (key: string): boolean =>
  Object.keys(NOT_ROOM_SAID).some((group) => key.startsWith(`${group}.`));
