/**
 * ISS-1009 — the persona sends the model to the CLI's method rather than
 * restating it, and a rule nothing asserts is a rule a later edit deletes in
 * silence.
 */

import { describe, expect, it } from 'vitest';
import { rocketChatPersona } from './persona.js';

const PERSONA = rocketChatPersona('forge-dev');

describe('the rules the tool description cannot carry', () => {
  it('sends the model to forge -h before it acts, and forbids guessing a flag', () => {
    expect(PERSONA).toMatch(/THE TRACKER IS THE `forge` TOOL/u);
    expect(PERSONA).toMatch(/`forge -h`, then `forge <verb> -h`/u);
    expect(PERSONA).toMatch(/NEVER guess a flag or a verb/u);
  });

  // cm:guard `forge new` and not a tool wrapper: the search, the fold and the shape read are the CLI's, and a persona that told the model to search and file by hand would rebuild the second reader this issue removed (ISS-1009).
  it('files with forge new and names both routes to the reporter', () => {
    expect(PERSONA).toMatch(/FILE WITH `forge new`, NOT BY HAND/u);
    expect(PERSONA).toMatch(/folds this onto a near neighbour/u);
    expect(PERSONA).toMatch(/offer `--new`/u);
    expect(PERSONA).toMatch(/--relates ISS-<near>/u);
  });

  it('bounds the ask to what only the reporter can know', () => {
    expect(PERSONA).toMatch(/ASK ONLY FOR WHAT ONLY THE REPORTER KNOWS/u);
    expect(PERSONA).toMatch(/write it yourself/u);
    expect(PERSONA).toMatch(/Always write `## Where`/u);
  });

  it('tells the assistant to read a write back before claiming it landed', () => {
    expect(PERSONA).toMatch(/NEVER SAY A WRITE LANDED THAT YOU DID NOT READ BACK/u);
  });
});
