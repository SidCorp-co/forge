// The rubric lines code can tell in a reply already posted (ISS-1250), recorded beside the agent's own
// audit so its verdict is true where the agent missed one. They never screen, hold or rewrite a post
// (owner 2026-11-16, "teach the flow, not block it"): the pre-send screen for grant talk is
// `permission-talk.ts`, read here as it stands, and these forms are what the audit adds to it.

import { env } from '../../lib/env.js';
import { firstAssertedIn } from '../not-checked.js';
import { permissionTalkIn } from '../permission-talk.js';

/** A letter boundary: `\b` is ASCII-only, and Vietnamese words end in letters it does not know. */
const START = '(?<![\\p{L}\\p{N}_])';

/** The room or the role keeping an act from the agent, beyond what the pre-send screen reads. */
const GRANT_TALK: readonly RegExp[] = [
  /(?:phòng|nhóm|room|vai\s+trò)\s+này\s+(?:không|chưa)\s+(?:cho|để)\s+(?:em|bot|mình|tôi)(?![\p{L}\p{N}_])/iu, // i18n-allow: the Vietnamese phrasing being recorded
  /(?:vai\s+trò|quyền(?:\s+hạn)?)\s+của\s+(?:em|bot|mình)(?![\p{L}\p{N}_])/iu, // i18n-allow: the Vietnamese phrasing being recorded
  /\bthis\s+(?:room|group|channel|role)\s+(?:does\s+not|doesn't|won't|will\s+not)\s+(?:let|allow)\s+me\b/i,
  /\bmy\s+(?:role|grants?|permissions?)\b/i,
];

/** The words of the first grant talk a reply holds, or null. */
export function grantTalkIn(text: string): string | null {
  const screened = permissionTalkIn(text);
  if (screened) return screened;
  for (const form of GRANT_TALK) {
    const found = form.exec(text);
    if (found) return found[0];
  }
  return null;
}

/** Not the agent's own act: "I will change the settings" tells what it does, and directs nobody. */
const NOT_SELF_VI = '(?<!(?:em|mình|tôi|bot)\\s+(?:sẽ\\s+|đã\\s+|vừa\\s+|đang\\s+)?)'; // i18n-allow: the Vietnamese first person a direction is told from
const NOT_SELF_EN = "(?<!\\bI(?:'ll|'ve|\\s+will|\\s+can|\\s+have)?\\s+)";

/** The forms a direction to press, open or change something on a screen takes. */
const DIRECTIONS: readonly RegExp[] = [
  new RegExp(`${START}(?:bấm|nhấn|ấn|click)\\s+(?:vào\\s+|chọn\\s+|nút\\s+)*["'“‘«]`, 'iu'), // i18n-allow: the Vietnamese phrasing being recorded
  new RegExp(
    `${START}${NOT_SELF_VI}(?:vào|mở|sửa|đổi|chỉnh)\\s+(?:lại\\s+)?(?:trang\\s+|phần\\s+|mục\\s+|màn\\s+hình\\s+)?(?:cài\\s+đặt|thiết\\s+lập|settings?|giao\\s+diện)`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  // making the record themselves in a section of a screen: "you create it in the Feedback section",
  // as Babo told the owner on 17/11 at 05:55 and 05:58 (ISS-1251 c11)
  new RegExp(
    `${START}${NOT_SELF_VI}(?:tạo|ghi|thêm|gửi|nhập)\\s+(?:giúp\\s+|thẳng\\s+|trực\\s+tiếp\\s+|luôn\\s+)*(?:ở|trong|tại|vào)\\s+(?:mục|trang|phần|tab|màn\\s+hình)\\s`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  new RegExp(
    `${NOT_SELF_EN}\\b(?:create|file|add|submit)\\s+(?:it|them|this|one)?\\s*(?:yourself\\s+)?(?:in|under|from)\\s+(?:the\\s+)?[\\w-]+\\s+(?:section|page|screen|tab)\\b`,
    'i',
  ),
  /\b(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?["'“‘]/i,
  new RegExp(
    `${NOT_SELF_EN}\\b(?:go\\s+to|open|head\\s+to|change|edit)\\s+(?:the\\s+)?(?:[\\w-]+\\s+){0,3}?(?:settings|page|screen|tab)\\b`,
    'i',
  ),
];

/** Forge named as a word of its own: "on Forge", never inside a name such as forge-ops. */
const FORGE_NAMED = /(?<![\p{L}\p{N}_-])forge(?![\p{L}\p{N}_-])/iu;

/**
 * The words of the first direction a reply gives to a screen, or null. Outside an operations room
 * (Forge's own), where a product's users may ask how to use its screens, only a sentence naming Forge.
 */
export function uiDirectionIn(text: string, forgeRoom: boolean): string | null {
  for (const sentence of text.split(/(?<=[.!?…\n])/u)) {
    // i18n-allow: the Vietnamese phrasing being recorded
    if (!forgeRoom && !FORGE_NAMED.test(sentence)) continue;
    for (const form of DIRECTIONS) {
      const found = form.exec(sentence);
      if (found) return found[0];
    }
  }
  return null;
}

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** The API's public hosts that are not also the web app's. */
export function apiHosts(): string[] {
  const web = new Set(
    [env.APP_BASE_URL, ...env.CORS_ORIGINS.split(',').map((o) => o.trim())]
      .map(hostOf)
      .filter((h): h is string => h !== null),
  );
  const api = [env.PUBLIC_API_BASE_URL, env.OAUTH_REDIRECT_BASE].map(hostOf);
  return [...new Set(api.filter((h): h is string => h !== null && !web.has(h)))];
}

const LINK = /https?:\/\/[^\s<>()"'`]+/giu;

/** The first link in `text` on one of `hosts`, or null. */
export function apiHostLinkIn(text: string, hosts: readonly string[]): string | null {
  if (hosts.length === 0) return null;
  for (const [link] of text.matchAll(LINK)) {
    if (hosts.includes(hostOf(link) ?? '')) return link;
  }
  return null;
}

/**
 * A statement of how a live setting, account or field stands (ISS-1354, FB-763): "there is no
 * PGPrints API account", "the store_id field is there", "it is enabled"; or of where a Forge record
 * stands (ISS-1389, FB-801): "the release's issues are closed", "ISS-21 is deployed". Words of a
 * state, never a plan: what the agent will do is no claim about what stands.
 */
const RECORD_NOUN_VI = '(?:issue|release|bản\\s+phát\\s+hành|phiên\\s+bản|ticket)'; // i18n-allow: the Vietnamese nouns of a Forge record a claim names
const STATE_NOUN_VI =
  '(?:tài\\s+khoản|account|ô|trường|field|cấu\\s+hình|thiết\\s+lập|key|khóa|dịch\\s+vụ|service|nhà\\s+cung\\s+cấp|supplier|store|cửa\\s+hàng|API)'; // i18n-allow: the Vietnamese nouns of a setting a claim names
const STATE_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `${START}(?:không|chưa|đã|vẫn|đang)\\s+(?:có|được)\\s+(?:sẵn\\s+)?${STATE_NOUN_VI}(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  new RegExp(`${START}có\\s+sẵn\\s+${STATE_NOUN_VI}(?![\\p{L}\\p{N}_])`, 'iu'), // i18n-allow: the Vietnamese phrasing being recorded
  new RegExp(
    `${START}(?:đã|đang|chưa|vẫn)\\s+(?:được\\s+)?(?:bật|tắt|cấu\\s+hình|thiết\\s+lập|kích\\s+hoạt)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  /\b(?:has|have|had)\s+no\s+(?:[\w-]+\s+){0,3}?(?:account|field|setting|key|credential|service|supplier)s?\b/i,
  /\bthere\s+(?:is|are)\s+(?:no|already\s+an?|an?)\s+(?:[\w-]+\s+){0,3}?(?:account|field|setting|key|service|supplier)s?\b/i,
  // ISS-1430: a restated earlier read is said in the past tense ("was off"), and on or off stands bare
  /\b(?:is|are|was|were|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\s+(?:now\s+|already\s+|still\s+)?(?:not\s+)?(?:enabled|disabled|turned\s+on|turned\s+off|configured|set\s+up)\b/i,
  /\b(?:is|are|was|were|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\s+(?:now\s+|already\s+|still\s+)?(?:not\s+)?(?:on|off)\b(?=\s*(?:[.,;:!?)\n]|$)|\s+(?:as\s+of|at|since|now|again|yet|(?:on|in)\s+(?:staging|production|prod))\b)/i,
  /\b(?:issues?|tickets?|release|ISS-\d+|v?\d+\.\d+\.\d+)\b[^.!?\n]{0,60}?\b(?:is|are|was|were|has\s+been|have\s+been)\s+(?:all\s+|now\s+|already\s+|still\s+)?(?:not\s+)?(?:closed|open|shipped|deployed|released|live|merged)\b/i,
  new RegExp(
    `${RECORD_NOUN_VI}\\b(?:[^.!?\\n]|\\d\\.\\d){0,60}?(?:đã|đang|chưa|vẫn)\\s+(?:được\\s+)?(?:đóng|mở|deploy|release|merge|phát\\s+hành)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
];

/**
 * A state said from a dated read (ISS-1430, L-167's "worker limit as of 11:02 UTC"): "as of" a time or
 * a last read, in English or Vietnamese. With no read of its turn, it is an earlier read restated.
 */
const DATED_CLAIMS: readonly RegExp[] = [
  /\b(?:as\s+of|(?:per|from|at)\s+(?:my|the)\s+(?:last|earlier|previous))\s+(?:\d{1,2}[:h]\d{2}(?:\s*UTC)?|\d{4}-\d{2}-\d{2}|read|check)\b[^.!?\n]{0,60}/i,
  new RegExp(
    `${START}(?:tính\\s+đến|theo\\s+lần\\s+(?:đọc|kiểm\\s+tra)\\s+(?:trước|gần\\s+nhất|lúc))(?![\\p{L}\\p{N}_])[^.!?\\n]{0,60}`, // i18n-allow: the Vietnamese "as of" being recorded
    'iu',
  ),
];

/** The words of the first statement of a live setting's, account's or Forge record's state a reply makes, or null. */
export function liveStateClaimIn(text: string): string | null {
  for (const form of [...STATE_CLAIMS, ...DATED_CLAIMS]) {
    const found = form.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}

/**
 * The words of the first live state a reply asserts (ISS-1430): its setting, account and record
 * states, and the `extra` forms (`live-claims.ts:LIVE_CLAIM_RE`), each skipped where a plain "not
 * checked now" only asks after it (`not-checked.ts`). Null where it asserts none.
 */
export function assertedStateClaimIn(text: string, extra: readonly RegExp[] = []): string | null {
  return firstAssertedIn(text, [...STATE_CLAIMS, ...DATED_CLAIMS, ...extra]);
}

/**
 * A statement of what a deployment serves: which sites or environments run a version ("no site runs
 * this version", a Vietnamese twin). ISS-1440 (FB-837): stated with no read of what is
 * served, since neither `LIVE_CLAIM_RE` nor the setting forms had a word of it.
 */
const SERVED_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `${START}(?:site|trang|website|server|máy\\s+chủ|môi\\s+trường|staging|production|prod)\\s+(?:nào\\s+)?(?:đang\\s+|đã\\s+|chưa\\s+|vẫn\\s+)?(?:chạy|dùng)\\s+(?:bản|phiên\\s+bản|version)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  new RegExp(
    `${START}(?:đang|vẫn)\\s+chạy\\s+(?:bản|phiên\\s+bản|version)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  /\b(?:no|every|all|any|none\s+of\s+the)\s+(?:sites?|servers?|environments?|stagings?|productions?)\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+|yet\s+)?(?:running|serving|runs?|serves?|on)\s+(?:this\s+|the\s+|that\s+)?(?:version|build|release|v?\d)/i,
  /\b(?:is|are|was|were|still|now)\s+(?:running|serving)\s+(?:version|build|v?\d+\.\d+)/i,
];

/**
 * A statement of how a product behaves now (ISS-1440): "Force Update works", "the cleanup removed 12
 * rows". Said from a master's report or a release as shipped, it is not a read of the product.
 */
const BEHAVIOUR_CLAIMS: readonly RegExp[] = [
  /\b(?:(?:is|are|now|already|still)\s+(?:working|fixed)|(?:now|already|still)\s+works|works\s+(?:correctly|fine|well|properly|as\s+expected|now)|(?:does\s+not|doesn['’]t)\s+work|not\s+working)\b/i,
  /\b(?:cleaned\s+up|removed|deleted|purged)\s+\d+\b/i,
  new RegExp(
    `${START}(?:(?:đã|đang|vẫn|chưa|không)\\s+hoạt\\s+động|hoạt\\s+động\\s+(?:tốt|đúng|bình\\s+thường|ổn)|chạy\\s+(?:đúng|tốt|ổn))(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  new RegExp(`${START}(?:đã\\s+)?(?:dọn|xóa|xoá)\\s+(?:sạch\\s+)?\\d+`, 'iu'), // i18n-allow: the Vietnamese phrasing being recorded
];

/** The words of the first statement of what a deployment serves a reply asserts, or null. */
export function servedClaimIn(text: string, extra: readonly RegExp[] = []): string | null {
  return firstAssertedIn(text, [...SERVED_CLAIMS, ...extra]);
}

/** The words of the first statement of how a product behaves now a reply asserts, or null. */
export function behaviourClaimIn(text: string): string | null {
  return firstAssertedIn(text, BEHAVIOUR_CLAIMS);
}

/** A reply that names the master as the one who checked: a state said as his, never as the agent's read. */
const MASTER_NAMED = /(?<![\p{L}\p{N}_])(?:the\s+)?(?:master|đội|team|owner)(?![\p{L}\p{N}_])/iu; // i18n-allow: the Vietnamese "team" a master's check is told as
export const namesMaster = (text: string): boolean => MASTER_NAMED.test(text);

/**
 * A report that an act was taken somewhere else (ISS-1416, FB-824): a need raised, posted, passed or
 * asked in another thread, channel, or of a team, master or owner. "The host step was already raised
 * in AdminHub API's technical thread" was told when that raise had been refused. Never a plan ("I
 * will raise it"), nor one not taken ("not raised yet").
 */
const ACT_PLACE_VI = '(?:thread|luồng|kênh|channel|team|đội|master|owner|kỹ\\s+thuật)'; // i18n-allow: the Vietnamese places an act is reported landed in
const ACT_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `${START}(?:đã|vừa)\\s+(?:được\\s+)?(?:báo|gửi|chuyển|nêu|hỏi|nhắn|đăng|raise|post|escalate)(?![\\p{L}\\p{N}_])[^.!?\\n]{0,60}?${ACT_PLACE_VI}(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  /(?<!(?:\bnot|\bnever|\bbe|(?:\bnot|\bnever|n't)\s+(?:yet\s+)?been)\s+)\b(?:raised|posted|passed|forwarded|escalated|flagged|handed)\b[^.!?\n]{0,60}?\b(?:thread|channel|team|master|owner)s?\b/i,
];

/** The words of the first report of an act taken somewhere else a reply makes, or null. */
export function actClaimIn(text: string): string | null {
  for (const form of ACT_CLAIMS) {
    const found = form.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}

/** The things of a screen a claim names, in Vietnamese and English. */
const SCREEN_THING_VI = '(?:mục|nút|ô|trường|trang|tab|menu|màn\\s+hình|cột|biểu\\s+mẫu|form)'; // i18n-allow: the Vietnamese words for the things of a screen
const SCREEN_THING_EN =
  '(?:button|menu(?:\\s+item)?|field|tab|page|screen|column|link|item|option)';

/**
 * A claim about what a person will see on a screen (ISS-1356): an item that shows, appears, is
 * hidden or sits somewhere. Not a plan, and not "I have not seen this screen yet", which is the
 * honest line when no look was taken.
 */
const SCREEN_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `${START}${SCREEN_THING_VI}\\s+[^.!?\\n]{0,80}?(?:hiện|hiển\\s+thị|xuất\\s+hiện|bị\\s+ẩn|ẩn\\s+đi|đang\\s+ẩn|nằm\\s+(?:ở|trong|dưới|trên))(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  new RegExp(`${START}(?:sẽ\\s+)?thấy\\s+(?:ngay\\s+)?${SCREEN_THING_VI}(?![\\p{L}\\p{N}_])`, 'iu'), // i18n-allow: the Vietnamese phrasing being recorded
  new RegExp(
    `\\b${SCREEN_THING_EN}s?\\b[^.!?\\n]{0,80}?\\b(?:appears?|shows?\\s+up|is\\s+(?:now\\s+)?(?:shown|visible|hidden|there)|will\\s+(?:appear|show))\\b`,
    'i',
  ),
  /\byou(?:'ll|\s+will|\s+should)?\s+(?:now\s+)?see\s+(?:the|a|an)\s+[^.!?\n]{1,80}/i,
];

/** The words of the first claim a reply makes about what a screen shows, or null. */
export function screenClaimIn(text: string): string | null {
  for (const form of SCREEN_CLAIMS) {
    const found = form.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}

/**
 * A reply correcting what the room said before (ISS-1356 c4): a Vietnamese "let me correct" or
 * "correction", or "I was wrong". Counted per turn on the room's day.
 */
const CORRECTIONS: readonly RegExp[] = [
  new RegExp(
    `${START}(?:xin\\s+)?(?:sửa\\s+lại|đính\\s+chính|nói\\s+lại\\s+cho\\s+đúng)(?![\\p{L}\\p{N}_])|${START}em\\s+(?:đã\\s+)?(?:nhầm|nói\\s+sai|báo\\s+sai)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese phrasing being recorded
    'iu',
  ),
  /\b(?:correction:|(?:let me correct|I was wrong|I misspoke|to correct my (?:last|earlier|previous))\b)/i,
];

/** The words of a correction of an earlier post a reply makes, or null. */
export function correctionIn(text: string): string | null {
  for (const form of CORRECTIONS) {
    const found = form.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}

/**
 * A step working around the screen (ISS-1356 c3): an address edited by hand, as the PGPrints guide's
 * step 3 had the user type `?tab=2` into the address bar. A screen that needs one is a UI defect for
 * the project's master, never a step a person is sent.
 */
const WORKAROUNDS: readonly RegExp[] = [
  /\?[\w-]+=[\w-]+[^.!?\n]{0,60}?(?:thanh\s+địa\s+chỉ|address\s+bar|URL)/iu, // i18n-allow: the Vietnamese phrasing being recorded
  /(?:thanh\s+địa\s+chỉ|address\s+bar)[^.!?\n]{0,60}?\?[\w-]+=[\w-]+/iu, // i18n-allow: the Vietnamese phrasing being recorded
  /\b(?:add|append|type)\s+[`'"“]?\?[\w-]+=[\w-]+/i,
  new RegExp(`${START}(?:thêm|gõ|nhập)\\s+[\`'"“]?\\?[\\w-]+=[\\w-]+`, 'iu'), // i18n-allow: the Vietnamese phrasing being recorded
];

/** The words of the first workaround step a reply sends a person, or null. */
export function workaroundIn(text: string): string | null {
  for (const form of WORKAROUNDS) {
    const found = form.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}
