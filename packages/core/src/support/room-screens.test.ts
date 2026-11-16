import { describe, expect, it } from 'vitest';
import { permissionTalkIn } from './permission-talk.js';
import { uiDirectionIn } from './ui-directions.js';
import { apiHostLinkIn, onWeb } from './web-links.js';

// @direct-test-of packages/core/src/support/permission-talk.ts
// @direct-test-of packages/core/src/support/ui-directions.ts
// @direct-test-of packages/core/src/support/web-links.ts
//
// ISS-1250 (owner 2026-11-16): the epod thread of the shared operations room, after ISS-1243 landed.
// Each quoted turn, as the room agent wrote it, is refused by the screen naming its own rule; the
// posts kept as the reference (a release post, an owner ask with options) go through.

const API = ['forge-dev-api.sidcorp.co'];

const TURN = {
  // 16/11 02:21: grant talk, and the owner sent to the role's settings
  t0221:
    'Dạ phòng này không cho em lưu quy tắc kênh. Để đổi, người quản lý phòng này trên Forge cần sửa cài đặt ngôn ngữ trong vai trò của em.', // i18n-allow: the quoted epod turn being policed
  // 16/11 02:22: grant talk, and the owner sent to the project's settings
  t0222:
    'Phòng này không cho em sửa cài đặt dự án ạ. Anh hoặc master ePOD vào cài đặt của dự án ePOD trên Forge, đặt thành tiếng Anh là được.', // i18n-allow: the quoted epod turn being policed
  // 16/11 03:15: the owner sent to press an option
  t0315:
    "Câu hỏi cũ về varnish vẫn mở, chỉ chủ dự án bấm chọn được — bấm 'Thêm varnish vào job deploy forge-ops' là đóng.", // i18n-allow: the quoted epod turn being policed
  // 16/11 03:16: a person-facing link on the API host
  t0316: 'Yêu cầu nằm ở https://forge-dev-api.sidcorp.co/projects/epod/requirements/REQ-11 ạ.', // i18n-allow: the quoted epod turn being policed
  // 15/11 15:36: grant talk
  t1536:
    'Dạ phòng này chưa được cấp quyền đọc danh sách feedback, và dự án Forge hiện không có master trực.', // i18n-allow: the quoted epod turn being policed
};

const GOOD = [
  // a release post (02:18, 02:36, 02:53 in kind)
  'ePOD v1.4.2 đã lên production: lỗi khi tải ảnh POD đã sửa, thông báo lỗi mới bằng tiếng Việt.', // i18n-allow: a reference post in the owner's language
  // the owner ask (03:14 in kind): plain words, two options, a recommendation
  'Anh ơi, varnish cho forge-ops: 1) thêm vào job deploy, 2) để ngoài. Em đề xuất 1. Anh trả lời ngay trong luồng này nhé.', // i18n-allow: a reference post in the owner's language
  // the agent telling its own act, and a link on the web app
  'Em sẽ sửa cài đặt ngôn ngữ của ePOD trên Forge. Yêu cầu: https://forge-dev.sidcorp.co/projects/epod/requirements/REQ-11', // i18n-allow: a reference post in the owner's language
  'I will change the project settings on Forge, and it is in hand.',
];

describe('a room reply is screened for grant talk, directions to a screen and API-host links', () => {
  it('refuses each quoted epod turn by the rule it breaks', () => {
    expect(permissionTalkIn(TURN.t0221)).toBe('phòng này không cho em'); // i18n-allow: the quoted words
    expect(permissionTalkIn(TURN.t0222)).toBe('Phòng này không cho em'); // i18n-allow: the quoted words
    expect(permissionTalkIn(TURN.t1536)).toBe('phòng này chưa được cấp quyền'); // i18n-allow: the quoted words
    // the directions, in an operations room (Forge's own) and, where Forge is named, in any room
    expect(uiDirectionIn(TURN.t0221, false)).toBe('sửa cài đặt'); // i18n-allow: the quoted words
    expect(uiDirectionIn(TURN.t0222, false)).toBe('vào cài đặt'); // i18n-allow: the quoted words
    expect(uiDirectionIn(TURN.t0315, true)).toBe("bấm '"); // i18n-allow: the quoted words
    expect(apiHostLinkIn(TURN.t0316, API)).toBe(
      'https://forge-dev-api.sidcorp.co/projects/epod/requirements/REQ-11',
    );
  });

  it('passes the reference posts, and a product screen named in a room not Forge’s own', () => {
    for (const text of GOOD) {
      expect(permissionTalkIn(text), text).toBeNull();
      expect(uiDirectionIn(text, true), text).toBeNull();
      expect(apiHostLinkIn(text, API), text).toBeNull();
    }
    // a product's user is told how to use the product's own screen: no Forge in it
    expect(uiDirectionIn("Anh bấm 'Đặt hàng' rồi vào cài đặt tài khoản.", false)).toBeNull(); // i18n-allow: a product guide in Vietnamese
    expect(uiDirectionIn("Anh bấm 'Đặt hàng' rồi vào cài đặt tài khoản.", true)).not.toBeNull(); // i18n-allow: a product guide in Vietnamese
  });

  it('names the same page on the web app, and reads no API host where none is set apart', () => {
    expect(
      onWeb(
        'https://forge-dev-api.sidcorp.co/projects/epod/requirements/REQ-11',
        'https://w.example',
      ),
    ).toBe('https://w.example/projects/epod/requirements/REQ-11');
    expect(apiHostLinkIn(TURN.t0316, [])).toBeNull();
  });
});
