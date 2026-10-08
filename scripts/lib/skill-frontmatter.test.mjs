import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESCRIPTION_LIMIT,
  NAME_LIMIT,
  parseFrontmatter,
  skillFaults,
} from './skill-frontmatter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = resolve(HERE, '..', 'check-skill-frontmatter.mjs');

const skill = (name, description) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# Body\n`;
const fieldsOf = (faults) => faults.map((f) => f.field);

describe('a skill an installer offers', () => {
  it('passes when name matches its directory and the description is plain text in range', () => {
    expect(
      skillFaults(
        skill('forge-master', 'Act as the master. Use when a pass is nudged.'),
        'forge-master',
      ),
    ).toEqual([]);
  });

  it('passes a description folded over several lines and counts it as the installer does', () => {
    const raw = '---\nname: a\ndescription: >-\n  one two\n  three\n\n  four\n---\n';
    expect(parseFrontmatter(raw).fields.get('description').value).toBe('one two three\nfour');
    expect(skillFaults(raw, 'a')).toEqual([]);
  });

  it('passes quoted values and a literal block, and skips the keys it does not judge', () => {
    const raw =
      "---\nname: \"a-b\"\ndescription: 'it''s fine: really'\nallowed-tools:\n  - Read\n  - Bash\nlicense: MIT\n---\n";
    expect(parseFrontmatter(raw).fields.get('description').value).toBe("it's fine: really");
    expect(skillFaults(raw, 'a-b')).toEqual([]);
  });
});

describe('a skill an installer drops whole is refused by name', () => {
  it('no frontmatter, or one never closed, names the missing fence', () => {
    for (const raw of ['# just a body\n', '---\nname: a\ndescription: b\n']) {
      const faults = skillFaults(raw, 'a');
      expect(fieldsOf(faults)).toEqual(['frontmatter']);
      expect(faults[0].rule).toMatch(/`---`/);
    }
  });

  it('a line that is not `key: value` names the line', () => {
    const [f] = skillFaults('---\nname: a\nthis is prose\ndescription: b\n---\n', 'a');
    expect(f).toMatchObject({ field: 'frontmatter', measured: 'line 3' });
  });

  it('an absent name or description says which', () => {
    expect(skillFaults('---\ndescription: b\n---\n', 'a')).toEqual([
      { field: 'name', rule: 'is absent', measured: 'no such key', limit: 'required' },
    ]);
    expect(fieldsOf(skillFaults('---\nname: a\n---\n', 'a'))).toEqual(['description']);
  });

  it('an empty name or description is refused as empty, however it is written', () => {
    for (const empty of ['', '""', "''", '>-\n  ']) {
      const raw = `---\nname: a\ndescription: ${empty}\n---\n`;
      expect(
        skillFaults(raw, 'a').map((f) => f.rule),
        JSON.stringify(empty),
      ).toEqual(['is empty']);
    }
  });

  it('a name over the limit reports the measured length and the limit, and a name at it passes', () => {
    const at = 'a'.repeat(NAME_LIMIT);
    expect(skillFaults(skill(at, 'd'), at)).toEqual([]);
    const over = 'a'.repeat(NAME_LIMIT + 1);
    expect(skillFaults(skill(over, 'd'), over)).toEqual([
      {
        field: 'name',
        rule: 'is too long',
        measured: `${NAME_LIMIT + 1} characters`,
        limit: 'at most 64',
      },
    ]);
  });

  it('a name outside [a-z0-9-] lists the characters, and hyphens at an edge or doubled are refused', () => {
    const [f] = skillFaults(skill('Forge_Master', 'd'), 'Forge_Master');
    expect(f).toMatchObject({ field: 'name', measured: '"F" "_" "M"', limit: '[a-z0-9-]' });
    expect(skillFaults(skill('a--b', 'd'), 'a--b')[0].rule).toMatch(/hyphen/);
    expect(skillFaults(skill('-a', 'd'), '-a')[0].rule).toMatch(/hyphen/);
  });

  it('a name that is not its directory names both', () => {
    expect(skillFaults(skill('forge-master', 'd'), 'master')).toEqual([
      {
        field: 'name',
        rule: 'differs from the directory the skill sits in',
        measured: '"forge-master"',
        limit: 'the directory name `master`',
      },
    ]);
  });

  it('a description over 1024 characters reports the measure, and one at 1024 passes', () => {
    expect(skillFaults(skill('a', 'x'.repeat(DESCRIPTION_LIMIT)), 'a')).toEqual([]);
    expect(skillFaults(skill('a', 'x'.repeat(DESCRIPTION_LIMIT + 1)), 'a')).toEqual([
      {
        field: 'description',
        rule: 'is too long',
        measured: '1025 characters',
        limit: 'at most 1024',
      },
    ]);
  });

  it('measures a folded description after folding, not by the lines the file spends on it', () => {
    const folded = `---\nname: a\ndescription: >-\n${'  xxxxxxxxxx\n'.repeat(120)}---\n`;
    const [f] = skillFaults(folded, 'a');
    expect(f.measured).toBe(`${120 * 10 + 119} characters`);
  });

  it('an angle-bracket placeholder in a description is refused with the placeholder', () => {
    const [f] = skillFaults(skill('a', "'Use for <your-project> or <b>bold</b>'"), 'a');
    expect(f).toMatchObject({ field: 'description', measured: '<your-project> <b> </b>' });
    expect(skillFaults(skill('a', "'a < b and c > d'"), 'a')).toEqual([]);
  });

  it('a plain value YAML reads as structure is refused, where a quoted one passes', () => {
    for (const bad of [
      'Use when: a pass is nudged',
      'Use it # not a comment',
      '[a, b]',
      '*star',
      '@at',
    ]) {
      const faults = skillFaults(skill('a', bad), 'a');
      expect(faults, bad).toHaveLength(1);
      expect(faults[0].field, bad).toBe('description');
      expect(faults[0].limit, bad).toBe('a string an installer can read');
    }
    expect(skillFaults(skill('a', '"Use when: a pass is nudged"'), 'a')).toEqual([]);
  });

  it('a description written as a list or mapping is not a string', () => {
    const [f] = skillFaults('---\nname: a\ndescription:\n  - one\n---\n', 'a');
    expect(f).toMatchObject({ field: 'description' });
    expect(f.rule).toMatch(/list or a mapping/);
  });

  it('a key declared twice is refused naming both lines', () => {
    const [f] = skillFaults('---\nname: a\nname: b\ndescription: d\n---\n', 'a');
    expect(f.rule).toMatch(/declared twice, on lines 2 and 3/);
  });

  it('a character no YAML stream may carry is named by code point', () => {
    const [f] = skillFaults(skill('a', '"bell\\u0007 here"'), 'a');
    expect(f).toMatchObject({ field: 'description', measured: 'U+0007' });
  });

  it('reads CRLF and a byte-order mark as the same file', () => {
    const raw = `﻿${skill('a', 'plain text')}`.replace(/\n/g, '\r\n');
    expect(skillFaults(raw, 'a')).toEqual([]);
  });
});

describe('the checker, on a tree it is pointed at', () => {
  const made = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tree(files) {
    const root = mkdtempSync(join(tmpdir(), 'skill-frontmatter-'));
    made.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }
  const run = (root) => spawnSync('node', [CHECKER, '--root', root], { encoding: 'utf8' });

  it('counts the skills it read and exits 0 when each is offered', () => {
    const r = run(tree({ 'one/SKILL.md': skill('one', 'd'), 'two/SKILL.md': skill('two', 'd') }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^skill-frontmatter: 2 skill\(s\) scanned$/m);
  });

  it('exits 1 naming the file, the field, the measured value and the limit, and changes nothing', () => {
    const long = 'x'.repeat(DESCRIPTION_LIMIT + 7);
    const root = tree({ 'one/SKILL.md': skill('one', long) });
    const before = readFileSync(join(root, 'one/SKILL.md'), 'utf8');
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('one/SKILL.md  description  is too long');
    expect(r.stderr).toContain('measured: 1031 characters    limit: at most 1024');
    expect(readFileSync(join(root, 'one/SKILL.md'), 'utf8')).toBe(before);
  });

  it('refuses a skill directory with no SKILL.md rather than skipping it', () => {
    const r = run(tree({ 'one/SKILL.md': skill('one', 'd'), 'two/notes.md': 'x' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('two/SKILL.md  file');
  });

  it('exits 2 when there is nothing to read, never passing over an empty root', () => {
    const r = run(tree({ 'loose-file.md': 'x' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no skill directory/);
  });

  it('exits 2 for a root that does not exist', () => {
    const r = run(join(tmpdir(), 'skill-frontmatter-no-such-root'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not exist/);
  });
});
