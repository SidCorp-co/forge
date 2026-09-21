import { describe, expect, it } from 'vitest';
import { assertCallerDeclaresNoKind, kindFromQuery } from './kind-query.js';

const refuse = (message: string) => new Error(message);

function refusalFor(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the value was accepted, and this assertion is about it being refused');
}

describe('kindFromQuery', () => {
  it('answers with the kind a caller named', () => {
    expect(kindFromQuery('master', refuse)).toBe('master');
    expect(kindFromQuery('run_session', refuse)).toBe('run_session');
    expect(kindFromQuery('chat', refuse)).toBe('chat');
  });

  // ISS-1136 — this route filtered on `metadata->>'type' = 'agent'` for two
  // years and no writer in this repository has ever set that value, so the
  // filter answered an empty page: indistinguishable from having no sessions.
  it('refuses the value this route used to answer an empty page for', () => {
    expect(refusalFor(() => kindFromQuery('agent', refuse))).toMatch(/names no session kind/);
  });

  it('names every valid kind in the refusal, so the caller has a way forward', () => {
    const said = refusalFor(() => kindFromQuery('wave', refuse));
    expect(said).toContain('wave');
    for (const kind of ['master', 'run_session', 'pipeline', 'pm', 'chat']) {
      expect(said, 'a refusal that does not name what IS valid is a dead end').toContain(kind);
    }
  });
});

describe('assertCallerDeclaresNoKind', () => {
  it('lets through metadata that does not try to name a species', () => {
    expect(() => assertCallerDeclaresNoKind({ source: 'onboard' }, refuse)).not.toThrow();
    expect(() => assertCallerDeclaresNoKind(null, refuse)).not.toThrow();
    expect(() => assertCallerDeclaresNoKind(undefined, refuse)).not.toThrow();
  });

  it('refuses a caller that declares one, naming the column that holds it', () => {
    const said = refusalFor(() => assertCallerDeclaresNoKind({ type: 'agent', keep: 1 }, refuse));
    expect(said).toContain('kind');
    expect(said).toContain('chat');
  });

  it('refuses a declared species even when it names a real kind', () => {
    // Absorbing this one would be worse than refusing it: the caller would go
    // away believing it had opened a master.
    expect(refusalFor(() => assertCallerDeclaresNoKind({ type: 'master' }, refuse))).toMatch(
      /not a caller/,
    );
  });
});
