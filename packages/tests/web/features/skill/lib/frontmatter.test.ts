import { describe, expect, it } from 'vitest';
import {
  fieldsFromFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterFields,
} from '@/features/skill/lib/frontmatter';

describe('parseFrontmatter', () => {
  it('parses a standard block into frontmatter + body', () => {
    const md = `---\nname: my-skill\ndescription: Does a thing\nallowed-tools: [Read, Write]\ntarget: dev\n---\n# Heading\n\nBody text.`;
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
      'allowed-tools': ['Read', 'Write'],
      target: 'dev',
    });
    expect(body).toBe('# Heading\n\nBody text.');
  });

  it('tolerates a missing block (returns empty frontmatter, full body)', () => {
    const md = '# No frontmatter here\n\njust content';
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter).toEqual({});
    expect(body).toBe(md);
  });

  it('handles empty string', () => {
    expect(parseFrontmatter('')).toEqual({ frontmatter: {}, body: '' });
  });

  it('strips quotes and parses booleans + empty arrays', () => {
    const md = `---\nname: "quoted-name"\nenabled: true\ndisabled: false\nempty: []\n---\nbody`;
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter['name']).toBe('quoted-name');
    expect(frontmatter['enabled']).toBe(true);
    expect(frontmatter['disabled']).toBe(false);
    expect(frontmatter['empty']).toEqual([]);
  });
});

describe('serializeFrontmatter', () => {
  it('writes managed keys in stable order', () => {
    const fields: FrontmatterFields = {
      name: 'my-skill',
      description: 'Does a thing',
      allowedTools: ['Read', 'Write'],
      target: 'dev',
    };
    const out = serializeFrontmatter(fields, '# Body');
    expect(out).toBe(
      `---\nname: my-skill\ndescription: Does a thing\nallowed-tools: [Read, Write]\ntarget: dev\n---\n# Body`,
    );
  });

  it('skips empty managed values', () => {
    const fields: FrontmatterFields = {
      name: 'x',
      description: 'y',
      allowedTools: [],
      target: '',
    };
    const out = serializeFrontmatter(fields, 'body');
    expect(out).toBe(`---\nname: x\ndescription: y\n---\nbody`);
  });

  it('preserves unknown keys verbatim, after managed keys', () => {
    const fields: FrontmatterFields = {
      name: 'x',
      description: 'y',
      allowedTools: [],
      target: 'all',
    };
    const out = serializeFrontmatter(fields, 'body', {
      'custom-key': 'custom-value',
      version: '2',
    });
    expect(out).toBe(
      `---\nname: x\ndescription: y\ntarget: all\ncustom-key: custom-value\nversion: 2\n---\nbody`,
    );
  });

  it('returns the body unchanged when nothing would be written', () => {
    const fields: FrontmatterFields = { name: '', description: '', allowedTools: [], target: '' };
    expect(serializeFrontmatter(fields, '# just body')).toBe('# just body');
  });
});

describe('round-trip parse∘serialize', () => {
  it('is value-identity for managed + unknown keys', () => {
    const md = `---\nname: my-skill\ndescription: Does a thing\nallowed-tools: [Read, Write, Bash]\ntarget: cloud\nkeep-me: hello\n---\n# Heading\n\nBody.`;
    const { frontmatter, body } = parseFrontmatter(md);
    const fields = fieldsFromFrontmatter(frontmatter);
    const reserialized = serializeFrontmatter(fields, body, frontmatter);

    // Re-parsing the serialized output yields the same logical frontmatter.
    const reparsed = parseFrontmatter(reserialized);
    expect(reparsed.frontmatter).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
      'allowed-tools': ['Read', 'Write', 'Bash'],
      target: 'cloud',
      'keep-me': 'hello',
    });
    expect(reparsed.body).toBe('# Heading\n\nBody.');
  });

  it('does not drop an unknown key when the form edits a managed field', () => {
    const md = `---\nname: orig\ndescription: orig desc\nsecret-flag: true\n---\nbody`;
    const { frontmatter, body } = parseFrontmatter(md);
    const fields = fieldsFromFrontmatter(frontmatter);
    const edited: FrontmatterFields = { ...fields, description: 'new desc' };
    const out = serializeFrontmatter(edited, body, frontmatter);
    const reparsed = parseFrontmatter(out);
    expect(reparsed.frontmatter['secret-flag']).toBe(true);
    expect(reparsed.frontmatter['description']).toBe('new desc');
    expect(reparsed.frontmatter['name']).toBe('orig');
  });
});

describe('fieldsFromFrontmatter', () => {
  it('maps known keys and falls back for missing ones', () => {
    const fields = fieldsFromFrontmatter(
      { name: 'a', 'allowed-tools': ['Read'] },
      { description: 'fallback desc', target: 'dev' },
    );
    expect(fields).toEqual({
      name: 'a',
      description: 'fallback desc',
      allowedTools: ['Read'],
      target: 'dev',
    });
  });

  it('ignores an invalid target', () => {
    const fields = fieldsFromFrontmatter({ target: 'nonsense' });
    expect(fields.target).toBe('');
  });
});
