import { supportPromiseRequestSchema } from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '../project-config/index.js';
import { environmentNamed, environmentNames, promiseNote, untrackedWhy } from './promise-rules.js';

// ISS-1012: the pure rules of a support room's promise to tell a person when an issue reaches an
// environment.

type Environments = ProjectDocument['environments'];

const ENVIRONMENTS = {
  staging: {
    tier: 'staging',
    deploysFrom: 'dev',
    deployment: { binding: '6d0f8f9e-1d1a-4c6e-9d2b-3c1a2b3c4d5e' },
  },
  production: {
    tier: 'production',
    deploysFrom: 'main',
    deployment: { mode: 'external' },
    verification: {
      runtime: [
        { type: 'http', url: 'https://app.test/build', path: 'commit', identifies: 'source' },
      ],
    },
  },
  preview: { tier: 'staging', deploysFrom: 'dev', deployment: { mode: 'external' } },
} as unknown as Environments;

const FACTS = {
  title: 'Orders show their delivery date',
  key: 'SP-42',
  environment: 'staging',
  asker: 'Lan',
};

describe("a promise names the environment by the project's own name (criterion 2)", () => {
  it("finds the document's environment by its name, case and spaces aside", () => {
    expect(environmentNamed(ENVIRONMENTS, 'staging')?.name).toBe('staging');
    expect(environmentNamed(ENVIRONMENTS, ' Production ')?.name).toBe('production');
  });

  it('finds none for a name the document does not declare, and lists the names it does', () => {
    expect(environmentNamed(ENVIRONMENTS, 'stg')).toBeNull();
    expect(environmentNames(ENVIRONMENTS)).toBe('staging, production, preview');
    expect(environmentNames({} as Environments)).toMatch(/declares no environment/);
  });

  it('takes no deployment target id: the request names an environment, and refuses a target', () => {
    const asked = { thread: 't1', issue: 'SP-42', environment: 'staging' };
    expect(supportPromiseRequestSchema.safeParse(asked).success).toBe(true);
    const withTarget = { ...asked, target: '6d0f8f9e-1d1a-4c6e-9d2b-3c1a2b3c4d5e' };
    expect(supportPromiseRequestSchema.safeParse(withTarget).success).toBe(false);
    expect(supportPromiseRequestSchema.safeParse({ ...asked, issue: '42' }).success).toBe(false);
  });
});

describe('a promise the room cannot keep is named (criterion 6)', () => {
  it('reads an environment Forge deploys, or reads through a source probe, as tracked', () => {
    for (const name of ['staging', 'production']) {
      const env = environmentNamed(ENVIRONMENTS, name);
      expect(env && untrackedWhy(env.name, env.declaration)).toBeNull();
    }
  });

  it('reads one deployed outside Forge with no source probe as untracked, saying why', () => {
    const env = environmentNamed(ENVIRONMENTS, 'preview');
    expect(env && untrackedWhy(env.name, env.declaration)).toMatch(
      /`preview` is deployed outside Forge with no source probe/,
    );
  });
});

describe('the session is told once, to say it in its own words (criteria 4, 5)', () => {
  it('names the issue by its title and the environment, and asks for one post with no key', () => {
    const note = promiseNote('reached', FACTS);
    expect(note).toContain('"Orders show their delivery date"');
    expect(note).toContain('it is on staging now');
    expect(note).toMatch(/Post it once, in this thread, in your own words/);
    expect(note).toMatch(/never by a key, an id or a commit/);
  });

  it('says a dropped issue will never get there', () => {
    expect(promiseNote('dropped', FACTS)).toMatch(/the team dropped that work/);
  });

  it('says an environment no longer tracked ends the promise', () => {
    expect(promiseNote('untracked', FACTS)).toMatch(/no longer tracks staging/);
  });
});
