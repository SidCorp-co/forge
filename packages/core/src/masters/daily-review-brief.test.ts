import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../agent-sessions/index.js', () => ({ requestSessionSend: vi.fn() }));
vi.mock('../devices/index.js', () => ({ masterSilentSql: vi.fn() }));

const { dailyReviewBrief } = await import('./daily-review.js');

const brief = dailyReviewBrief({
  projectId: 'p-1',
  slug: 'adminhub-api',
  since: new Date('2026-11-01T01:00:00Z'),
  until: new Date('2026-11-02T01:00:00Z'),
  threads: [{ rid: 'rid-communicate', thread: 'XQHEiGjSv8HTytmpY' }],
});
const unthreaded = dailyReviewBrief({
  projectId: 'p-1',
  slug: 'adminhub-api',
  since: new Date('2026-11-01T01:00:00Z'),
  until: new Date('2026-11-02T01:00:00Z'),
  threads: [],
});

// owner ruling 2026-11-02 (product-delivery-audit-loop): the daily review audits the day's channel
// conversations and raises owner decisions only where the owner reads, never in a users' room (ISS-872)
describe('the daily review brief', () => {
  it('asks for the audit of the day’s channel conversations and their outcomes', () => {
    expect(brief).toMatch(/Audit \(owner, 2026-11-02, product-delivery-audit-loop\)/);
    expect(brief).toMatch(/channel conversations and how each ended/);
    expect(brief).toMatch(/into product items/);
  });

  it('names where the conversations are read', () => {
    expect(brief).toContain('/api/projects/p-1/support/turns');
    expect(brief).toContain('/api/projects/p-1/support/rooms/<roomId>/actions');
  });

  it('raises owner decisions only in the Forge-Communicate thread, never in a users’ room', () => {
    expect(brief).toMatch(
      /in this project's Forge-Communicate thread, never in a room its users read/,
    );
    expect(brief).toMatch(/rid naming the Forge-Communicate room/);
    expect(brief).toMatch(/never in a room whose readers are users/);
    expect(brief).not.toMatch(/rid\?/);
  });

  // ISS-934: Forge-Communicate is shared by every project, one thread each; the review names the
  // project's own, and a project with none is told where to record it, never to post top level
  it('names the project’s own Forge-Communicate thread, never the room’s top level', () => {
    expect(brief).toContain('thread XQHEiGjSv8HTytmpY of room rid-communicate');
    expect(brief).toMatch(/never at the room's top level/);
  });

  it('tells a project with no thread recorded where to record one, and that a post is refused', () => {
    expect(unthreaded).toContain('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(unthreaded).toContain('operations.threads["<rid>"]["adminhub-api"]');
    expect(unthreaded).not.toMatch(/thread \S+ of room/);
  });

  // ISS-867: the review says what the day taught, by pointing at where it is read, never the lessons
  it('points at the day’s new lessons and repeats, never carrying a lesson itself', () => {
    expect(brief).toContain(
      '/api/projects/p-1/lessons/learned?since=2026-11-01T01:00:00.000Z&until=2026-11-02T01:00:00.000Z',
    );
    expect(brief).toMatch(/lessons approved and the approved lessons whose mistake was made again/);
    expect(brief).toContain('/api/projects/p-1/knowledge/<slug>');
    // the audit line stands beside it
    expect(brief).toMatch(/Audit \(owner, 2026-11-02/);
  });
});
