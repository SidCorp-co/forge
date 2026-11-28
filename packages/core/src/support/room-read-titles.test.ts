// @direct-test-of packages/core/src/support/ops-reads.ts
// @direct-test-of packages/core/src/support/shared-picture.ts
// @direct-test-of packages/core/src/support/ops-release-holds.ts
// @direct-test-of packages/core/src/support/ops-feedback-read.ts
// @direct-test-of packages/core/src/support/promise-watch.ts
// ISS-1483 (dev.864): a title or a name a room read hands over is an agent's free text and can name the
// master; it goes through `titleWords`. The database-backed reads are poisoned end to end in
// tests/integration/support-agent-reads-e2e.test.ts; this file holds the word rule and a source guard
// for the reads that need a deeper world (in flight, a release hold).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIND_LABEL, titleWords } from './room-read-words.js';
import { INTERNAL_WORDS, NAMES_THE_HAND } from './room-voice.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('a title a room reads (ISS-1483)', () => {
  it('keeps a plain title, and reads the kind where the title names an internal hand', () => {
    expect(titleWords('Sign-in page', 'issue')).toBe('Sign-in page');
    for (const poison of [
      'A room agent and its master trade one-shot facts',
      'the orchestrator retries ISS-9999',
      'judge fails 9e174d4534ab',
      'the steward holds PAT_PROJECT_OUTSIDE_FENCE',
      'a qa run on the box',
    ]) {
      const said = titleWords(poison, 'issue');
      expect(said, poison).toBe('an issue');
      expect(NAMES_THE_HAND.test(said) || INTERNAL_WORDS.test(said)).toBe(false);
    }
    // a handle is taken out of a title that is otherwise plain
    expect(titleWords('Fix sign-in ISS-9999', 'issue')).not.toContain('ISS-9999');
  });

  it('labels no kind with a word the room rule itself would withhold', () => {
    for (const kind of Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]) {
      const label = titleWords('the master, a judge and the runner', kind);
      expect(label, kind).toBe(KIND_LABEL[kind]);
      expect(NAMES_THE_HAND.test(label) || INTERNAL_WORDS.test(label), `${kind} label`).toBe(false);
    }
  });

  it('reads the Vietnamese words for a hand in a title as a hand', () => {
    for (const poison of [
      'Chuyển bên AdminHub xử lý', // i18n-allow: the Vietnamese title under test
      'Nhờ đội kỹ thuật xem lại', // i18n-allow: the Vietnamese title under test
      'master gửi lại job', // i18n-allow: the Vietnamese title under test
      'Trợ lý nội bộ trả lời sai', // i18n-allow: the Vietnamese title under test
      'Báo bên kỹ thuật', // i18n-allow: the Vietnamese title under test
      'Đội ngũ phát triển sửa', // i18n-allow: the Vietnamese title under test
    ]) {
      expect(titleWords(poison, 'issue'), poison).toBe('an issue');
    }
    // a plain Vietnamese title stays
    for (const plain of [
      'Đơn hàng hiện ngày giao', // i18n-allow: the Vietnamese title under test
      'Xuất báo cáo theo tuần', // i18n-allow: the Vietnamese title under test
      'Bên trái trang chủ', // i18n-allow: the Vietnamese title under test
    ]) {
      expect(titleWords(plain, 'issue'), plain).toBe(plain);
    }
  });
});

// The guard is DERIVED: it reads every non-test source file under support/ (the one directory every
// room act and room read lives in) and fails on a `.title`, `.name` or `.displayName` read that is
// neither routed through `titleWords`/`plainWords` on its line nor named in RAW_READS with the reason
// it is safe. A new file with a raw read goes red naming its file and line; an entry that no longer
// matches a line goes red too, so the list cannot rot into a blanket pass.
type Raw = { file: string; line: number; text: string };

/**
 * What a read is a read OF: the word before `.title`/`.name` (looking through `.value` of an outcome). A
 * `.title` is flagged on any receiver but a caller's own input; a `.name` or `.displayName` only on a
 * receiver that is a record a room reads (an issue, requirement, release, feedback, project, runner, box
 * or attachment), (a one-letter row is not seen: see the report on this guard).
 */
const READ = /([A-Za-z_$][\w$]*)(?:\??\.value)?\??\.(title|name|displayName)\b/g;
const RECORD_NAMED =
  /^(?:issues?|requirements?|req|releases?|feedback|fb|projects?|proj|runners?|box|boxes|device|devices|attachments?|att|files?|found|rows?|behind|carrying|connections?|binding)$/;
const OWN_WORDS = /^(?:input|args|err|error)$/;
const WORDED = /titleWords|plainWords/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(e.name) && !/\.(?:test|fixture)\.ts$/.test(e.name) ? [path] : [];
  });
}

/** The lines of `source` that read a title or name raw: not a comment, not worded, not a non-record receiver. */
function rawReads(file: string, source: string): Raw[] {
  const out: Raw[] = [];
  let block = false;
  source.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (block) {
      block = !t.includes('*/');
      return;
    }
    if (t.startsWith('/*')) {
      block = !t.includes('*/');
      return;
    }
    if (t.startsWith('//') || t.startsWith('*')) return;
    const code = line.replace(/\s\/\/ .*$/, '').replace(/'[^'\n]*'/g, "''");
    if (WORDED.test(code)) return;
    const flagged = [...code.matchAll(READ)].some(
      ([, receiver = '', prop]) =>
        !OWN_WORDS.test(receiver) && (prop === 'title' || RECORD_NAMED.test(receiver)),
    );
    if (!flagged) return;
    out.push({ file, line: i + 1, text: t });
  });
  return out;
}

/** Reads reviewed as safe: `at` is a fragment of the line, `why` is what makes it not an agent's words about a record. */
const RAW_READS: { file: string; at: string; why: string }[] = [
  {
    file: 'ability-acts.ts',
    at: 'bound.binding.label',
    why: 'the argument of a titleWords call that opens on the line above',
  },
  {
    file: 'master-post-images.ts',
    at: 'att.name',
    why: "an attachment's file name handed to the project's master, never to a room",
  },
  {
    file: 'owner-credential.ts',
    at: 'found.name',
    why: "a support-api binding's name, written by the project admin as config; not a title an agent wrote",
  },
  {
    file: 'owner-rule-act.ts',
    at: 'rule.title',
    why: "the owner's own ruling input echoed back to the owner, not a record read for a room",
  },
  {
    file: 'promise-rules.ts',
    at: 'f.title',
    why: "arrives already worded: promise-watch.ts passes the issue's title through titleWords",
  },
  {
    file: 'promise-watch.ts',
    at: 'issues.title',
    why: 'the column select; its read below goes through titleWords',
  },
  {
    file: 'promise.ts',
    at: 'title: issues.title',
    why: 'the column select; every use below goes through titleWords',
  },
  {
    file: 'release-notes.ts',
    at: 'notes.title',
    why: "a release note's title is written for the people it is sent to, as a note, never as a record's title",
  },
  {
    file: 'release-notes.ts',
    at: 'n.title',
    why: "a release note's title is written for the people it is sent to, as a note, never as a record's title",
  },
  {
    file: 'reply-audit/audit.ts',
    at: 'conversations.title',
    why: "the reply audit reads threads for the project's own review, and nothing it reads is said to a room",
  },
  {
    file: 'reply-audit/audit.ts',
    at: 'thread?.title',
    why: "the reply audit reads threads for the project's own review, and nothing it reads is said to a room",
  },
  {
    file: 'reply-audit/self-audit.ts',
    at: 'issue.title',
    why: "the reply audit reads issues for the project's own review, and nothing it reads is said to a room",
  },
  {
    file: 'shared-picture.ts',
    at: 'i.title, i.status',
    why: "the SQL select; the row's title goes through titleWords where the picture is built",
  },
  {
    file: 'shared-picture.ts',
    at: '!r.title',
    why: "a presence check of the row's title; the title itself goes through titleWords",
  },
  {
    file: 'wait-reminder.ts',
    at: ': reminder not sent',
    why: "the title of the sweep's own job record for the project, read in Forge and never said to a room",
  },
  {
    file: 'wait-reminder.ts',
    at: 'name: projects.name',
    why: "the column select; its one use in the room's brief goes through titleWords",
  },
];

describe('every title and name a support file reads is worded for a room (ISS-1483)', () => {
  const files = sourceFiles(HERE);

  it('finds the support files it guards', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('/promise.ts'))).toBe(true);
  });

  it('has no raw read outside the reviewed list, and no reviewed entry that matches nothing', () => {
    const rel = (f: string) => relative(HERE, f);
    const hits = files.flatMap((f) => rawReads(rel(f), readFileSync(f, 'utf8')));
    const unreviewed = hits.filter(
      (h) => !RAW_READS.some((r) => r.file === h.file && h.text.includes(r.at)),
    );
    expect(
      unreviewed.map((h) => `${h.file}:${h.line} ${h.text.slice(0, 100)}`),
      'a title or name read raw: pass it through titleWords/plainWords, or review it into RAW_READS with why',
    ).toEqual([]);
    const stale = RAW_READS.filter(
      (r) => !hits.some((h) => h.file === r.file && h.text.includes(r.at)),
    );
    expect(stale, 'a reviewed read that no line matches any more').toEqual([]);
    for (const r of RAW_READS) expect(r.why.length, `${r.file} ${r.at}`).toBeGreaterThan(15);
  });

  it('goes red on a planted raw title read, naming its file and line', () => {
    const planted = rawReads(
      'planted.ts',
      ['const a = 1;', 'export const say = (issue: I) => issue.title;', ''].join('\n'),
    );
    expect(planted).toEqual([
      { file: 'planted.ts', line: 2, text: expect.stringContaining('issue.title') },
    ]);
    expect(
      rawReads('planted.ts', "export const say = (i: I) => titleWords(i.title, 'issue');\n"),
    ).toEqual([]);
    expect(rawReads('planted.ts', '// the issue.title is said\n/* issue.name */\n')).toEqual([]);
  });
});
