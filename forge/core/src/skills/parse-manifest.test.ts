import { describe, expect, it } from 'vitest';
import { parseManifest } from './parse-manifest.js';

describe('parseManifest', () => {
  it('parses basic key-value frontmatter', () => {
    const { frontmatter, body } = parseManifest(
      '---\nname: forge-triage\ndescription: "triage skill"\n---\n# body\n',
    );
    expect(frontmatter.name).toBe('forge-triage');
    expect(frontmatter.description).toBe('triage skill');
    expect(body.trim()).toBe('# body');
  });

  it('parses booleans', () => {
    const { frontmatter } = parseManifest(
      '---\nname: x\ndescription: y\nuser_invocable: true\n---\nbody',
    );
    expect(frontmatter.user_invocable).toBe(true);
  });

  it('parses inline arrays', () => {
    const { frontmatter } = parseManifest(
      '---\nname: x\ndescription: y\ntools: [Read, Bash, "Edit"]\n---\nbody',
    );
    expect(frontmatter.tools).toEqual(['Read', 'Bash', 'Edit']);
  });

  it('accepts CRLF line endings', () => {
    const { frontmatter, body } = parseManifest(
      '---\r\nname: x\r\ndescription: y\r\n---\r\nhi\r\n',
    );
    expect(frontmatter.name).toBe('x');
    expect(body).toMatch(/hi/);
  });

  it('throws on missing frontmatter', () => {
    expect(() => parseManifest('no frontmatter here')).toThrow(/frontmatter/);
  });

  it('throws on unterminated frontmatter', () => {
    expect(() => parseManifest('---\nname: x\ndescription: y\n')).toThrow(/frontmatter/);
  });
});
