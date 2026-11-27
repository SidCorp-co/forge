// The scenarios of the acts a room agent works a thread by (`support/room-cards.ts`), each quoted from
// the room it happened in: Forge-Communicate's actions as forge-dev serves them (GET
// /api/projects/forge/support/rooms/c4f706ae-…/actions), ISS-1250's epod thread, and the 6,935 room
// actions of 01/11-15/11 ISS-1243 measured (its report's raw actions and the AdminHub-Support
// transcript). Times are UTC.

import type { CardScenario } from '../lessons/index.js';

const FC = 'Forge-Communicate, epod thread 86aGqsokzYezYNdvF';
const AHS = 'AdminHub-Support';

export const ROOM_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a ruling read alone: “language per the setting” after the 02:18 post',
    card: 'support.asker',
    source: `${FC}, 16/11 02:21 (ISS-1250)`,
    situation:
      'The owner, right after the ePOD master’s 02:18 post said the new errors are in Vietnamese: “@babo ngôn ngữ theo cài đặt và mặc định tiếng Anh nhé”', // i18n-allow: a recorded room turn
    bad: 'Em ghi nhận ý anh, nhưng phòng này không cho em lưu quy tắc kênh… người quản lý phòng này trên Forge cần sửa cài đặt ngôn ngữ trong vai trò của em.', // i18n-allow: a recorded room turn
    good: 'read who wrote it and the thread above with support.asker, take the ruling as about ePOD’s errors the post just named, and hand it to ePOD’s master',
    teaches: [/support\.asker/, /ruling speaks of what was just said/i, /support\.ask_master/],
  },
  {
    name: 'a member record left empty: the owner answered as a stranger',
    card: 'support.member',
    source: `${FC}: GET support/channels read 0 members and 0 rules on 16/11 (ISS-1250)`,
    situation:
      'The organization’s owner (chuongld) writes in the thread; the channel record holds no member, so his roles read unknown',
    bad: 'Anh hoặc master ePOD vào cài đặt của dự án ePOD trên Forge… đặt thành tiếng Anh là được.', // i18n-allow: a recorded room turn
    good: 'keep his roles with support.member, naming him by username, so the next turn answers the owner as the owner',
    teaches: [/support\.member/, /roles/i, /username/i],
  },
  {
    name: 'a ruling on the product taken for a channel rule',
    card: 'support.rule',
    source: `${FC}, 16/11 02:21-02:22 (ISS-1250)`,
    situation:
      'The owner, then correcting: “Ý là project chứ không phải qui tắc kênh, đang nói là ngôn ngữ của epod”', // i18n-allow: a recorded room turn
    bad: 'phòng này không cho em lưu quy tắc kênh', // i18n-allow: a recorded room turn
    good: 'keep a channel rule only for how the channel is answered; a ruling on the product goes to the project’s master',
    teaches: [/how this channel is to be answered/i, /master/i, /ruling on the product/i],
  },
  {
    name: 'a relay posted instead of the answer: only “passed on, will report back”',
    card: 'support.reply',
    source: `${AHS}, thread jEmipdYcDKW8naEbG, 03/11 07:59 (ISS-1243: 21 of 76 replies were relays)`,
    situation: 'A user reports that a connected site’s token field cannot be saved',
    bad: 'Em đã chuyển lỗi này cho đội kỹ thuật rồi anh, khi sửa xong em sẽ báo lại trong thread này.', // i18n-allow: a recorded room turn
    good: 'post one result: ask the master in the turn and answer from what it hands back; for a code change, a reaction on the message and one message with the result',
    // ISS-1385 taught "the answer, or one on-it line" where the card said "results only"
    // ISS-1465: the flag teaches that a reply only saying it was passed on is the fault
    teaches: [
      /post one result/i,
      /acknowledged by a reaction/i,
      /ask the master in the turn/i,
      /never that it was passed on/i,
    ],
  },
  {
    name: 'a failure line posted on a mail request another binding holds',
    card: 'support.silent',
    source:
      'sid-email, 01/11-15/11: 43 messages recorded under both sid-desk and sidcorp-mail (ISS-1243)',
    situation:
      'A mail-server request in the shared sid-email room, held by sidcorp-mail’s binding, is also handed to sid-desk’s session',
    bad: 'sid-desk posted a turn-failed line on sidcorp-mail’s request',
    good: 'stay silent with support.silent and a reason; never post to say you are not answering',
    teaches: [/support\.silent/, /never post to say you are not answering/i],
  },
  {
    name: 'asking which of two the person meant when the thread said it',
    card: 'support.thread',
    source: `${AHS}, the balance API thread, 11/11 (ISS-1243)`,
    situation:
      'nhihty asked for the supplier balance API; the thread already held that she wanted an API',
    bad: '“bảng hay API?”, so the owner had to say “Lấy API curl chứ không phải lấy số”', // i18n-allow: a recorded room turn
    good: 'read the thread with support.thread and cite what it holds rather than asking again',
    teaches: [/support\.thread/, /rather than asking the person to say it again/i],
  },
  {
    name: 'what the product does told with no hit cited',
    card: 'support.search',
    source: `${AHS}, thread F2vRywhp8ZQLypFbe, 11/11 04:19`,
    situation: 'The owner asks whether AdminHub reads the suppliers’ balances',
    bad: 'Hiện AdminHub chưa lấy số dư từ supplier nào; riêng FlashShip có ví…, with no source named', // i18n-allow: a recorded room turn
    good: 'search the project’s knowledge and contracts with support.search and answer with each hit’s cite, or say it cannot tell',
    teaches: [/support\.search/, /cite/i, /say you cannot tell/i],
  },
  {
    name: 'one user, forty posts: instruction, error screenshot, new instruction',
    card: 'support.image',
    source: `${AHS}, thread w2NZNL75fXT83G3WB, 14/11 02:10-06:40 (ISS-1243)`,
    situation: 'thuanhtm sends a screenshot of the MangoTee mapping screen with the error on it',
    bad: 'nếu bạn không thấy nút đó thì chụp cả màn hình bảng đó gửi em để em kiểm tiếp', // i18n-allow: a recorded room turn
    good: 'read each picture with support.image before answering; never ask the person to describe what you can read',
    teaches: [/support\.image/, /describe a screenshot/i],
  },
  {
    name: 'the owner told to set ePOD’s language in Forge’s settings himself',
    card: 'support.ask_master',
    source: `${FC}, 16/11 02:22 (ISS-1250)`,
    situation:
      'The owner: “Ý là project chứ không phải qui tắc kênh, đang nói là ngôn ngữ của epod”', // i18n-allow: a recorded room turn
    bad: 'Phòng này không cho em sửa cài đặt dự án… Anh hoặc master ePOD vào cài đặt của dự án ePOD trên Forge… đặt thành tiếng Anh là được.', // i18n-allow: a recorded room turn
    good: 'hand the ruling to ePOD’s master with support.ask_master, saying what to do, react to the asker’s message with support.react, and post one message when the master’s answer is in',
    teaches: [
      /support\.ask_master/,
      /never tell a (work )?thread/i,
      /never send anyone[^.\n]*(page|setting|button)/i,
    ],
  },
  {
    name: 'a missing grant told to the user thread: “I may not share the mailbox yet”',
    card: 'support.technical',
    source:
      'sid-email, thread zUTfEVPNBlmgbubVq, 06/11 02:52 (ISS-1243: 60 replies and 54 routed posts)',
    situation: 'A member asks the bot to share the support@ mailbox with a colleague',
    bad: 'Dạ em chưa có quyền tự share mailbox ạ.', // i18n-allow: a recorded room turn
    good: 'raise the grant in the project’s technical channel with support.technical; the thread hears the answer once, when it is in',
    teaches: [/support\.technical/, /hears nothing of a grant/i],
  },
  {
    name: 'a mention of a member the channel does not list: @phatpt',
    card: 'support.route',
    source: `${AHS}, thread oMhnqukvHejepvaQc, 05/11 09:41, refused SUPPORT_MENTION_REFUSED`,
    situation: 'A user asks how to see the RustDesk password of a virtual machine',
    bad: '@phatpt đã xem lại được mật khẩu RustDesk rồi anh…', // i18n-allow: a recorded room turn
    good: 'route a technical act to the one Technical member the channel lists, and never post a refusal code in the thread',
    teaches: [/support\.route/, /one Technical member/i, /never post the refusal code/i],
  },
  {
    name: 'MangoTee country rules told live on 12/11 that were not built',
    card: 'support.in_flight',
    source: `${AHS}, thread w2NZNL75fXT83G3WB, 12/11 04:56 and 14/11 (ISS-1243)`,
    situation: 'thuanhtm waits on the MangoTee per-country lines',
    bad: 'Bạn Thuận ơi, bản 0.22.0 đã lên Hub cả Canawan và Lesmers: PO MangoTee để Tự động sẽ đi line theo nước nhận…', // i18n-allow: a recorded room turn
    good: 'read support.in_flight or ask the owning master; never assert what the record does not show',
    teaches: [/support\.in_flight/, /never assert what the record does not show/i],
  },
  {
    name: 'eight Forge-Communicate replies, none audited',
    card: 'support.audit',
    source: `${FC}: GET support/reply-verdicts on 16/11 read 8 replies by the bot, 0 audited`,
    situation: 'The bot posted its 03:16 reply with a link to REQ-11',
    bad: 'posted and moved on: no verdict was kept for any reply',
    good: 'audit the reply at once with support.audit, naming each failed line and each capability it missed',
    teaches: [/support\.audit/, /at once/i, /missed/i],
  },
  {
    name: 'answering from the brief recalled instead of the room’s guide',
    card: 'support.guide',
    source: `${FC}, 16/11 02:21, the reply’s own why`,
    situation: 'The owner rules how ePOD’s language is set',
    bad: 'why: “this operations room has no rule act and the brief says answer in the asker’s language”',
    good: 'read the room’s guide with support.guide by situation, the project’s own where it keeps one',
    teaches: [/support\.guide/, /by situation/i],
  },
  {
    name: 'an owner question asked in plain words, with options and a recommendation',
    card: 'support.ask_owner',
    source: 'Catalog-AdminHub, thread W2G7awTdt2HRofbXv, 03/11 10:04 (ask_owner on ISS-160)',
    situation:
      'The Bank Accounts department field errors when edited by hand; only the owner decides',
    good: 'ask once with support.ask_owner in plain words, the two options and the recommended one, from the thread it arose in',
    teaches: [/support\.ask_owner/, /options and your recommendation/i],
  },
  {
    name: 'the owner’s answer refused: his chat account linked to no Forge account',
    card: 'support.answer_question',
    source:
      'Catalog-AdminHub, thread W2G7awTdt2HRofbXv, 03/11 10:04, owner_answer question_answer_unrecorded',
    situation: 'The owner answers in the thread the ISS-160 question he owed',
    bad: 'the answer could not be recorded and nothing was told to him',
    good: 'record his message with support.answer_question on the question he owed, filing nothing new for it',
    teaches: [/support\.answer_question/, /file nothing for it/i],
  },
  {
    name: 'requests waiting on the owner in Activity, never put to him in chat',
    card: 'support.raise_owed',
    source:
      'Owner, 16/11, ISS-1243’s last addition: what waits on him in Activity should be asked by the agent',
    situation: 'An owed- thread hands the agent an approval waiting on the owner',
    bad: 'nothing was raised until he wrote first',
    good: 'raise it once with support.raise_owed, in plain words, its options and the recommendation',
    teaches: [/support\.raise_owed/, /once/i, /recommendation/i],
  },
  {
    name: 'the owner’s approvals filed as new feedback: FB-15..19 in thread BeK4G',
    card: 'support.approve',
    source: 'Catalog-AdminHub, thread BeK4GQzYXZpMkgtac (ISS-1243: 16 of 79 records)',
    situation: 'The owner says go on an item already recorded from his thread',
    bad: 'a new feedback item was filed for his approval',
    good: 'attach his message to the open item with support.approve and file nothing new',
    teaches: [/support\.approve/, /file nothing new/i],
  },
  {
    name: 'a second result posted where the person waits on work recorded elsewhere',
    card: 'support.promise',
    source:
      'adminhub-agent-thu, thread 5A7jdPGbfGxkQe5zh, 02/11 05:24, refused SUPPORT_ONE_RESULT_PER_REQUEST',
    situation: 'A user waits on an order fix recorded from another thread',
    bad: 'Bổ sung đơn 1454709: lần kiểm tra địa chỉ trước đó Merchize không trả kết quả hợp lệ…', // i18n-allow: a recorded room turn
    good: 'promise to tell them with support.promise when the environment serves it, and tell them then',
    teaches: [/support\.promise/, /environment/i],
  },
  {
    name: 'mail-server work filed under sid-desk from the words alone',
    card: 'support.decide',
    source: 'sid-email, sid-desk FB-2 and FB-3, re-filed by hand as sidcorp-mail FB-5 (ISS-1243)',
    situation: 'A request about the mail server in the room sid-desk and sidcorp-mail share',
    bad: 'filed on sid-desk from the message text, though the thread and sender were sidcorp-mail’s',
    good: 'decide the project from the head’s routing (thread, sender) and record it with support.decide',
    teaches: [/support\.decide/, /routing/i, /low-confidence guess/i],
  },
];
