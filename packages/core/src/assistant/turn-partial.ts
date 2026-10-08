// What a turn posts when it runs past its first ceiling and keeps working: the writes that landed,
// with the keys they returned, then what it read, counted by tool in plain words ("ran 3 reports,
// drew 2 tables"), and that the rest follows in this thread. Code writes it from the turn's own
// ledger, so it states nothing the turn did not do. A call's arguments and its result are never
// quoted: they are the asker's, the whole room reads this message, and JSON is not a sentence.

import { partialReplyWords, type ReplyLanguage } from '../conversations/index.js';
import { type DoneCall, isProposalCall } from './turn-writes.js';

const NAMED_WRITES = 10;
const CLI_TOOL = 'forge';

type Words = Record<ReplyLanguage, (n: number) => string>;

const times: Record<ReplyLanguage, (n: number) => string> = {
  en: (n) => (n === 1 ? '' : n === 2 ? ' twice' : ` ${n} times`),
  vi: (n) => (n === 1 ? '' : ` ${n} lần`), // i18n-allow: user-facing channel reply
};

/** One phrase per kind of read, counted. A tool missing here is named by its own name, in words. */
const READS: Record<string, Words> = {
  status: {
    en: (n) => `read the project status${times.en(n)}`,
    vi: (n) => `đọc tình trạng dự án${times.vi(n)}`, // i18n-allow: user-facing channel reply
  },
  reports: {
    en: (n) => `ran ${n} report${n === 1 ? '' : 's'}`,
    vi: (n) => `chạy ${n} báo cáo`, // i18n-allow: user-facing channel reply
  },
  compute: {
    en: (n) => `ran ${n} computation${n === 1 ? '' : 's'}`,
    vi: (n) => `chạy ${n} phép tính`, // i18n-allow: user-facing channel reply
  },
  tracker: {
    en: (n) => `looked up the tracker${times.en(n)}`,
    vi: (n) => `tra cứu tracker${times.vi(n)}`, // i18n-allow: user-facing channel reply
  },
  knowledge: {
    en: (n) => `read the project knowledge${times.en(n)}`,
    vi: (n) => `đọc tri thức dự án${times.vi(n)}`, // i18n-allow: user-facing channel reply
  },
  memory: {
    en: (n) => `searched project memory${times.en(n)}`,
    vi: (n) => `tìm trong bộ nhớ dự án${times.vi(n)}`, // i18n-allow: user-facing channel reply
  },
};

const READ_KIND: Readonly<Record<string, string>> = {
  forge_project_status: 'status',
  forge_template: 'reports',
  forge_report: 'reports',
  forge_compute: 'compute',
  forge_knowledge: 'knowledge',
  forge_memory: 'memory',
  forge_memory_search: 'memory',
  [CLI_TOOL]: 'tracker',
};

/** What `forge_show` drew, by block kind; a kind missing here is a "block". */
const DRAWN: Record<string, Record<ReplyLanguage, (n: number) => string>> = {
  table: { en: (n) => `${n} table${n === 1 ? '' : 's'}`, vi: (n) => `${n} bảng` }, // i18n-allow: user-facing channel reply
  chart: { en: (n) => `${n} chart${n === 1 ? '' : 's'}`, vi: (n) => `${n} biểu đồ` }, // i18n-allow: user-facing channel reply
  flow: { en: (n) => `${n} diagram${n === 1 ? '' : 's'}`, vi: (n) => `${n} sơ đồ` }, // i18n-allow: user-facing channel reply
  timeline: { en: (n) => `${n} timeline${n === 1 ? '' : 's'}`, vi: (n) => `${n} dòng thời gian` }, // i18n-allow: user-facing channel reply
  kpi: { en: (n) => `${n} set${n === 1 ? '' : 's'} of figures`, vi: (n) => `${n} bộ số liệu` }, // i18n-allow: user-facing channel reply
  'status-list': {
    en: (n) => `${n} status list${n === 1 ? '' : 's'}`,
    vi: (n) => `${n} danh sách trạng thái`, // i18n-allow: user-facing channel reply
  },
  block: { en: (n) => `${n} block${n === 1 ? '' : 's'}`, vi: (n) => `${n} khối` }, // i18n-allow: user-facing channel reply
};
const DREW: Record<ReplyLanguage, string> = { en: 'drew', vi: 'vẽ' }; // i18n-allow: user-facing channel reply
const AND: Record<ReplyLanguage, string> = { en: 'and', vi: 'và' }; // i18n-allow: user-facing channel reply

/** The writes, by tool, and for the CLI by its verb. */
const WRITES: Record<string, Record<ReplyLanguage, string>> = {
  forge_feedback: { en: 'recorded feedback', vi: 'ghi nhận góp ý' }, // i18n-allow: user-facing channel reply
  forge_requirement_draft: { en: 'drafted a requirement', vi: 'soạn requirement' }, // i18n-allow: user-facing channel reply
  forge_requirement_revise: { en: 'revised a requirement', vi: 'sửa requirement' }, // i18n-allow: user-facing channel reply
  forge_memory_note: { en: 'noted it in project memory', vi: 'ghi vào bộ nhớ dự án' }, // i18n-allow: user-facing channel reply
  forge_preferences: { en: 'saved a preference', vi: 'lưu tùy chọn' }, // i18n-allow: user-facing channel reply
  'forge comment': { en: 'commented', vi: 'bình luận' }, // i18n-allow: user-facing channel reply
  'forge attach': { en: 'attached a file', vi: 'đính kèm tệp' }, // i18n-allow: user-facing channel reply
  'forge issue': { en: 'updated an issue', vi: 'cập nhật issue' }, // i18n-allow: user-facing channel reply
};
const USED: Record<ReplyLanguage, string> = { en: 'used', vi: 'dùng' }; // i18n-allow: user-facing channel reply

/** A tool's name as words: no server prefix, no `forge_`, spaces for underscores. */
function plainName(name: string): string {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/^forge_/, '');
  return bare.replace(/[_-]+/g, ' ').trim() || name;
}

function parsedArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The block kind a `forge_show` call drew, or "block" where its arguments name none this file knows. */
function drawnKind(argsJson: string): string {
  const kind = (parsedArgs(argsJson)?.block as { kind?: unknown } | undefined)?.kind;
  return typeof kind === 'string' && Object.hasOwn(DRAWN, kind) ? kind : 'block';
}

function writeKey(c: DoneCall): string {
  if (c.name !== CLI_TOOL) return c.name;
  const argv = parsedArgs(c.arguments)?.argv;
  return Array.isArray(argv) && typeof argv[0] === 'string' ? `${CLI_TOOL} ${argv[0]}` : CLI_TOOL;
}

function writeLine(c: DoneCall, language: ReplyLanguage): string {
  const said = WRITES[writeKey(c)]?.[language] ?? `${USED[language]} ${plainName(c.name)}`;
  return c.keys.length > 0 ? `- ${said} → ${c.keys.join(', ')}` : `- ${said}`;
}

const joined = (parts: readonly string[], language: ReplyLanguage): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} ${AND[language]} ${parts.at(-1)}`;

/** The reads, counted by kind in the order each kind was first done, as one sentence. */
export function readsSaid(calls: readonly DoneCall[], language: ReplyLanguage): string | null {
  const counts = new Map<string, number>();
  const drawn = new Map<string, number>();
  for (const c of calls) {
    if (c.name === 'forge_show') {
      if (!counts.has('show')) counts.set('show', 0);
      const kind = drawnKind(c.arguments);
      drawn.set(kind, (drawn.get(kind) ?? 0) + 1);
      continue;
    }
    const key = isProposalCall(c.name, c.arguments)
      ? `tool:${CLI_TOOL} issue`
      : (READ_KIND[c.name] ?? `tool:${c.name}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()].map(([key, n]) => {
    if (key === 'show') {
      const kinds = [...drawn.entries()].map(([kind, k]) => (DRAWN[kind] as Words)[language](k));
      return `${DREW[language]} ${joined(kinds, language)}`;
    }
    const words = READS[key];
    if (words) return words[language](n);
    return `${USED[language]} ${plainName(key.slice('tool:'.length))}${times[language](n)}`;
  });
  return `${parts.join(', ')}.`;
}

/** The calls that landed, writes first with the keys they returned, then the reads; empty when none did. */
export function ledgerLines(calls: readonly DoneCall[], language: ReplyLanguage): string[] {
  const words = partialReplyWords(language);
  const writes = calls.filter((c) => c.write);
  const reads = readsSaid(
    calls.filter((c) => !c.write),
    language,
  );
  const lines: string[] = [];
  if (writes.length > 0) {
    lines.push(words.did, ...writes.slice(-NAMED_WRITES).map((c) => writeLine(c, language)));
  }
  if (reads) {
    if (lines.length > 0) lines.push('');
    lines.push(`${words.read} ${reads}`);
  }
  return lines;
}

export function partialReplyText(args: {
  calls: readonly DoneCall[];
  language: ReplyLanguage;
  handleName: string;
  waitedMs: number;
}): string {
  const words = partialReplyWords(args.language);
  const head = words.head(args.handleName, Math.round(args.waitedMs / 1000));
  const ledger = ledgerLines(args.calls, args.language);
  return [head, '', ...(ledger.length > 0 ? ledger : [words.nothingYet])].join('\n');
}
