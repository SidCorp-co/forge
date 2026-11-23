import { describe, expect, it } from 'vitest';
import { ENGLISH_ROWS, VIETNAMESE_ROWS } from './language-rows.fixture.js';
import { askerLanguageOf, hasVietnameseEvidence, replyLanguageOf } from './text-language.js';

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
    // r3: a name or English word that is also an unmarked Vietnamese word decides nothing in a short message
    for (const english of [
      'Minh, any update?',
      'thanks Minh',
      'hi Minh',
      'toi nay',
      'Minh, can you check ISS-5?',
    ]) {
      expect(askerLanguageOf(english), english).not.toBe('vi'); // i18n-allow: English messages carrying a name; a confident English reading is fine
    }
    for (const loan of ['café', 'naïve', 'résumé', 'send me the résumé']) {
      expect(askerLanguageOf(loan)).not.toBe('vi');
    }
  });

  // ISS-1442 r4: the class, not the instance. A short English message can carry a Vietnamese mark
  // without being Vietnamese; where the language is in doubt the message is left untold.
  it('leaves untold every short English message whose only Vietnamese mark is a name, place, mention or loanword', () => {
    const NOT_VIETNAMESE = [
      // given names and surnames, with and without accents
      'Nhung, any update?',
      'thanks Nhung',
      'hi Nhung',
      'Phương, any update?', // i18n-allow: an English message carrying a Vietnamese name
      'Hi Đức, is it live?', // i18n-allow: an English message carrying a Vietnamese name or place
      'Thanks Nguyễn', // i18n-allow: an English message carrying a Vietnamese name or place
      'Phương Đức Tuyền', // i18n-allow: an English message carrying a Vietnamese name or place
      'Tuyền, Phương, can you check?', // i18n-allow: an English message carrying a Vietnamese name or place
      'any news from Nguyễn Văn Ba?', // i18n-allow: an English message carrying a Vietnamese name or place
      // mentions, and the word after one
      '@Tuyền can you check?', // i18n-allow: an English message carrying a Vietnamese name or place
      '@tuyền can you check?', // i18n-allow: an English message carrying a Vietnamese name or place
      '@tuyen nguyễn is it live?', // i18n-allow: an English message carrying a Vietnamese name or place
      // places
      'Nha Trang deploy done?',
      'Đà Nẵng is live?', // i18n-allow: an English message carrying a Vietnamese name or place
      'deploy to Đà Nẵng done?', // i18n-allow: an English message carrying a Vietnamese name or place
      // a greeting followed by a lowercase name
      'hi đức is it live', // i18n-allow: an English message carrying a Vietnamese name or place
      'thanks phương', // i18n-allow: an English message carrying a Vietnamese name
      // loanwords
      'café',
      'naïve',
      'résumé',
      'send me the résumé',
      // words that are names or English
      'Minh, any update?',
      'toi nay',
    ];
    for (const text of NOT_VIETNAMESE) {
      expect(askerLanguageOf(text), text).not.toBe('vi'); // i18n-allow: English messages carrying a Vietnamese name or place; untold or English, never Vietnamese
      expect(hasVietnameseEvidence(text), text).toBe(false);
    }
    // a message that is Vietnamese beside a name is still read
    expect(askerLanguageOf('Phương ơi, ok nhe')).toBe('vi'); // i18n-allow: Vietnamese beside a name
    expect(askerLanguageOf('@Tuyền ok nhe')).toBe('vi'); // i18n-allow: Vietnamese beside a mention
    expect(askerLanguageOf('Nha Trang thế nào')).toBe('vi'); // i18n-allow: Vietnamese beside a place
    expect(askerLanguageOf('Alo sao thế')).toBe('vi'); // i18n-allow: lowercase marked word decides
  });

  // ISS-1442 r5: English evidence vetoes a Vietnamese reading, so no position of a name matters
  it('never reads as Vietnamese an English message holding a name, place, food or loanword, wherever it sits', () => {
    for (const text of ENGLISH_ROWS) {
      expect(askerLanguageOf(text), text).not.toBe('vi'); // i18n-allow: English rows carrying marked words
      expect(hasVietnameseEvidence(text), text).toBe(false);
    }
  });

  it('keeps reading Vietnamese the messages that carry no English word', () => {
    for (const text of VIETNAMESE_ROWS) {
      expect(askerLanguageOf(text), text).toBe('vi'); // i18n-allow: Vietnamese rows
    }
  });
});
