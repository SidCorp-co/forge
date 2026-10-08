/**
 * Which numbers in a chat reply are figures it states, for `figures-rule.ts` to hold to a report run.
 *
 * A number is NOT a figure where it is a date, an ordinal, a version string, an id, inside a quoted
 * source, or a number the person typed in the question said back as theirs (`saidBackAt`): named as
 * the person's, or declined. Stated as the project's, the person's number is a figure like any other
 * (REQ-32 BC-6): what someone typed is not evidence about the project. The table is the whole of that exemption: each
 * row names what it exempts, a reply whose every figure that row alone exempts, and the pattern;
 * `figure-exemptions.test.ts` reads every row both ways — its example passes with the table, and is
 * held without that row.
 *
 * In prose, a number is a figure only where it is said as one: a percentage, a ratio, a count of
 * tracked things or of days, weeks or months, a count of a state (17 shipped), or a total. The
 * grammar abstains by default, as `grounding-rule.ts` does: a reply states sizes, ports, line numbers
 * and timeouts that no report holds, and at a door with no repair a false refusal costs the answer.
 * A block's text is read without the grammar: any number typed there is a figure.
 */

// every Vietnamese regex below carries its `i18n-allow` pragma on its own line: the language gate reads it same-line only.

interface PatternExemption {
  readonly id: string;
  /** Why a number here is not a figure the reply states. */
  readonly why: string;
  /** A reply whose every number this row alone exempts. */
  readonly example: string;
  readonly re: RegExp;
}

interface AskedExemption {
  readonly id: 'asked';
  readonly why: string;
  readonly example: string;
  /** The question the example answers: its numbers are the person's own. */
  readonly ask: string;
}

export type FigureExemption = PatternExemption | AskedExemption;

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?';
const DAY_SUFFIX = '(?:st|nd|rd|th)?';

const QUOTED = [
  '```[\\s\\S]*?```',
  '`[^`\\n]+`',
  '^[ \\t]*>.*$',
  '“[^”\\n]*\\s[^”\\n]*”',
  '"[^"\\n]*\\s[^"\\n]*"',
  '«[^»\\n]*»',
].join('|');

const IDS = [
  '\\b[A-Z][A-Z0-9]{1,9}-\\d{1,6}\\b',
  '#\\d+\\b',
  '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
  '\\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\\d)[0-9a-f]{7,40}\\b',
  '\\b[A-Za-z_]+\\d[\\w.-]*',
  '\\b\\d+_\\w[\\w.-]*',
].join('|');

const VERSIONS = [
  '\\bv?\\d+(?:\\.\\d+){2,}(?:[-+][0-9A-Za-z.-]+)?',
  '\\b(?:version|release)\\s+v?\\d+(?:\\.\\d+)+',
  '(?:phiên\\s+bản|bản)\\s+v?\\d+(?:\\.\\d+)+', // i18n-allow: the Vietnamese words a version is named with
].join('|');

const DATES = [
  '\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?',
  '\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b',
  `\\b${MONTH}\\s+\\d{1,2}${DAY_SUFFIX}(?:,?\\s+\\d{4})?\\b`,
  `\\b\\d{1,2}${DAY_SUFFIX}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?`,
  `\\b${MONTH}\\s+\\d{4}\\b`,
  '\\b\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]\\.?m\\.?)?',
  '\\b\\d{1,2}\\s*[ap]\\.?m\\b',
  '\\b(?:199\\d|20\\d{2})\\b(?![.,]\\d|\\s*%)',
  '(?:ngày\\s+)?\\d{1,2}\\s+tháng\\s+\\d{1,2}(?:\\s+năm\\s+\\d{4})?', // i18n-allow: the Vietnamese long date form
  'ngày\\s+\\d{1,2}\\/\\d{1,2}', // i18n-allow: the Vietnamese short date form
  'tháng\\s+\\d{1,2}(?:\\s*(?:\\/|năm)\\s*\\d{4})?|năm\\s+\\d{4}', // i18n-allow: a Vietnamese month or year
].join('|');

const ORDINALS = [
  `\\b\\d+(?:st|nd|rd|th)\\b`,
  '^[ \\t]*\\d+[.)](?=[ \\t])',
  '\\b(?:step|phase|stage|round|wave|lane|part|item|option|attempt|tier|level|chapter|section|page|line|row|column|week|sprint|iteration|port|no\\.)\\s+\\d+\\b',
  '(?:thứ|lần(?:\\s+thứ)?|bước|giai\\s+đoạn|vòng|tuần|mục|phần|hàng|dòng|trang|phương\\s+án)\\s+\\d+', // i18n-allow: the Vietnamese words an ordinal follows
].join('|');

export const FIGURE_EXEMPTIONS: readonly FigureExemption[] = [
  {
    id: 'quoted-source',
    why: 'a number inside a quotation, a code span or a quoted line is the source speaking, not the reply',
    example: 'The comment says "42 issues are left", and the log line is `17 shipped`.',
    re: new RegExp(QUOTED, 'gm'),
  },
  {
    id: 'link',
    why: 'a number inside a link is part of an address',
    example: 'The board is at https://forge.example/b/42-issues and lists them.',
    re: /\bhttps?:\/\/[^\s)>\]]+|\]\([^)\s]+\)/g,
  },
  {
    id: 'date',
    why: 'a date or a time names a moment; a stated tracker date is held by tracker-facts-grounded',
    example: 'The 2026 releases start on 2026-07-15 at 14:30, the next on Oct 20, 2026.',
    re: new RegExp(DATES, 'gi'),
  },
  {
    id: 'id',
    why: 'an issue key, a pull request number, a uuid, a commit sha or a name holding digits is an id, not a quantity',
    example: 'The REQ-3 criteria and the ISS-12 tasks are linked; #835 items merged at 95e50217c.',
    re: new RegExp(IDS, 'g'),
  },
  {
    id: 'version',
    why: 'a version string names a build',
    example: 'The release 0.4 items landed in 0.4.0-dev.172.',
    re: new RegExp(VERSIONS, 'gi'),
  },
  {
    id: 'ordinal',
    why: 'an ordinal or a list number gives a position, not a quantity',
    example: '1. The 2nd item, then the step 3 tasks.',
    re: new RegExp(ORDINALS, 'gim'),
  },
  {
    id: 'asked',
    why: 'a count the person typed in the question, said back as theirs or declined, is not the reply stating it',
    example: 'Here are the 5 oldest open items you asked for.',
    ask: 'Show me the 5 oldest open items.',
  },
];

/** The text with every span a pattern row matches blanked in place, so offsets still point into it. */
export function blankExempt(
  text: string,
  table: readonly FigureExemption[] = FIGURE_EXEMPTIONS,
): string {
  let out = text;
  for (const row of table) {
    if (!('re' in row)) continue;
    out = out.replace(row.re, (m) => m.replace(/[^\n]/g, ' '));
  }
  return out;
}

/** A number as written, with every value it can be read as and the decimals each reading states. */
export interface StatedFigure {
  readonly quote: string;
  readonly index: number;
  readonly readings: readonly { readonly value: number; readonly decimals: number }[];
}

const FIGURE_RE = /(?<![\w])\d+(?:[.,]\d+)*(?:\s?%)?/g;

/**
 * Every value `digits` can be read as. A comma or a stop between digit groups is a thousands mark in
 * one language and a decimal mark in the other (1,234 and 1.234; 41,7), so both readings are kept and
 * a figure is grounded when either is.
 */
export function readingsOf(digits: string): { value: number; decimals: number }[] {
  if (/^\d+$/.test(digits)) return [{ value: Number(digits), decimals: 0 }];
  const out: { value: number; decimals: number }[] = [];
  const add = (whole: string, frac: string) => {
    const value = Number(frac ? `${whole}.${frac}` : whole);
    if (Number.isFinite(value)) out.push({ value, decimals: frac.length });
  };
  for (const [group, decimal] of [
    [',', '.'],
    ['.', ','],
  ] as const) {
    const g = group === '.' ? '\\.' : group;
    const d = decimal === '.' ? '\\.' : decimal;
    const grouped = new RegExp(`^(\\d{1,3}(?:${g}\\d{3})+)(?:${d}(\\d+))?$`).exec(digits);
    if (grouped) add((grouped[1] ?? '').split(group).join(''), grouped[2] ?? '');
    const plain = new RegExp(`^(\\d+)${d}(\\d+)$`).exec(digits);
    if (plain) add(plain[1] ?? '', plain[2] ?? '');
  }
  return out;
}

/** The clauses a reply asks rather than states, blanked: a number in a question is not a claim. */
function blankQuestions(text: string): string {
  return text.replace(/[^.!?\n]*\?/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Every number the text holds after the table's patterns and its questions are blanked, each place it stands. */
function numbersIn(scan: string): StatedFigure[] {
  const out: StatedFigure[] = [];
  for (const m of scan.matchAll(FIGURE_RE)) {
    const quote = m[0].trim();
    const readings = readingsOf(quote.replace(/\s?%$/, ''));
    if (readings.length > 0) out.push({ quote, index: m.index ?? 0, readings });
  }
  return out;
}

const once = (figures: StatedFigure[]): StatedFigure[] => {
  const seen = new Set<string>();
  return figures.filter((f) => !seen.has(f.quote) && seen.add(f.quote));
};

const scanOf = (text: string, table: readonly FigureExemption[]): string =>
  blankQuestions(blankExempt(text.normalize('NFC'), table));

/** Every number the text states, once each, read without the prose grammar: a block's text and a frame's cells. */
export function figuresIn(
  text: string,
  table: readonly FigureExemption[] = FIGURE_EXEMPTIONS,
): StatedFigure[] {
  return once(numbersIn(scanOf(text, table)));
}

const COUNT_HEAD_EN =
  'issues?|items?|tasks?|tickets?|requirements?|criteri(?:on|a)|BCs?|releases?|features?|bugs?|defects?|feedback|workflows?|risks?|blockers?|markers?|stories|story|epics?|milestones?|deliverables?|days?|weeks?|months?|' +
  'shipped|done|open|closed|merged|remaining|left|late|overdue|blocked|waiting|released|delivered|proven|unproven|covered|uncovered|complete|completed|pending|outstanding|in\\s+progress';
const COUNT_HEAD_VI =
  'issue|việc|công\\s+việc|đầu\\s+việc|yêu\\s+cầu|tiêu\\s+chí|bản\\s+phát\\s+hành|lần\\s+phát\\s+hành|tính\\s+năng|lỗi|phản\\s+hồi|luồng|quy\\s+trình|rủi\\s+ro|điểm\\s+chặn|mục|ngày|tuần|tháng|đã\\s+xong|hoàn\\s+thành|đang\\s+làm|còn\\s+lại|bị\\s+chặn|đang\\s+chờ|bị\\s+trễ|trễ'; // i18n-allow: the Vietnamese nouns and states a count is said of
const RANGE_TAIL = '(?:\\s*(?:–|—|-|to|đến|tới)\\s*\\d+(?:[.,]\\d+)*)?'; // i18n-allow: the Vietnamese range words
/** After a number: a percent sign or word, or a count head within two words. */
const SAID_AFTER = new RegExp(
  `^(?:\\s?%|\\s+(?:percent|per\\s+cent|phần\\s+trăm)|${RANGE_TAIL}(?:[\\s-]+[\\p{L}'’]+){0,2}?[\\s-]+(?:${COUNT_HEAD_EN}|${COUNT_HEAD_VI})(?![\\p{L}]))`, // i18n-allow: the Vietnamese percent word
  'iu',
);
/** Before a number: a total, or the other side of a ratio. */
const SAID_BEFORE =
  /(?:\b(?:total|count|sum|average|mean|median|overall)|tổng(?:\s+(?:số|cộng))?|trung\s+bình|đã\s+xong|còn\s+lại|\d\s*(?:\/|of|out\s+of|trên))[\s:=]*(?:[\p{L}]+\s+){0,2}$/iu; // i18n-allow: the Vietnamese words a total is said with
/** After a number: the other side of a ratio. */
const RATIO_AFTER = /^\s*(?:\/|of|out\s+of|trên)\s*\d/iu; // i18n-allow: the Vietnamese ratio word

/** Whether the number at `index` in `scan` is said as a figure: a percentage, a ratio, a count or a total. */
function saidAsFigure(scan: string, index: number, quote: string): boolean {
  if (quote.endsWith('%')) return true;
  const after = scan.slice(index + quote.length, index + quote.length + 80);
  if (SAID_AFTER.test(after) || RATIO_AFTER.test(after)) return true;
  return SAID_BEFORE.test(scan.slice(Math.max(0, index - 40), index));
}

/** Every figure the prose states: a number the table does not exempt, said as a figure. */
export function statedFigures(
  text: string,
  table: readonly FigureExemption[] = FIGURE_EXEMPTIONS,
): StatedFigure[] {
  const scan = scanOf(text, table);
  return once(numbersIn(scan).filter((f) => saidAsFigure(scan, f.index, f.quote)));
}

/** Every value the person's question holds, read the same way: a figure equal to one is theirs. */
export function askedValues(
  ask: string,
  table: readonly FigureExemption[] = FIGURE_EXEMPTIONS,
): ReadonlySet<number> {
  if (!table.some((row) => row.id === 'asked')) return new Set();
  const out = new Set<number>();
  for (const m of ask.normalize('NFC').matchAll(FIGURE_RE)) {
    for (const r of readingsOf(m[0].trim().replace(/\s?%$/, ''))) out.add(r.value);
  }
  return out;
}

/** The clause around `index`: bounded by a sentence end, a comma, a semicolon, a colon or a dash. */
function clauseAt(text: string, index: number): { before: string; whole: string } {
  const BOUND = /[.!?,;:](?=\s|$)|[\n—–]/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(BOUND)) {
    const at = m.index ?? 0;
    if (at < index) start = at + m[0].length;
    else {
      end = at;
      break;
    }
  }
  return { before: text.slice(start, index), whole: text.slice(start, end) };
}

/** A clause that names the person as the number's source: "the 5 you asked for", "your 87%". */
const NAMED_AS_THEIRS = new RegExp(
  [
    "\\byou(?:['’]ve|\\s+have|\\s+just)?\\s+(?:asked|typed|gave|given|said|wrote|written|mentioned|listed|named|requested|quoted|provided|suggested|guessed|expected|estimated|cited|entered|wanted|want)\\b",
    '\\byour\\s+(?:own\\s+)?(?:figure|number|count|estimate|guess|question|request|message|list|value|claim|sentence|words?|\\d)',
    'bạn\\s+(?:đã\\s+)?(?:hỏi|nêu|đưa|gõ|nói|yêu\\s+cầu|nhắc|muốn|cần)', // i18n-allow: the Vietnamese words that name the person as a number's source
  ].join('|'),
  'iu',
);

/** Before the number in its clause: the reply declining to state it ("I can't say we are 87% done"). */
const DECLINED_BEFORE =
  /(?:\b(?:not|never|cannot)\b|n['’]t\b|\b(?:unable|no\s+way)\s+to\b|không|chưa)/iu; // i18n-allow: the Vietnamese negations

/**
 * Whether the number at `index` is said back rather than stated: its clause names the person as its
 * source, or declines it before it is said. The one test of the `asked` row, for every rule that lets
 * the person's own number stand (`figures-rule.ts`, `progress-rule.ts`); a number merely equal to one
 * the person typed is not theirs said back (QA of ISS-436 on 0.4.0-dev.193: "Forge has 4,812 open
 * issues right now." went out because the asker had typed 4,812).
 */
export function saidBackAt(text: string, index: number): boolean {
  const clause = clauseAt(text, index);
  return NAMED_AS_THEIRS.test(clause.whole) || DECLINED_BEFORE.test(clause.before);
}

/** Whether a number of `text` is one the person typed, said back as theirs or declined. */
export function askersOwn(
  text: string,
  figure: { readonly index: number; readonly readings: readonly { readonly value: number }[] },
  asked: ReadonlySet<number>,
): boolean {
  return figure.readings.some((r) => asked.has(r.value)) && saidBackAt(text, figure.index);
}
