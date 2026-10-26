// ISS-1229 r45, judge-129: a room's Technical details showed broken JSON where the scrubber had
// replaced a secret inside JSON quoted in JSON, cutting the escaped closing quote with the value; and an
// empty `"testCredentials": []` read as `[Filtered]`, as if nothing were something secret.

import { FILTERED, scrubBodyKeys, scrubLogText } from '@forge/observability';
import { describe, expect, it } from 'vitest';

/** `value` as JSON quoted `depth` times, the way a tool output nests it in a string. */
const quoted = (value: unknown, depth: number): string => {
  let text = JSON.stringify(value);
  for (let i = 0; i < depth; i++) text = JSON.stringify({ detail: text });
  return text;
};

const unquoted = (text: string, depth: number): unknown => {
  let value: unknown = JSON.parse(text);
  for (let i = 0; i < depth; i++) value = JSON.parse((value as { detail: string }).detail);
  return value;
};

describe('a secret scrubbed out of JSON', () => {
  const cases: Array<[string, unknown, unknown]> = [
    ['a quoted value', { password: 'hunter2', user: 'ana' }, { password: FILTERED, user: 'ana' }],
    ['a value of two words', { password: 'two words', n: 1 }, { password: FILTERED, n: 1 }],
    [
      'a value holding a quote and a backslash',
      { token: 'ab"c\\d', after: 'kept' },
      { token: FILTERED, after: 'kept' },
    ],
    ['a number', { apiKey: 123456, n: 2 }, { apiKey: FILTERED, n: 2 }],
    [
      'an array of credentials',
      { testCredentials: [{ label: 'qa', username: 'u', password: 'p' }], next: 2 },
      { testCredentials: FILTERED, next: 2 },
    ],
    ['a header value', { authorization: 'Bearer abc', x: 1 }, { authorization: FILTERED, x: 1 }],
    [
      'an array whose strings hold brackets',
      { testCredentials: [']hunter2', '{[x'], next: 2 },
      { testCredentials: FILTERED, next: 2 },
    ],
    [
      'an object whose strings hold brackets and quotes',
      { secret: { a: '}"]', b: ['[{'] }, next: 2 },
      { secret: FILTERED, next: 2 },
    ],
  ];

  for (const depth of [0, 1, 2]) {
    for (const [what, value, expected] of cases) {
      it(`leaves valid JSON of the same shape: ${what}, quoted ${depth} deep`, () => {
        const out = scrubLogText(quoted(value, depth));
        expect(unquoted(out, depth)).toEqual(expected);
      });
    }
  }

  it('leaves pretty-printed JSON valid where an array of credentials spans lines', () => {
    const value = { name: 'Desk', testCredentials: [{ label: 'qa', password: 'p' }], slug: 'desk' };
    const out = scrubLogText(JSON.stringify(value, null, 2));
    expect(JSON.parse(out)).toEqual({ name: 'Desk', testCredentials: FILTERED, slug: 'desk' });
  });
});

describe('an empty value under a secret name', () => {
  for (const value of [
    { testCredentials: [] },
    { testCredentials: {} },
    { password: '' },
    { token: null },
  ]) {
    it(`is left as it is: ${JSON.stringify(value)}`, () => {
      for (const depth of [0, 1]) {
        expect(scrubLogText(quoted(value, depth))).toBe(quoted(value, depth));
      }
    });
  }

  it('is left as it is in a pretty-printed project read', () => {
    const read = JSON.stringify({ id: 'p1', name: 'Desk', testCredentials: [] }, null, 2);
    expect(scrubLogText(read)).toBe(read);
  });
});

describe('a log line, which is not JSON', () => {
  it('loses a bare secret holding or opening with a backslash whole', () => {
    expect(scrubLogText('password=abc\\def user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=\\abc user=ana')).toBe(`password=${FILTERED} user=ana`);
  });

  it('loses a bare secret that only opens like an empty value', () => {
    for (const value of [
      'null!hunter2',
      '[]hunter2',
      '{}x',
      'truex',
      'null\\hunter2',
      '[]\\hunter2',
    ]) {
      expect(scrubLogText(`password=${value} user=ana`)).toBe(`password=${FILTERED} user=ana`);
    }
  });

  it('loses a bare secret that opens with a closing bracket whole', () => {
    expect(scrubLogText('password=]hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=}x] user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=null]hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=[x]]hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=null\\n!hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('password=[]\\t!hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
  });

  it('loses a bare secret that reads like a JSON literal, which an unquoted name gives no type', () => {
    for (const value of ['true', 'false', 'null', '[]', '{}']) {
      expect(scrubLogText(`password=${value} user=ana`)).toBe(`password=${FILTERED} user=ana`);
    }
  });

  it('still loses a bare secret and keeps what follows', () => {
    expect(scrubLogText('password=hunter2 user=ana')).toBe(`password=${FILTERED} user=ana`);
    expect(scrubLogText('access_token=abc&id=7')).toBe(`access_token=${FILTERED}&id=7`);
  });

  it('still loses the rest of an unquoted header line', () => {
    expect(scrubLogText('Authorization: Bearer abc def\nnext line')).toBe(
      `Authorization: ${FILTERED}\nnext line`,
    );
  });

  it('scrubs what it already scrubbed to the same text', () => {
    const once = scrubLogText(quoted({ password: 'x', testCredentials: [{ a: 1 }] }, 1));
    expect(scrubLogText(once)).toBe(once);
  });
});

describe('a structured body', () => {
  it('keeps an empty secret field as it is and censors a filled one', () => {
    const body = { testCredentials: [], password: '', token: null, apiKey: 'k1', secret: {} };
    expect(scrubBodyKeys(body)).toBe(true);
    expect(body).toEqual({
      testCredentials: [],
      password: '',
      token: null,
      apiKey: FILTERED,
      secret: {},
    });
  });

  it('censors an empty container that serializes as something else', () => {
    const shaped = Object.assign([], { toJSON: () => 'hunter2' });
    const hidden = Object.defineProperty({}, 'toJSON', {
      value: () => 'hunter2',
      enumerable: false,
    });
    const body = { password: shaped, secret: hidden };
    scrubBodyKeys(body);
    expect(JSON.stringify(body)).toBe(`{"password":"${FILTERED}","secret":"${FILTERED}"}`);
  });

  it('reports a secret field a getter answers as not censored, without asking the getter', () => {
    let asked = 0;
    const body = {
      get password() {
        asked++;
        return '';
      },
    };
    expect(scrubBodyKeys(body)).toBe(false);
    expect(asked).toBe(0);
  });
});
