/**
 * ISS-1229 r44, judge-124: a tool's output carried a token-looking URL to every reader of a room, because
 * the screen read only prose. One predicate now reads every string a block holds, a JSON key and value and
 * a string inside JSON among them, and the screen applies it to every string whatever holds it.
 */
import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../lib/agent-stream-parser.js';
import { readsAsCredential, screened, screenedBlocks, screenedText } from './credential-screen.js';
import { NO_REDACTED_SECRET } from './text-rules.js';

const SECRET = 'Zq8VtR2mK9xLp4Wd';

const asJson = (value: unknown) => JSON.stringify(value);
const stdoutOf = (value: unknown) =>
  asJson({ exitCode: 0, stdout: JSON.stringify(value, null, 2) });

describe('readsAsCredential — the one predicate', () => {
  it.each([
    ['a quoted JSON key and its value', asJson({ password: SECRET })],
    ['a quoted key with a space before its value', `{"accessToken": "${SECRET}"}`],
    ['an escaped quoted key inside a JSON string', stdoutOf({ token: SECRET })],
    ['a secret header as a JSON key', asJson({ Authorization: `Bearer ${SECRET}` })],
    [
      'an environment line inside a JSON string',
      stdoutOf({ description: `a\nDB_PASSWORD=${SECRET}\nb` }),
    ],
    [
      'a token URL inside a JSON string',
      stdoutOf({ description: `see https://x.test/cb?token=${SECRET}` }),
    ],
    ['a JSON array of strings', asJson(['ok', `export GH_TOKEN=${SECRET}`])],
  ])('reads %s as a credential', (_what, text) => {
    expect(readsAsCredential(text)).toBe(true);
    expect(NO_REDACTED_SECRET.check(text, {} as never)).not.toEqual([]);
  });

  it.each([
    ['a key that only starts like one', asJson({ tokens: 5, tokenizer: 'words' })],
    ['an empty password', asJson({ password: '' })],
    [
      'an issue read with no secret',
      stdoutOf({ issueId: 'ISS-2', title: 'Build link for the nightly run' }),
    ],
    ['prose that is not JSON', '{this} is not JSON, and password reset is on the login page.'],
    ['a number', '42'],
  ])('reads %s as none', (_what, text) => {
    expect(readsAsCredential(text)).toBe(false);
  });
});

describe('screenedText', () => {
  it('leaves a string holding no credential as it is', () => {
    const text = stdoutOf({ issueId: 'ISS-2', title: 'Nightly run' });
    expect(screenedText(text)).toBe(text);
  });

  it('scrubs a credential the scrubber can cut out, keeping the rest', () => {
    const shown = screenedText(`The deploy password: ${SECRET} is in the vault.`);
    expect(shown).toBe('The deploy password: [Filtered] is in the vault.');
  });

  it('withholds the whole string where the scrub cannot reach the credential', () => {
    const text = stdoutOf({ description: `a\nDB_PASSWORD=${SECRET}\nb` });
    expect(screenedText(text)).toBe('[Filtered]');
  });

  // ISS-1229 r45, judge-129: a project read's tool output showed `"testCredentials": [Filtered]`.
  it('shows a project read with no test credentials as it is', () => {
    const text = stdoutOf({ id: 'p1', name: 'Desk', testCredentials: [] });
    expect(screenedText(text)).toBe(text);
  });

  it('keeps a scrubbed project read valid JSON, its credentials replaced whole', () => {
    const read = { id: 'p1', testCredentials: [{ label: 'qa', password: SECRET }], slug: 'desk' };
    const shown = JSON.parse(screenedText(stdoutOf(read))) as { stdout: string };
    expect(JSON.parse(shown.stdout)).toEqual({ ...read, testCredentials: '[Filtered]' });
  });
});

describe('screened and screenedBlocks', () => {
  it('screens every string at any depth, keeps the keys, and leaves the input as it was', () => {
    const input = { argv: ['issue', 'ISS-2'], body: { note: `password: ${SECRET}` }, n: 3 };
    const out = screened(input);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(Object.keys(out.body)).toEqual(['note']);
    expect(out.n).toBe(3);
    expect(input.body.note).toContain(SECRET);
  });

  it('withholds a value its own key names a secret, keeping the key and every other value', () => {
    const input = {
      password: SECRET,
      pin: 'kept',
      auth: { api_key: SECRET, region: 'eu' },
      token: 4821,
    };
    const out = screened(input);
    expect(out).toEqual({
      password: '[Filtered]',
      pin: 'kept',
      auth: { api_key: '[Filtered]', region: 'eu' },
      token: '[Filtered]',
    });
  });

  it('keeps an empty value under a secret-named key, and a key that only contains the word', () => {
    const input = { password: '', max_tokens: 1000, tokens: 'many' };
    expect(screened(input)).toEqual(input);
  });

  it('screens a tool call input and output as it screens prose', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Reading it.' },
      {
        type: 'tool',
        toolCall: {
          id: 't1',
          name: 'forge',
          input: { argv: ['issue', 'ISS-2'], link: `https://x.test/cb?token=${SECRET}` },
          output: stdoutOf({ description: `https://x.test/cb?token=${SECRET}` }),
        },
      },
      { type: 'todos', todos: [{ content: `export API_KEY=${SECRET}`, status: 'pending' }] },
    ];
    const out = screenedBlocks(blocks);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.map((b) => b.type)).toEqual(['text', 'tool', 'todos']);
    expect(JSON.stringify(blocks)).toContain(SECRET);
  });
});
