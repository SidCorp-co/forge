import { describe, expect, it } from 'vitest';
import {
  ENGLISH_ROWS,
  LONE_ACCENT_ROWS,
  MIXED_UNTOLD_ROWS,
  NOT_ENGLISH_ROWS,
  TOLD_ENGLISH_ROWS,
  TOLD_VIETNAMESE_ROWS,
  VIETNAMESE_ROWS,
} from './language-rows.fixture.js';
import { confidentLanguageOf, replyLanguageOf, roomTextsLanguageOf } from './text-language.js';

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
    expect(confidentLanguageOf('Alo sao thế')).toBe('vi'); // i18n-allow: a short Vietnamese message the detector is tested on
    expect(confidentLanguageOf('thế')).toBe('vi'); // i18n-allow: a one-word Vietnamese message
    expect(confidentLanguageOf('ok')).toBeNull();
    // r2: a Vietnamese-only word typed without marks decides a short message as a letter does
    for (const bare of ['ok nhe', 'cam on nhe', 'nhe']) {
      expect(confidentLanguageOf(bare), bare).toBe('vi'); // i18n-allow: short unmarked Vietnamese messages
    }
    expect(confidentLanguageOf('ok thanks')).toBeNull();
    // r3: a name or English word that is also an unmarked Vietnamese word decides nothing in a short message
    for (const english of [
      'Minh, any update?',
      'thanks Minh',
      'hi Minh',
      'toi nay',
      'Minh, can you check ISS-5?',
    ]) {
      expect(confidentLanguageOf(english), english).not.toBe('vi'); // i18n-allow: English messages carrying a name; a confident English reading is fine
    }
    for (const loan of ['café', 'naïve', 'résumé', 'send me the résumé']) {
      expect(confidentLanguageOf(loan)).not.toBe('vi');
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
      expect(confidentLanguageOf(text), text).not.toBe('vi'); // i18n-allow: English messages carrying a Vietnamese name or place; untold or English, never Vietnamese
    }
    // a message that is Vietnamese beside a name is still read
    expect(confidentLanguageOf('Phương ơi, ok nhe')).toBe('vi'); // i18n-allow: Vietnamese beside a name
    expect(confidentLanguageOf('@Tuyền ok nhe')).toBe('vi'); // i18n-allow: Vietnamese beside a mention
    expect(confidentLanguageOf('Nha Trang thế nào')).toBe('vi'); // i18n-allow: Vietnamese beside a place
    expect(confidentLanguageOf('Alo sao thế')).toBe('vi'); // i18n-allow: lowercase marked word decides
  });

  // ISS-1442 r5: English evidence vetoes a Vietnamese reading, so no position of a name matters
  it('never reads as Vietnamese an English message holding a name, place, food or loanword, wherever it sits', () => {
    for (const text of ENGLISH_ROWS) {
      expect(confidentLanguageOf(text), text).not.toBe('vi'); // i18n-allow: English rows carrying marked words
    }
  });

  it('keeps reading Vietnamese the messages that carry no English word', () => {
    for (const text of VIETNAMESE_ROWS) {
      expect(confidentLanguageOf(text), text).toBe('vi'); // i18n-allow: Vietnamese rows
    }
  });
});

// ISS-1442 r6: a language is told only on strong evidence on one side and none on the other; else it is untold
describe('a language is told only where the evidence is strong (ISS-1442 r6)', () => {
  it('never reads an English row as Vietnamese, and reads none of them as untold-to-Vietnamese by a lone accent', () => {
    for (const text of ENGLISH_ROWS) {
      expect(confidentLanguageOf(text), text).not.toBe('vi'); // i18n-allow: English rows carrying marked words
    }
  });

  it('never reads a Vietnamese row as English, however many of its words English spells once the marks are dropped', () => {
    for (const text of NOT_ENGLISH_ROWS) {
      expect(confidentLanguageOf(text), text).not.toBe('en');
    }
  });

  it('reads the c1 examples and the strict words typed with their marks as Vietnamese', () => {
    for (const text of VIETNAMESE_ROWS) {
      expect(confidentLanguageOf(text), text).toBe('vi'); // i18n-allow: Vietnamese rows
    }
    for (const text of TOLD_VIETNAMESE_ROWS) expect(confidentLanguageOf(text), text).toBe('vi'); // i18n-allow: Vietnamese rows
  });

  it('tells English where English evidence stands alone', () => {
    for (const text of TOLD_ENGLISH_ROWS) expect(confidentLanguageOf(text), text).toBe('en');
  });

  it('leaves untold the messages whose one Vietnamese signal is a lone accented token or a name', () => {
    for (const text of LONE_ACCENT_ROWS) {
      expect(confidentLanguageOf(text), text).toBeNull(); // i18n-allow: lone accented tokens
    }
  });

  it('leaves untold a Vietnamese message holding one English word, in both directions', () => {
    for (const text of MIXED_UNTOLD_ROWS) {
      expect(confidentLanguageOf(text), text).toBeNull(); // i18n-allow: Vietnamese beside one English word
    }
  });
});

describe("a room's default language for a line core writes (ISS-1451)", () => {
  it('reads Vietnamese from a room with no strict word', () => {
    const texts = ['Đơn hàng bị lỗi', 'Báo lỗi đăng nhập trên điện thoại', 'Em cảm ơn']; // i18n-allow: Vietnamese fixtures
    expect(roomTextsLanguageOf(texts)).toBe('vi');
  });

  it('keeps an English room English beside names and loanwords', () => {
    const texts = [
      'Hi Nguyễn Văn Đức, the café order is late', // i18n-allow: a Vietnamese name in English
      'Please check the order from @Trần and the crème brûlée stall', // i18n-allow: names and loanwords
    ];
    expect(roomTextsLanguageOf(texts)).toBe('en');
  });

  it('is English for an empty room and for one lone marked word', () => {
    expect(roomTextsLanguageOf([])).toBe('en');
    expect(roomTextsLanguageOf(['the đơn is late'])).toBe('en'); // i18n-allow: one stray word
  });
});
