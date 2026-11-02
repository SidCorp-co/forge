import { describe, expect, it } from 'vitest';
import { replyLanguageOf } from './text-language.js';

const OWNER_REQUEST =
  "Owner request: please draw Catalog API's workflow designs from its code and from REQ-1 (Catalog triển khai sản phẩm và thiết kế lên cửa hàng ePOD). Leave every design proposed for my review."; // i18n-allow: a Vietnamese message the detector is tested on

describe('the language a message is written in', () => {
  it('an English request quoting a Vietnamese requirement title reads as English', () => {
    expect(replyLanguageOf(OWNER_REQUEST)).toBe('en');
  });

  it('a Vietnamese message reads as Vietnamese, and one with no words cannot be told', () => {
    expect(replyLanguageOf('Bạn vẽ giúp tôi các luồng nghiệp vụ từ mã nguồn nhé')).toBe('vi'); // i18n-allow: a Vietnamese message the detector is tested on
    expect(replyLanguageOf('👍 123')).toBeNull();
  });
});
