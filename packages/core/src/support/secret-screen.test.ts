// ISS-1353: account credentials written in chat, read before the room keeps a message. Every value
// here is an obvious fake planted for the test.
import { FILTERED } from '@forge/observability';
import { describe, expect, it } from 'vitest';
import { screenAlone, scrubChatCredentials } from './secret-screen.js';

const PASS = 'Fake-Pass-0042';

describe('a password under a short chat label', () => {
  it.each([
    [`mk: ${PASS}`, `mk: ${FILTERED}`],
    [`MK ${PASS}`, `MK ${PASS}`],
    [`pass = ${PASS}`, `pass = ${FILTERED}`],
    [`pw: 82731945`, `pw: ${FILTERED}`],
    [`mật khẩu là ${PASS}`, `mật khẩu là ${FILTERED}`], // i18n-allow: the label under test
    [`the password is ${PASS}.`, `the password is ${FILTERED}`],
  ])('filters the value of %s', (text, kept) => {
    expect(scrubChatCredentials(text, false)).toBe(kept);
  });

  it.each([
    'pass: required',
    'mk: ok',
    'pw: 3 tries left',
    'mật khẩu là gì vậy?', // i18n-allow: "what is the password?", prose
    'passport: issued',
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
    expect(screenAlone(`Login cho test: tester@example.test / ${PASS}`)).toEqual({
      text: `Login cho test: tester@example.test / ${FILTERED}`,
      secret: true,
    });
    expect(screenAlone(`email: tester@example.test, password: ${PASS}`)).toEqual({
      text: `email: tester@example.test, password: ${FILTERED}`,
      secret: true,
    });
    expect(screenAlone('my email is tester@example.test')).toEqual({
      text: 'my email is tester@example.test',
      secret: false,
    });
  });
});
