// ISS-1451 / ISS-1442: a room's language for a line core writes is the project's content language
// first; the room's words are a hint only for a project that never said.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const setting = vi.hoisted(() => ({
  view: { source: 'default', contentLanguage: 'en' } as { source: string; contentLanguage: string },
}));
vi.mock('../project-config/content-language.js', () => ({
  readContentLanguage: async () => setting.view,
}));

import { projectLanguageOf, roomLanguage } from './report-thread.js';
import type { RoomRow } from './store.js';

const room = { projectId: 'p-1' } as RoomRow;

beforeEach(() => {
  setting.view = { source: 'default', contentLanguage: 'en' };
});

describe('the language a room is written to (ISS-1451)', () => {
  it('is the project’s where it says Vietnamese, with no word of the room needed', async () => {
    setting.view = { source: 'document', contentLanguage: 'vi' };
    expect(await projectLanguageOf('p-1')).toBe('vi');
    expect(await roomLanguage(room, [])).toBe('vi');
    expect(await roomLanguage(room, ['Where is my order?'])).toBe('vi');
  });

  it('keeps English where the project says English, whatever the room writes', async () => {
    setting.view = { source: 'document', contentLanguage: 'en' };
    expect(await roomLanguage(room, ['Đơn hàng của em đã giao chưa ạ?'])).toBe('en'); // i18n-allow: a Vietnamese room line
  });

  it('is no project language where the document never said, and the room hints only then', async () => {
    expect(await projectLanguageOf('p-1')).toBeNull();
    expect(await roomLanguage(room, ['Đơn hàng của em đã giao chưa ạ?'])).toBe('vi'); // i18n-allow: a Vietnamese room line
    expect(await roomLanguage(room, ['Where is my order?'])).toBe('en');
  });
});
