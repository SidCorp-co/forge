// The rubric lines code can tell in a reply already posted (ISS-1250), recorded beside the agent's own
// audit so its verdict is true where the agent missed one. They never screen, hold or rewrite a post
// (owner 2026-11-16, "teach the flow, not block it"): the pre-send screen for grant talk is
// `permission-talk.ts`, read here as it stands, and these forms are what the audit adds to it.

import { env } from '../../lib/env.js';
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
 * PGPrints API account", "the store_id field is there", "it is enabled". Words of a state, never a
 * plan: what the agent will do is no claim about what stands.
 */
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
  /\b(?:is|are)\s+(?:now\s+|already\s+|still\s+)?(?:not\s+)?(?:enabled|disabled|turned\s+on|turned\s+off|configured|set\s+up)\b/i,
];

/** The words of the first statement of a live setting's or account's state a reply makes, or null. */
export function liveStateClaimIn(text: string): string | null {
  for (const form of STATE_CLAIMS) {
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
