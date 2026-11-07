import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-classifier.js';

// ISS-1101: the runner's words for a turn that could not start used to read `unclassified`, so a
// room handed the same failed session every turn after it for 13 hours.
describe('a turn the runner could not start', () => {
  it('in a checkout that is not on its box is a workspace preflight failure no retry clears', () => {
    const said =
      'chat turn for epod refused: checkout /srv/epod-webauto does not exist; the binding names /srv/epodsystem-core';
    expect(classifyFailure({ error: said })).toMatchObject({
      cause: 'workspace_preflight_failed',
      action: 'terminal',
    });
  });

  it('in a working directory that is gone is a workspace preflight failure', () => {
    const said =
      'failed to start chat turn: cannot start claude: its working directory /srv/gone does not exist (No such file or directory (os error 2))';
    expect(classifyFailure({ error: said }).cause).toBe('workspace_preflight_failed');
  });

  it('with no program to run is named so, never as the checkout', () => {
    const said =
      'failed to start chat turn: cannot start claude in /srv/repo: the program was not found (No such file or directory (os error 2))';
    expect(classifyFailure({ error: said }).cause).toBe('runner_unsupported_type');
  });

  it('as the runner used to word every one of them stays unclassified', () => {
    const said =
      'failed to start chat turn: failed to spawn claude: No such file or directory (os error 2)';
    expect(classifyFailure({ error: said }).cause).toBe('unclassified');
  });
});
