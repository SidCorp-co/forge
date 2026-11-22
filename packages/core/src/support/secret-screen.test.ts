// ISS-1353: account credentials written in chat, read before the room keeps a message. Every value
// here is an obvious fake planted for the test.
import { FILTERED } from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { keepScreened, proposalOf } from './secret-keep.js';
import { filteredValues, screenAlone, scrubChatCredentials } from './secret-screen.js';

const PASS = 'Fake-Pass-0042';
// an obvious fake in a production token's shape, built here so no literal token sits in the tree
const TOKEN = ['fake', 'session', 'Zq8vN3pL5tR2wX7y'].join('-');

describe('a password under a short chat label', () => {
  it.each([
    [`mk: ${PASS}`, `mk: ${FILTERED}`],
    [`MK ${PASS}`, `MK ${PASS}`],
    [`pass = ${PASS}`, `pass = ${FILTERED}`],
    [`pw: 82731945`, `pw: ${FILTERED}`],
    [`mật khẩu là ${PASS}`, `mật khẩu là ${FILTERED}`], // i18n-allow: the label under test
    [`mật mã: ${PASS}`, `mật mã: ${FILTERED}`], // i18n-allow: the label under test, ending in a letter outside ASCII
    [`MẬT MÃ là ${PASS}`, `MẬT MÃ là ${FILTERED}`], // i18n-allow: the label under test, capitals
    [`mat ma: ${PASS}`, `mat ma: ${FILTERED}`],
    [`the password is ${PASS}.`, `the password is ${FILTERED}.`],
    [`(mk: ${PASS})`, `(mk: ${FILTERED})`],
  ])('filters the value of %s', (text, kept) => {
    expect(scrubChatCredentials(text, false)).toBe(kept);
  });

  it.each([
    'pass: required',
    'mk: ok',
    'pw: 3 tries left',
    'mật khẩu là gì vậy?', // i18n-allow: "what is the password?", prose
    'passport: issued',
    'mật mãi: 12345678', // i18n-allow: a longer word the label starts, never the label
    'tmk: 12345678',
    'the build will pass: 12 tests',
  ])('keeps prose as written: %s', (text) => {
    expect(scrubChatCredentials(text, false)).toBe(text);
  });
});

describe('an email or user name paired with a password', () => {
  it.each([
    [`tester@example.test / ${PASS}`, `tester@example.test / ${FILTERED}`],
    [`tester@example.test ${PASS}`, `tester@example.test ${FILTERED}`],
    [`tester@example.test\n${PASS}`, `tester@example.test\n${FILTERED}`],
    [`user: qa-admin | ${PASS}`, `user: qa-admin | ${FILTERED}`],
    [`tài khoản: qa-admin ${PASS}`, `tài khoản: qa-admin ${FILTERED}`], // i18n-allow: "account:", the label under test
  ])('filters the password where the thread asks for a login: %s', (text, kept) => {
    expect(scrubChatCredentials(text, true)).toBe(kept);
  });

  it('keeps the pair as written where nothing asks for a login', () => {
    const text = `tester@example.test ${PASS}`;
    expect(scrubChatCredentials(text, false)).toBe(text);
  });

  it.each([
    'write to tester@example.test',
    'tester@example.test thanks',
    'tester@example.test, other@example.test',
    'tester@example.test https://example.test/login',
  ])('keeps an email with no password beside it: %s', (text) => {
    expect(scrubChatCredentials(text, true)).toBe(text);
  });

  it('reads a message that asks for the login itself, and leaves a labelled pair scrubbed once', () => {
    expect(screenAlone(`Login cho test: tester@example.test / ${PASS}`)).toMatchObject({
      text: `Login cho test: tester@example.test / ${FILTERED}`,
      secret: true,
    });
    expect(screenAlone(`email: tester@example.test, password: ${PASS}`)).toMatchObject({
      text: `email: tester@example.test, password: ${FILTERED}`,
      secret: true,
    });
    expect(screenAlone('my email is tester@example.test')).toEqual({
      text: 'my email is tester@example.test',
      secret: false,
      values: [],
    });
  });
});

describe('ISS-1372: each filtered value, read back for the vault, and the name it is proposed under', () => {
  it('reads every value a screened message filtered, in order, and nothing else', () => {
    const text = `token: ${TOKEN}\npassword: ${PASS}. thanks`;
    const kept = screenAlone(text);
    expect(kept.secret).toBe(true);
    expect(kept.values).toEqual([TOKEN, PASS]);
    expect(kept.text).not.toContain(TOKEN);
    expect(screenAlone('my email is tester@example.test').values).toEqual([]);
  });

  // cleanup 10c8cdf9 (debt c586c81f): every read-back value lost a closing `.`, `)` or `]`, so
  // `P@ss(w0rd)` was kept as `P@ss(w0rd`; the sentence's marks now stay in the text, outside the value
  it.each([
    ['password: P@ss(w0rd)', 'P@ss(w0rd)'],
    ['mk: [Fake-Pass-0042]', '[Fake-Pass-0042]'],
    [`password: ${PASS}!`, `${PASS}!`],
    [`the password is ${PASS}.`, PASS],
    [`(mk: ${PASS})`, PASS],
    ['mk: P@ss(w0rd)).', 'P@ss(w0rd)'],
    [`token: ${TOKEN}.`, TOKEN],
  ])('keeps %s as %s, exactly the run the screen filtered', (text, value) => {
    const kept = screenAlone(text);
    expect(kept).toMatchObject({ secret: true, values: [value] });
    expect(kept.text.split(FILTERED).join(value)).toBe(text);
  });

  it('reads nothing where the kept text does not line up with the original', () => {
    expect(filteredValues('something else entirely', `token: ${FILTERED}`)).toEqual([]);
    expect(filteredValues('no secret here', 'no secret here')).toEqual([]);
  });

  // cleanup 10c8cdf9 (debt cabd6afd): a value read back from no run was dropped with nothing kept,
  // and the note then blamed a missing vault key; each is now named as not kept, and why
  it('names each value it could not read back as not kept, and keeps nothing', async () => {
    const held = await keepScreened(
      {} as Parameters<typeof keepScreened>[0],
      { id: 'm-1', userId: 'u-1' },
      { text: `token: ${FILTERED}\npassword: ${FILTERED}`, secret: true, values: [] },
      'chat.example.test',
    );
    expect(held).toEqual({
      text: `token: ${FILTERED}\npassword: ${FILTERED}`,
      kept: [],
      missed: [
        { index: 0, label: 'token', why: 'unreadable' },
        { index: 1, label: 'password', why: 'unreadable' },
      ],
    });
  });

  it.each([
    [
      `AdminHub production token: ${FILTERED}`,
      'AdminHub production token',
      'token',
      /^adminhub-production-token$/,
    ],
    [`mk: ${FILTERED}`, 'password', 'password', /^password$/],
    [`mật khẩu là ${FILTERED}`, 'mật khẩu', 'password', /^mat-khau$/], // i18n-allow: the label under test
    [`${FILTERED}`, 'credential', 'credential', /^credential$/],
    [`PGPrints api key = ${FILTERED}`, 'PGPrints api key', 'key', /^pgprints-api-key$/],
  ])('proposes a name and kind from the words before the value: %s', (text, label, kind, slug) => {
    const p = proposalOf(text, 0);
    expect([p.label, p.kind]).toEqual([label, kind]);
    expect(p.slug).toMatch(slug);
  });
});
