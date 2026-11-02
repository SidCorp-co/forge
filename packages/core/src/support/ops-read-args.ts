// A declared read's arguments, checked whole before anything runs (ISS-871): what each parameter
// takes, and the argv the box runs once every argument fits. Pure, so the kernel rule is tested alone.

import type { SupportRead, SupportReadParam } from '@forge/contracts/support';
import { no, type Outcome } from './outcome.js';

export type ReadArgs = Record<string, string | number>;

/** Whether a value holds a control character, a new line among them. */
const hasControl = (v: string) =>
  [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** What a parameter takes, as a refusal and the brief say it. */
export function paramTakes(p: SupportReadParam): string {
  const what = p.enum ? `one of ${p.enum.join(' | ')}` : `a value matching ${p.pattern}`;
  return `${what}, at most ${p.maxLength} characters`;
}

const argsRefused = (path: string, detail: string): Outcome<never> =>
  no('SUPPORT_READ_ARGS', path, `${detail}; nothing ran`);

/**
 * The argv a declared read runs with these arguments: its fixed argv, then each parameter given, in
 * the order the grant declares them, as `flag value` or a positional value. Refused by name for an
 * unknown parameter, a missing required one, and a value outside its parameter's pattern, enum or
 * length, or one that could read as an option or holds a control character.
 */
export function readArgv(read: SupportRead, args: ReadArgs): Outcome<string[]> {
  const params = read.params ?? [];
  const names = params.map((p) => p.name);
  const unknown = Object.keys(args).filter((k) => !names.includes(k));
  if (unknown.length > 0) {
    return argsRefused(
      `/args/${unknown[0]}`,
      `${read.name} takes no parameter ${unknown.join(', ')}; it takes ${names.join(', ') || 'none'}`,
    );
  }
  const argv = [...read.argv];
  for (const p of params) {
    const given = args[p.name];
    if (given === undefined) {
      if (p.required) {
        return argsRefused(`/args/${p.name}`, `${read.name} needs ${p.name}: ${paramTakes(p)}`);
      }
      continue;
    }
    const value = String(given);
    const at = `/args/${p.name}`;
    if (value.length === 0 || value.length > p.maxLength) {
      return argsRefused(
        at,
        `${p.name} is ${value.length} characters; it takes 1 to ${p.maxLength}`,
      );
    }
    if (hasControl(value)) {
      return argsRefused(at, `${p.name} holds a control character or a new line`);
    }
    if (value.startsWith('-')) {
      return argsRefused(at, `${p.name} starts with -, which the program could read as an option`);
    }
    const fits = p.enum ? p.enum.includes(value) : new RegExp(`^(?:${p.pattern})$`).test(value);
    if (!fits) return argsRefused(at, `${p.name} ${JSON.stringify(value)} is not ${paramTakes(p)}`);
    if (p.flag) argv.push(p.flag);
    argv.push(value);
  }
  return { ok: true, value: argv };
}
