/**
 * ISS-1009 — the argv rules of the chat door's `forge` tool: which verbs a
 * room reaches, where a body goes, and what a stopped run says.
 */

import { describe, expect, it } from 'vitest';
import {
  admitVerb,
  CHAT_JOB_VERBS,
  chatWithheld,
  placeBody,
  stoppedMessage,
} from './forge-cli-argv.js';

describe('which verbs a room reaches', () => {
  it('admits the tracker verbs and help', () => {
    for (const v of CHAT_JOB_VERBS) expect(admitVerb([v, '-h'])).toBeNull();
    expect(admitVerb(['-h'])).toBeNull();
    expect(admitVerb(['new', '-', '--title', 'T', '--category', 'bug'])).toBeNull();
  });

  // cm:guard `doctor --token`, `coolify deploy`, `cloudflare purge`, `claim`, `advance` are what a prompt-injected room would reach through an open CLI; the refusal names the open set so a model that asked for one of these is told what it may do instead (ISS-1009).
  it('refuses the machine, flow and deploy verbs by name, naming what is open', () => {
    for (const v of [
      'doctor',
      'coolify',
      'cloudflare',
      'codex',
      'chatgpt',
      'hooks',
      'stats',
      'claim',
      'advance',
      'record',
      'feedback',
      'alike',
    ]) {
      const said = admitVerb([v]) ?? '';
      expect(said, v).toContain(`\`forge ${v}\` is not open from chat`);
      expect(said, v).toContain('issue, new, comment');
    }
  });

  // cm:guard the withheld list and the admitted list are ONE list read two ways: were they two, `forge -h` would show the model a verb the door then refuses, or hide one it would have run (ISS-1009).
  it('withholds from the help exactly what it refuses at run', () => {
    const withheld = new Set(chatWithheld());
    for (const v of CHAT_JOB_VERBS) expect(withheld.has(v), v).toBe(false);
    for (const v of ['coolify', 'cloudflare', 'claim', 'advance', 'codex'])
      expect(withheld.has(v), v).toBe(true);
    expect(withheld.has('doctor')).toBe(false);
  });

  it('opens knowledge reads and closes its writes', () => {
    expect(admitVerb(['knowledge', 'search', 'x'])).toBeNull();
    expect(admitVerb(['knowledge', 'write'])).toMatch(/not open from chat/u);
    expect(admitVerb(['knowledge', 'delete'])).toMatch(/not open from chat/u);
  });

  it('refuses an empty argv', () => {
    expect(admitVerb([])).toMatch(/nothing to run/u);
  });
});

describe('where the body goes', () => {
  it('replaces the dash the caller wrote, and nothing else', () => {
    expect(placeBody(['new', '-', '--title', 'T'], '## Outcome', '/tmp/b.md')).toEqual([
      'new',
      '/tmp/b.md',
      '--title',
      'T',
    ]);
  });

  // cm:guard measured 2026-09-15: an empty string was once treated as a body, and the path it earned was spliced into `guide writing-an-issue` — every call of that turn failed on an argument the model never sent (ISS-1009).
  it('treats an empty body as no body and leaves the argv alone', () => {
    expect(placeBody(['guide', 'writing-an-issue'], '', '/tmp/b.md')).toEqual([
      'guide',
      'writing-an-issue',
    ]);
    expect(placeBody(['issue', '--search', 'q'], undefined, '/tmp/b.md')).toEqual([
      'issue',
      '--search',
      'q',
    ]);
  });

  it('refuses a body with nowhere to go, naming the way', () => {
    expect(() => placeBody(['new', '--title', 'T'], '## Outcome', '/tmp/b.md')).toThrow(
      /write `-` where the file goes/u,
    );
  });

  it('does not mutate the argv it was given', () => {
    const argv = ['new', '-'];
    placeBody(argv, 'x', '/tmp/b.md');
    expect(argv).toEqual(['new', '-']);
  });
});

describe('a stopped run', () => {
  // cm:guard measured 2026-09-15: a 60s kill returned exit 1 with both streams empty, and the model told the reporter the tracker "rejected the submission without returning an error message" — a timeout the model cannot read is a refusal it invents (ISS-1009).
  // cm:guard consult F1 (2026-09-15): the kill can land after the commit, so the message may say the outcome is unknown and may not say nothing was filed (ISS-1009).
  it('says it was stopped and that the outcome is unknown, never that nothing was filed', () => {
    const said = stoppedMessage(180);
    expect(said).toContain('stopped after 180s');
    expect(said).toMatch(/NOT known/u);
    expect(said).not.toMatch(/nothing was filed/iu);
    expect(said).toContain('forge issue --search');
  });
});
