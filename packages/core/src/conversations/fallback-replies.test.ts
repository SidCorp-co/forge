import { describe, expect, it } from 'vitest';
import { nothingPostedStatus, replyLanguageOf, uncertainStatus } from './fallback-replies.js';

const OWNER_REQUEST =
  "Owner request: please draw Catalog API's workflow designs from its code and from REQ-1 (Catalog triển khai sản phẩm và thiết kế lên cửa hàng ePOD). Leave every design proposed for my review."; // i18n-allow: a Vietnamese message the detector is tested on

describe('a code-authored status answers in the language of the message it answers', () => {
  it('an English request quoting a Vietnamese requirement title reads as English', () => {
    expect(replyLanguageOf(OWNER_REQUEST)).toBe('en');
    expect(nothingPostedStatus('catalog-api', replyLanguageOf(OWNER_REQUEST) ?? 'en')).toMatch(
      /^catalog-api received your request/,
    );
  });

  it('a Vietnamese message reads as Vietnamese, and one with no words cannot be told', () => {
    expect(replyLanguageOf('Bạn vẽ giúp tôi các luồng nghiệp vụ từ mã nguồn nhé')).toBe('vi'); // i18n-allow: a Vietnamese message the detector is tested on
    expect(replyLanguageOf('👍 123')).toBeNull();
    expect(uncertainStatus('hop', 'vi')).toMatch(/^hop đã gửi/); // i18n-allow: a Vietnamese message the detector is tested on
  });

  it('a failed turn names what failed and its code, never "nothing to add"', () => {
    const line = nothingPostedStatus('catalog-api', 'en', 'ASSISTANT_TURN_TIMED_OUT');
    expect(line).toContain('ran out of time');
    expect(line).toContain('(ASSISTANT_TURN_TIMED_OUT)');
    expect(line).not.toMatch(/AbortError|nothing to add/);
  });
});
