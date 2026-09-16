import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const { parkQuestionNotMinted } = await import('./park-question.js');

const ISSUE = { id: 'i1', projectId: 'p1' };
const AGENT = { type: 'device' as const, id: 'd1', ownerId: 'u1' };
const PERSON = { type: 'user' as const, id: 'u1' };

const asked = (actor: typeof AGENT | typeof PERSON, toStatus: string, needs?: string) =>
  parkQuestionNotMinted({
    issue: ISSUE,
    toStatus: toStatus as never,
    actor,
    options: { needs },
  });

describe('a `needs` that mints nothing says so', () => {
  it('says nothing when the park did mint', () => {
    expect(asked(AGENT, 'needs_info', 'the signed contract')).toBeNull();
  });

  it('says nothing when no need was stated, because nothing was expected of it', () => {
    expect(asked(PERSON, 'needs_info')).toBeNull();
    expect(asked(PERSON, 'in_progress', '   ')).toBeNull();
  });

  it('names the status when the target mints no question at all', () => {
    const said = asked(AGENT, 'waiting', 'the signed contract');
    expect(said).toContain('`waiting`');
    expect(said).toContain('needs_info');
    expect(said).toContain('on no record');
  });

  it('names the credential when a person parks with a need stated', () => {
    const said = asked(PERSON, 'needs_info', 'the signed contract');
    expect(said).toContain('owned by a person');
    expect(said).toContain('Nobody has been asked anything');
    expect(said).toContain('agent account or a paired device');
  });

  it('is silent for the actor that actually mints, on the status that actually mints', () => {
    expect(asked(AGENT, 'needs_info', 'x')).toBeNull();
  });
});
