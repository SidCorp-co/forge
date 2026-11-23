// Rows the language readers are swept with (ISS-1442): one table for the class, shared by the detector and the reply audit tests.
// i18n-allow: the English rows below carry Vietnamese names, places, food and loanwords on purpose
export const ENGLISH_ROWS = [
  'any update, phương?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok tuyền', // i18n-allow: a row carrying Vietnamese letters on purpose
  'thx đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'huế server down?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'the phở place is closed', // i18n-allow: a row carrying Vietnamese letters on purpose
  'is minh or nhung on?',
  'the crêpe place is closed', // i18n-allow: a row carrying Vietnamese letters on purpose
  'pâté for lunch?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'is the rôle set?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'can you check the deploy for phương today?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'any update, Phương?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'any update, phuong?',
  'Nha Trang deploy done?',
  'Đà Nẵng is live?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'deploy to Huế done?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'is the café open?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'is it naïve?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'send the résumé please', // i18n-allow: a row carrying Vietnamese letters on purpose
  '@tuyền can you check?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'hi đức is it live', // i18n-allow: a row carrying Vietnamese letters on purpose
  'thanks phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  'Minh, any update?',
  'is nhung on?',
  'can you check with minh and nhung about the deploy of the phở app that phương wrote yesterday?', // i18n-allow: a row carrying Vietnamese letters on purpose
  // r5 own rows: number-led, email-like, hashtag, ALL CAPS, only a name
  '3 tickets for phương are open', // i18n-allow: a row carrying Vietnamese letters on purpose
  'mail đức@example.com if it is down', // i18n-allow: a row carrying Vietnamese letters on purpose
  '#phương is the deploy done?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'IS PHƯƠNG ON TODAY?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'Phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  // r6: every row the dev.812 and dev.813 judges listed, then rows of the builder's own
  'is it bánh mì or phở today?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'which is cheaper, huế or đà nẵng?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'did phương, đức and tuyền sign off?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'back in hà nội tomorrow', // i18n-allow: a row carrying Vietnamese letters on purpose
  'bánh mì at noon?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'no phở at the café', // i18n-allow: a row carrying Vietnamese letters on purpose
  'in đà nẵng', // i18n-allow: a row carrying Vietnamese letters on purpose
  'rosé at the café', // i18n-allow: a row carrying Vietnamese letters on purpose
  'LGTM đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'FYI phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ETA đức?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'OK tuyền', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ISS-1442 đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  'crêpe?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'pâté?', // i18n-allow: a row carrying Vietnamese letters on purpose
  '2 phở', // i18n-allow: a row carrying Vietnamese letters on purpose
  '#phở', // i18n-allow: a row carrying Vietnamese letters on purpose
  'phương, đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ship the bún chả order by noon', // i18n-allow: a row carrying Vietnamese letters on purpose
  'lunch at phở 24 or bánh cuốn?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'tết deploy freeze?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'đồng or dollars?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'mì quảng and bún bò huế please', // i18n-allow: a row carrying Vietnamese letters on purpose
  'is the sài gòn node healthy?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ngô', // i18n-allow: a row carrying Vietnamese letters on purpose
  'coffee at the café or the crêperie?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'who owns the cà phê contract?', // i18n-allow: a row carrying Vietnamese letters on purpose
];
// Rows that read Vietnamese: the c1 examples, the strict words typed with their marks, and the builder's own
export const VIETNAMESE_ROWS = [
  'Alo sao thế', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok nhe',
  'cam on nhe',
  'nhe',
  'Bản này đã lên production chưa vậy anh?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'xem giup minh cai nay nha',
  'Phương ơi, ok nhe', // i18n-allow: a row carrying Vietnamese letters on purpose
  'khong duoc roi',
  'nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok ạ', // i18n-allow: a row carrying Vietnamese letters on purpose
  'dạ ok', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ừ ok', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok rồi', // i18n-allow: a row carrying Vietnamese letters on purpose
  'xong rồi', // i18n-allow: a row carrying Vietnamese letters on purpose
  'Alo thế', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok vâng nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'anh giúp em với nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'thế nhỉ', // i18n-allow: a row carrying Vietnamese letters on purpose
  'không được rồi', // i18n-allow: a row carrying Vietnamese letters on purpose
];
// Vietnamese rows that must never read English: untold or Vietnamese. Typed without marks, a Vietnamese
// message spells words English spells too (do, the, can, an, on, in, to, a, no, me, my, not, that).
export const NOT_ENGLISH_ROWS = [
  'do la gi?',
  'lam the nao?',
  'the la the nao',
  'an trua o dau',
  'can in gap',
  'van on ma',
  'server down rồi à?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'lên live chưa?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'check lại nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'done rồi nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok update đi', // i18n-allow: a row carrying Vietnamese letters on purpose
  'that khong?',
  'lam not nhe',
  'thanks anh nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ben my',
  'build xong chua?',
  'xong chua anh',
  // r6 own rows
  'to di an com',
  'a la vay ha',
  'em an the nao',
  'on khong anh',
  'be nhe',
  'no roi me oi',
  'in ra giup em',
  'cho xin cai nay',
  ...VIETNAMESE_ROWS,
];
// Messages told with confidence: a wrong-language reply to one of them still fails, naming it
export const TOLD_ENGLISH_ROWS = [
  'Has my order been delivered yet?',
  'What is the status of ISS-290 right now?',
  'Continue the ISS-748',
];
export const TOLD_VIETNAMESE_ROWS = [
  'Đơn hàng của em đã giao chưa ạ?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'Dạ, em đây ạ. Anh cần em giúp việc gì không ạ?', // i18n-allow: a row carrying Vietnamese letters on purpose
];
// One accented token or two names alone: untold
export const LONE_ACCENT_ROWS = [
  'phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  'crêpe?', // i18n-allow: a row carrying Vietnamese letters on purpose
  '2 phở', // i18n-allow: a row carrying Vietnamese letters on purpose
  'phương, đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'LGTM đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok tuyền', // i18n-allow: a row carrying Vietnamese letters on purpose
];
// Vietnamese beside one English word, and rows no language can be told from: untold
export const MIXED_UNTOLD_ROWS = [
  'server down rồi à?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'lên live chưa?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ok update đi', // i18n-allow: a row carrying Vietnamese letters on purpose
  'thanks anh nhé', // i18n-allow: a row carrying Vietnamese letters on purpose
];
// Rows untold on any reading
export const UNTOLD_ROWS = [
  'ok',
  'ok tuyền', // i18n-allow: a row carrying Vietnamese letters on purpose
  'phương', // i18n-allow: a row carrying Vietnamese letters on purpose
  'LGTM đức', // i18n-allow: a row carrying Vietnamese letters on purpose
  'server down rồi à?', // i18n-allow: a row carrying Vietnamese letters on purpose
  'ben my',
];
// A room as the audit once read it: a persona and the texts its people wrote. Neither may fail a reply to an untold asker.
export const ROOMS = [
  {
    persona: 'You are the shop desk assistant. Reply in English, short and clear.',
    texts: ['Please check the import for me'],
  },
  {
    persona: 'Trả lời bằng tiếng Việt, ngắn gọn.', // i18n-allow: a persona naming Vietnamese
    texts: ['Đơn hàng của em đã giao chưa ạ, anh kiểm tra giúp em nhé?'], // i18n-allow: a room whose people write Vietnamese
  },
] as const;
