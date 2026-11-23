import { describe, expect, it } from 'vitest';
import { askerLanguageOf, replyLanguageOf } from './text-language.js';

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

  // ISS-1442 (FB-841): three words with one Vietnamese-only letter is Vietnamese; loanwords stay English
  it('reads a short message with a Vietnamese-only letter as Vietnamese, and a stray loanword accent as English', () => {
    expect(askerLanguageOf('Alo sao thế')).toBe('vi'); // i18n-allow: a short Vietnamese message the detector is tested on
    expect(askerLanguageOf('thế')).toBe('vi'); // i18n-allow: a one-word Vietnamese message
    expect(askerLanguageOf('ok')).toBeNull();
    // r2: a Vietnamese-only word typed without marks decides a short message as a letter does
    for (const bare of ['ok nhe', 'cam on nhe', 'nhe']) {
      expect(askerLanguageOf(bare), bare).toBe('vi'); // i18n-allow: short unmarked Vietnamese messages
    }
    expect(askerLanguageOf('ok thanks')).toBeNull();
    for (const loan of ['café', 'naïve', 'résumé', 'send me the résumé']) {
      expect(askerLanguageOf(loan)).not.toBe('vi');
    }
  });
});
