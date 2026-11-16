import { describe, expect, it, vi } from 'vitest';

const map = vi.hoisted(() => ({ text: null as string | null, audiences: [] as unknown[] }));
vi.mock('../../lessons/index.js', () => ({
  lessonsMapFor: async (_projectId: string, audience: unknown) => {
    map.audiences.push(audience);
    return map.text;
  },
  restLessonDoors: () => ({ fetch: 'f', list: 'l', raise: 'r' }),
}));

import { roomLessonsNews } from './lessons-news.js';

// @direct-test-of packages/core/src/support/reply-audit/lessons-news.ts
//
// ISS-1250: a failed self-audit is a room correction; once the steward's pass makes a lesson of it,
// the room's next turn carries the project's lessons about chat replies: every cold turn, and a warm
// turn only when the map changed since the room was last told.

describe('a room turn carries the lessons about chat replies (ISS-1250)', () => {
  it('tells a cold turn the map, a warm turn only a changed one, and nothing where none applies', async () => {
    const room = { id: 'room-1', projectId: 'p-1' };
    map.text = null;
    expect(await roomLessonsNews(room, true)).toBeNull();
    map.text = '### Lessons\n- lesson-1 [chat replies]';
    expect(await roomLessonsNews(room, false)).toBe(map.text);
    expect(await roomLessonsNews(room, false)).toBeNull();
    expect(await roomLessonsNews(room, true)).toBe(map.text);
    map.text = '### Lessons\n- lesson-2 [chat replies]\n- lesson-1 [chat replies]';
    expect(await roomLessonsNews(room, false)).toBe(map.text);
    expect(map.audiences[0]).toMatchObject({ produces: ['chat'], area: 'any' });
  });
});
