/**
 * The matching rule, the marker and the refusal, with no database: what a stored test credential
 * is taken to be, where in a text it is found, and what stands in its place.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  credentialRefusal,
  credentialsFrom,
  findCredential,
  STORED_CREDENTIAL_RULE,
  withheldMarker,
  withholdCredentials,
} from './credential-guard.js';

const LONG_USER = 'qa-user@sidcorp.test';
const LONG_PASSWORD = 'Correct-Horse-9!';

const environments = {
  preview: { url: 'https://preview.example.test' },
  testCredentials: [
    { label: 'staging admin', username: LONG_USER, password: LONG_PASSWORD },
    { label: 'viewer', username: 'viewer1', password: 'v1' },
  ],
};

const stored = credentialsFrom(environments);

/** Capital I with a dot above: its lower-case form is two code units, so a naive fold moves every offset after it. */
const DOTTED_I = '\u0130';

describe('what a project stores as test credentials', () => {
  it('reads every string of a row except its label', () => {
    expect(stored.map((one) => one.value)).toEqual([LONG_USER, LONG_PASSWORD, 'viewer1', 'v1']);
  });

  it('reads a key the schema does not name, because the row is a catchall', () => {
    const extra = credentialsFrom({
      testCredentials: [
        { label: 'api', username: 'u', password: 'p', apiToken: 'tok-0123456789abcdef' },
      ],
    });
    expect(extra.map((one) => one.value)).toContain('tok-0123456789abcdef');
  });

  it('is empty for a project that stores none, however the column is empty', () => {
    for (const raw of [
      null,
      undefined,
      {},
      { testCredentials: [] },
      { testCredentials: 'x' },
      'x',
    ]) {
      expect(credentialsFrom(raw)).toEqual([]);
    }
  });

  it('names a credential by its label, and by position where the label holds a stored value', () => {
    const named = credentialsFrom({
      testCredentials: [
        { label: 'secret-token-123456', username: 'u', password: 'secret-token-123456' },
      ],
    });
    expect(named.every((one) => one.id === 'credential #1')).toBe(true);
    expect(stored[0]?.id).toBe('staging admin');
  });
});

describe('where a stored credential is found', () => {
  it('finds a value of twelve characters or more anywhere in the text', () => {
    const hit = findCredential(`log in as ${LONG_USER} please`, stored);
    expect(hit).toMatchObject({ id: 'staging admin', line: 1, column: 11 });
  });

  it('finds it in any letter case', () => {
    expect(findCredential(`as ${LONG_USER.toUpperCase()}`, stored)).not.toBeNull();
    expect(findCredential(`as ${LONG_PASSWORD.toLowerCase()}`, stored)).not.toBeNull();
  });

  it('reports the line and the column in the text as written', () => {
    const hit = findCredential(`first line\nsecond ${LONG_PASSWORD}`, stored);
    expect(hit).toMatchObject({ line: 2, column: 8 });
  });

  it('matches a short value only where the text is that value alone', () => {
    expect(findCredential('viewer1', stored)).not.toBeNull();
    expect(findCredential('"viewer1".', stored)).not.toBeNull();
    expect(findCredential('VIEWER1', stored)).not.toBeNull();
  });

  it('matches a password made only of punctuation where it is the whole text', () => {
    const symbols = credentialsFrom({
      testCredentials: [{ label: 'sym', username: 'u', password: '!@#$%^&*' }],
    });
    expect(findCredential('!@#$%^&*', symbols)).not.toBeNull();
    expect(withholdCredentials('  !@#$%^&*  ', symbols).ids).toEqual(['sym']);
    expect(findCredential('wow !@#$%^&* ok', symbols)).toBeNull();
  });

  it('leaves a short value inside a longer word or sentence as written', () => {
    expect(findCredential('the viewer1 account', stored)).toBeNull();
    expect(findCredential('previewer1x', stored)).toBeNull();
    expect(findCredential('a v1 release of v1.2', stored)).toBeNull();
  });

  it('finds nothing in a text that carries none, and nothing in a project that stores none', () => {
    expect(findCredential('an ordinary sentence', stored)).toBeNull();
    expect(findCredential(LONG_USER, [])).toBeNull();
  });

  it('quotes the neighbourhood with every stored value masked', () => {
    const hit = findCredential(`use ${LONG_USER} then ${LONG_PASSWORD} to sign in`, stored);
    expect(hit?.near).not.toContain(LONG_USER);
    expect(hit?.near).not.toContain(LONG_PASSWORD);
    expect(hit?.near).toContain('[withheld]');
  });
});

describe('the refusal a caller meets', () => {
  it('names its rule, the position and where the value is read instead, and never the value', () => {
    const hit = findCredential(`as ${LONG_USER}`, stored);
    if (!hit) throw new Error('the credential was not found');
    const refusal = credentialRefusal(hit);
    expect(refusal.rule).toBe(STORED_CREDENTIAL_RULE);
    expect(refusal.why).toContain('staging admin');
    expect(refusal.why).toContain('line 1, column 4');
    expect(refusal.why).toContain('forge_projects.get');
    expect(refusal.why).toContain('environments.testCredentials');
    expect(JSON.stringify(refusal)).not.toContain(LONG_USER);
  });
});

describe('a refusal that must not hold a stored value either', () => {
  it('words the locator without the value where the value is part of the locator', () => {
    const wording = credentialsFrom({
      testCredentials: [{ label: 'login', username: 'u', password: 'forge_projects.get' }],
    });
    const hit = findCredential('pw forge_projects.get', wording);
    if (!hit) throw new Error('the credential was not found');
    const refusal = credentialRefusal(hit, wording);
    expect(JSON.stringify(refusal)).not.toContain('forge_projects.get');
    expect(refusal.rule).toBe(STORED_CREDENTIAL_RULE);
    expect(refusal.why).toContain('line 1, column 4');
  });
});

describe('what core writes in place of a stored credential', () => {
  it('replaces each value and keeps every other character of the text', () => {
    const { text, ids } = withholdCredentials(
      `before ${LONG_USER} middle ${LONG_PASSWORD} after`,
      stored,
    );
    expect(text).toBe(
      `before ${withheldMarker('staging admin')} middle ${withheldMarker('staging admin')} after`,
    );
    expect(ids).toEqual(['staging admin']);
  });

  it('changes nothing in a text that carries none', () => {
    const plain = 'A run ended. The viewer1 account was not used; v1 shipped.';
    expect(withholdCredentials(plain, stored)).toEqual({ text: plain, ids: [] });
  });

  it('withholds a short value that is the whole text', () => {
    const { text, ids } = withholdCredentials('viewer1', stored);
    expect(text).toBe(withheldMarker('viewer'));
    expect(ids).toEqual(['viewer']);
  });

  it('merges overlapping values into one marker rather than leaving a tail', () => {
    const overlapping = credentialsFrom({
      testCredentials: [{ label: 'a', username: 'abcdefghijkl', password: 'ghijklmnopqrstu' }],
    });
    const { text } = withholdCredentials('x abcdefghijklmnopqrstu y', overlapping);
    expect(text).not.toMatch(/mnop|qrst|abcd/);
    expect(text.startsWith('x ')).toBe(true);
    expect(text.endsWith(' y')).toBe(true);
  });

  it('never carries a value in its marker even where a label is the value', () => {
    const odd = credentialsFrom({
      testCredentials: [
        { label: 'secret-token-123456', username: 'u', password: 'secret-token-123456' },
      ],
    });
    const { text } = withholdCredentials('token secret-token-123456 here', odd);
    expect(text).not.toContain('secret-token-123456');
    expect(text).toContain('credential #1');
  });

  it('falls back to a bare marker where the marker wording itself holds a stored value', () => {
    const wording = credentialsFrom({
      testCredentials: [
        { label: 'login', username: 'u', password: 'environments.testCredentials' },
      ],
    });
    const once = withholdCredentials('pw environments.testCredentials end', wording);
    expect(once.text).toBe('pw [withheld] end');
    expect(withholdCredentials(once.text, wording).text).toBe(once.text);
  });

  it('names no credential where its label and its position both hold a stored value', () => {
    const named = credentialsFrom({
      testCredentials: [{ label: 'credential #1', username: 'u', password: 'credential #1' }],
    });
    const { text, ids } = withholdCredentials('use credential #1 now', named);
    expect(text).toBe('use [withheld] now');
    expect(ids).toEqual(['']);
  });

  it('is idempotent: withholding a withheld text changes nothing', () => {
    const once = withholdCredentials(`as ${LONG_USER} / ${LONG_PASSWORD} / viewer1`, stored);
    expect(withholdCredentials(once.text, stored)).toEqual({ text: once.text, ids: [] });
  });

  it('keeps an offset honest where a letter lower-cases to a different length', () => {
    const turkish = credentialsFrom({
      testCredentials: [{ label: 'tr', username: 'x', password: `${DOTTED_I}stanbul-Secret-1` }],
    });
    const { text } = withholdCredentials(
      `${DOTTED_I.repeat(3)} ${DOTTED_I}stanbul-Secret-1 tail`,
      turkish,
    );
    expect(text.endsWith(' tail')).toBe(true);
    expect(text.startsWith(`${DOTTED_I.repeat(3)} `)).toBe(true);
    expect(text).not.toContain('Secret');
  });
});

describe("the readers of a project's stored credentials", () => {
  const environmentsRow = {
    environments: { testCredentials: [{ label: 'a', username: 'u', password: 'p-0123456789ab' }] },
  };

  it('read the credentials the project holds, never an empty answer, whatever the unit setup stubs', async () => {
    const real =
      await vi.importActual<typeof import('./credential-guard.js')>('./credential-guard.js');
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [environmentsRow] }),
          innerJoin: () => ({
            where: async () => [{ issueId: 'issue-1', ...environmentsRow }],
          }),
        }),
      }),
    } as never;

    const byProject = await real.loadStoredCredentials('project-1', executor);
    expect(byProject.map((one) => one.value)).toEqual(['u', 'p-0123456789ab']);
    const byIssue = await real.loadCredentialsByIssue(['issue-1'], executor);
    expect(byIssue.get('issue-1')?.map((one) => one.value)).toEqual(['u', 'p-0123456789ab']);
  });
});
