// ISS-594: a cli contract is read as its commands and their flags, refused by the first thing wrong
// with it, and measured by what a script calling the program would feel.

import { describe, expect, it } from 'vitest';
import { cliElements, diffCli, readCli } from './cli-diff.js';
import { classify } from './diff.js';

const V1 = {
  program: 'forge',
  commands: [
    { name: 'feedback', description: 'File feedback.', options: ['--kind'] },
    { name: 'record verdict', options: ['--criterion', '-n'] },
  ],
};

const doc = (d: unknown) => {
  const r = readCli(d);
  if (!r.ok) throw new Error(r.fault);
  return r.value;
};

describe('reading a cli artifact', () => {
  it('indexes each command as <program> <command> and each flag as its part', () => {
    expect(cliElements(V1)).toEqual([
      'forge feedback',
      'forge feedback/options/--kind',
      'forge record verdict',
      'forge record verdict/options/--criterion',
      'forge record verdict/options/-n',
    ]);
  });

  it.each([
    [[], 'not a JSON object'],
    [{ commands: [] }, 'program is undefined'],
    [{ program: 'my tool', commands: [] }, 'program is "my tool"'],
    [{ program: 'forge' }, 'commands is not a list'],
    [{ program: 'forge', commands: ['feedback'] }, 'commands[0] is not an object'],
    [{ program: 'forge', commands: [{ name: '' }] }, 'commands[0].name is ""'],
    [{ program: 'forge', commands: [{ name: ' issue' }] }, 'commands[0].name'],
    [{ program: 'forge', commands: [{ name: 'a/b' }] }, 'commands[0].name is "a/b"'],
    [{ program: 'forge', commands: [{ name: 'x', description: 1 }] }, 'description is not'],
    [{ program: 'forge', commands: [{ name: 'x', options: '--a' }] }, 'options is not a list'],
    [{ program: 'forge', commands: [{ name: 'x', options: ['kind'] }] }, 'options[0] is "kind"'],
    [{ program: 'forge', commands: [{ name: 'x', options: ['-a', '-a'] }] }, 'lists -a twice'],
    [{ program: 'forge', commands: [{ name: 'x' }, { name: 'x' }] }, 'lists "x" twice'],
  ])('refuses %j, naming %s', (d, fault) => {
    const r = readCli(d);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fault).toContain(fault);
  });

  it('reads a program with no commands as serving none', () => {
    expect(cliElements({ program: 'jq', commands: [] })).toEqual([]);
  });
});

describe('measuring a cli change', () => {
  it('a removed command and a removed flag are breaking', () => {
    const next = { program: 'forge', commands: [{ name: 'feedback', description: 'File feedback.' }] };
    const changes = diffCli(doc(V1), doc(next));
    expect(changes.map((c) => [c.element, c.level, c.check])).toEqual([
      ['forge feedback/options/--kind', 'breaking', 'option-removed'],
      ['forge record verdict', 'breaking', 'command-removed'],
    ]);
    expect(classify(changes)).toBe('breaking');
  });

  it('an added command, an added flag and a new description are not', () => {
    const next = {
      program: 'forge',
      commands: [
        { name: 'feedback', description: 'File product feedback.', options: ['--kind', '--to'] },
        { name: 'record verdict', options: ['--criterion', '-n'] },
        { name: 'issue' },
      ],
    };
    const changes = diffCli(doc(V1), doc(next));
    expect(changes.map((c) => c.check)).toEqual([
      'command-description-changed',
      'option-added',
      'command-added',
    ]);
    expect(classify(changes)).toBe('non-breaking');
  });

  it('a renamed program removes every command a caller typed', () => {
    const changes = diffCli(doc(V1), doc({ ...V1, program: 'forge2' }));
    expect(classify(changes)).toBe('breaking');
    expect(changes.filter((c) => c.check === 'command-removed')).toHaveLength(2);
  });
});
