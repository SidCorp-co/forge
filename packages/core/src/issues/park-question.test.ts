import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const askParkQuestion = vi.fn(async (_tx: unknown, _input: unknown) => ({}));
const personOwesAnAnswer = vi.fn(async () => false);
vi.mock('../questions/write.js', () => ({ askParkQuestion }));
vi.mock('../questions/issue-coupling.js', () => ({ personOwesAnAnswer }));

const { mintParkQuestion, parkQuestionNotMinted } = await import('./park-question.js');

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
    const said = asked(AGENT, 'in_progress', 'the signed contract');
    expect(said).toContain('`in_progress`');
    expect(said).toContain('needs_info');
    expect(said).toContain('on no record');
  });

  it('says nothing for an agent parking at `waiting` with a need, which now mints (ISS-1310)', () => {
    expect(asked(AGENT, 'waiting', 'a Search Console login')).toBeNull();
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

describe('which parks mint the question a person answers (ISS-1310)', () => {
  const mint = (actor: typeof AGENT | typeof PERSON, toStatus: string, needs?: string) =>
    mintParkQuestion(
      { issue: ISSUE, toStatus: toStatus as never, actor, options: { needs, reason: 'why' } },
      {} as never,
    );

  it('mints for an agent at `waiting` that names what it needs', async () => {
    askParkQuestion.mockClear();
    await mint(AGENT, 'waiting', 'a Search Console login');
    expect(askParkQuestion).toHaveBeenCalledTimes(1);
    expect(askParkQuestion.mock.calls[0]?.[1]).toMatchObject({
      issueId: 'i1',
      needed: 'a Search Console login',
    });
  });

  it('mints nothing for an agent at `waiting` that names no need', async () => {
    askParkQuestion.mockClear();
    await mint(AGENT, 'waiting');
    await mint(AGENT, 'waiting', '   ');
    expect(askParkQuestion).not.toHaveBeenCalled();
  });

  it('still mints for an agent at `needs_info` with no need stated', async () => {
    askParkQuestion.mockClear();
    await mint(AGENT, 'needs_info');
    expect(askParkQuestion).toHaveBeenCalledTimes(1);
  });

  it('mints nothing for a person, nor at a working rung', async () => {
    askParkQuestion.mockClear();
    await mint(PERSON, 'waiting', 'a login');
    await mint(AGENT, 'in_progress', 'a login');
    expect(askParkQuestion).not.toHaveBeenCalled();
  });
});
