import { describe, expect, it } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { provideShareSubjectSources, shareSubjectSource } from './ports.js';

// A subject kind with no source registered is refused by name, listing the kinds this build can
// freeze: a kind is never guessed at. (Every kind has its owner, registered at boot; this
// test provides only two so the third reads as unregistered.)

describe('a share subject kind no module can freeze yet', () => {
  it('is refused naming the kinds that can', () => {
    provideShareSubjectSources([
      { kind: 'message', freeze: () => Promise.reject(new Error('not frozen here')) },
      { kind: 'template-output', freeze: () => Promise.reject(new Error('not frozen here')) },
    ]);
    let err: unknown;
    try {
      shareSubjectSource('status-report');
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err, 'SHARE_SUBJECT_UNSUPPORTED')).toBe(true);
    expect((err as Error).message).toContain('registered: message, template-output');
  });

  it('registers a second source for one kind as a defect, naming the kind', () => {
    expect(() =>
      provideShareSubjectSources([
        { kind: 'message', freeze: () => Promise.reject(new Error('x')) },
      ]),
    ).toThrow('a subject source for "message" is already registered');
  });
});
