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
