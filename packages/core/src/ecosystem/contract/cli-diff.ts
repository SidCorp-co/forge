/**
 * A `cli` contract (ISS-594): the commands a command-line program serves, so a report about one can
 * name it the way it names a route or a tool. The artifact is JSON —
 * `{ program, commands: [{ name, description?, options? }] }` — where a command's `name` is the words
 * after the program (`record verdict`) and `options` its flags (`--criterion`). Each command is the
 * element `<program> <name>`, the words a person types; each option the element
 * `<program> <name>/options/<flag>`, a part of its command as an mcp tool's input property is.
 */

import type { MeasuredChange } from './diff.js';

export const CLI_RULES_VERSION = 'forge-cli-1';

export const CLI_SHAPE =
  'a cli artifact is { program, commands: [{ name, description?, options?: ["--flag"] }] }';

const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_COMMANDS = 2000;

interface CliCommand {
  name: string;
  description?: string;
  options: string[];
}

export interface CliDocument {
  program: string;
  commands: Map<string, CliCommand>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

type Read = { ok: true; value: CliDocument } | { ok: false; fault: string };
type Field = { ok: true; value: CliCommand } | { ok: false; fault: string };

const isCommandName = (name: string) => name.split(' ').every((w) => WORD.test(w));

function commandAt(c: unknown, at: string): Field {
  if (!isObject(c)) return { ok: false, fault: `${at} is not an object` };
  const { name, description, options = [] } = c;
  if (typeof name !== 'string' || !isCommandName(name)) {
    return {
      ok: false,
      fault: `${at}.name is ${JSON.stringify(name)}; a command is one or more words split by single spaces, each a letter or digit then letters, digits, . _ : or -`,
    };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { ok: false, fault: `${at}.description is not a string` };
  }
  if (!Array.isArray(options)) return { ok: false, fault: `${at}.options is not a list` };
  const bad = options.findIndex((o) => typeof o !== 'string' || !FLAG.test(o));
  if (bad >= 0) {
    return {
      ok: false,
      fault: `${at}.options[${bad}] is ${JSON.stringify(options[bad])}; an option is a flag as typed, -x or --name`,
    };
  }
  const repeated = options.find((o, i) => options.indexOf(o) !== i);
  if (repeated !== undefined) return { ok: false, fault: `${at}.options lists ${repeated} twice` };
  return {
    ok: true,
    value: { name, options, ...(description === undefined ? {} : { description }) },
  };
}

/** The document, or the first thing wrong with it, named by where it sits. */
export function readCli(doc: unknown): Read {
  if (!isObject(doc)) return { ok: false, fault: 'the artifact is not a JSON object' };
  if (typeof doc.program !== 'string' || !PROGRAM.test(doc.program)) {
    return {
      ok: false,
      fault: `program is ${JSON.stringify(doc.program)}; it is the executable's name, a letter or digit then letters, digits, . _ or -`,
    };
  }
  if (!Array.isArray(doc.commands)) return { ok: false, fault: 'commands is not a list' };
  if (doc.commands.length > MAX_COMMANDS) {
    return { ok: false, fault: `commands lists over ${MAX_COMMANDS} commands` };
  }
  const commands = new Map<string, CliCommand>();
  for (const [i, c] of doc.commands.entries()) {
    const read = commandAt(c, `commands[${i}]`);
    if (!read.ok) return read;
    if (commands.has(read.value.name)) {
      return { ok: false, fault: `commands lists "${read.value.name}" twice` };
    }
    commands.set(read.value.name, read.value);
  }
  return { ok: true, value: { program: doc.program, commands } };
}

export const commandElement = (program: string, name: string) => `${program} ${name}`;
const optionElement = (command: string, flag: string) => `${command}/options/${flag}`;

/** Every element of a read document: each command, then each of its options. */
export function cliElements(doc: unknown): string[] {
  const read = readCli(doc);
  if (!read.ok) return [];
  const { program, commands } = read.value;
  return [...commands.values()].flatMap((c) => {
    const command = commandElement(program, c.name);
    return [command, ...c.options.map((o) => optionElement(command, o))];
  });
}

const removed = (element: string, text: string, check: string): MeasuredChange => ({
  element,
  kind: 'removed',
  level: 'breaking',
  text,
  check,
});

const added = (element: string, text: string, check: string): MeasuredChange => ({
  element,
  kind: 'added',
  level: 'info',
  text,
  check,
});

// a caller scripts a command and its flags: one gone fails that script, one added fails none. A
// renamed program is every command removed and every command added, which is what it is to a caller.
export function diffCli(o: CliDocument, n: CliDocument): MeasuredChange[] {
  const index = (d: CliDocument) =>
    new Map([...d.commands.values()].map((c) => [commandElement(d.program, c.name), c]));
  const [before, after] = [index(o), index(n)];
  const out: MeasuredChange[] = [];
  for (const [command, c] of before) {
    const next = after.get(command);
    if (!next) {
      out.push(removed(command, `command ${command} was removed`, 'command-removed'));
      continue;
    }
    if (c.description !== next.description) {
      out.push({
        element: command,
        kind: 'changed',
        level: 'info',
        text: 'the description changed',
        check: 'command-description-changed',
      });
    }
    for (const flag of c.options.filter((f) => !next.options.includes(f))) {
      out.push(
        removed(optionElement(command, flag), `option ${flag} was removed`, 'option-removed'),
      );
    }
    for (const flag of next.options.filter((f) => !c.options.includes(f))) {
      out.push(added(optionElement(command, flag), `option ${flag} was added`, 'option-added'));
    }
  }
  for (const command of after.keys()) {
    if (!before.has(command)) {
      out.push(added(command, `command ${command} was added`, 'command-added'));
    }
  }
  return out;
}
