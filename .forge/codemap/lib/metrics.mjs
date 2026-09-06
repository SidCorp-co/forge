// @generated codemap 0.19.0 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 — local-first north-star metrics (ISS-3).
//
// ISS-3's own framing of the number that matters: how many times a cm: annotation blocked a real
// mistake before it shipped — distinct from NORTH-STAR.md §5's external-adoption metric, which this
// does not replace (§5 item 5 now points here). Everything this repo could already show (file
// counts, annotation counts, test counts) is SCALE, not EFFECT — flat effect under rising scale
// looks exactly like success, which is the trap that killed the repos before this one.
//
// Local sink, sending opt-in, shape not content: every event recorded here carries codes, tiers,
// counts and timestamps — never a diagnostic's message/fix text or the comment it was about, since
// an installed repo may hold real customer data. `show`/`send` share one payload builder so the
// preview a human reads is byte-for-byte what would leave the machine (see cm.mjs `metrics` verb).

import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { blockingDiags } from './blocking.mjs';

const DIR = ['.forge', '.codemap-metrics'];
const EVENTS_FILE = 'events.jsonl';
const PENDING_FILE = 'pending.json';

function metricsDir(root) {
  return join(root, ...DIR);
}

function ensureDir(root) {
  const dir = metricsDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// cm:guard every try/catch below swallows and no-ops — this module is observational, so a disk error,
//   a missing git binary or a corrupt local file must never be the reason an edit itself fails

/** Every event is exactly these fields — the enforcement point for "shape, not content". */
function shape(fields) {
  const { ts, event, tier, codes, file, heldMs, data } = fields;
  const out = { ts, event };
  if (tier !== undefined) out.tier = tier;
  if (codes !== undefined) out.codes = [...codes].sort();
  if (file !== undefined) out.file = file;
  if (heldMs !== undefined) out.heldMs = heldMs;
  if (data !== undefined) out.data = data;
  return out;
}

function appendEvent(root, fields) {
  try {
    const dir = ensureDir(root);
    appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(shape(fields))}\n`);
  } catch {}
}

function loadPending(root) {
  try {
    return JSON.parse(readFileSync(join(metricsDir(root), PENDING_FILE), 'utf8'));
  } catch { return {}; }
}

function savePending(root, pending) {
  try {
    ensureDir(root);
    writeFileSync(join(metricsDir(root), PENDING_FILE), `${JSON.stringify(pending, null, 2)}\n`);
  } catch {}
}

// cm:why +1s, not sinceMs itself — git commit timestamps are second-granular, and a same-second
//   commit would otherwise misread as one that shipped past a block fired moments earlier
function commitsSince(root, relPath, sinceMs) {
  try {
    const iso = new Date(sinceMs + 1000).toISOString();
    const out = execFileSync('git', ['-C', root, 'log', `--since=${iso}`, '--oneline', '--', relPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

const pendingKey = (code, line) => `${code}@${line}`;

/**
 * Reconcile one file's pending blocks against its current blocking diagnostics.
 *
 * @param {string} root
 * @param {string} relPath
 * @param {Array<{code: string, line: number}>} current — the diagnostics blocking THIS run, from the
 *   same predicate that decided the hook's own decision (scripts/lib/blocking.mjs) — never recomputed
 *   here. Keyed by (code, line), not code alone — a repo can carry more than one instance of the same
 *   code in one file (frozen legacy prose is the common case), and treating them as one identity let a
 *   genuine fix of ONE instance hide forever behind an unrelated, never-blocked other one.
 */
// cm:guard held is decided FIRST, from presence alone — checking "did a commit land" before "is it
//   still there" reads the ordinary fix-then-commit flow as evasion, on every genuine fix (ISS-3)
export function reconcile(root, relPath, current) {
  try {
    const pending = loadPending(root);
    const entry = pending[relPath];
    const stillBlocking = new Set(current.map((d) => pendingKey(d.code, d.line)));

    if (entry) {
      for (const [key, info] of Object.entries(entry.at)) {
        if (!stillBlocking.has(key)) {
          appendEvent(root, { ts: Date.now(), event: 'held', tier: 'grammar', codes: [info.code], file: relPath, heldMs: Date.now() - info.ts });
          delete entry.at[key];
        } else if (commitsSince(root, relPath, info.ts) > 0) {
          appendEvent(root, { ts: Date.now(), event: 'circumvented', tier: 'grammar', codes: [info.code], file: relPath });
          delete entry.at[key];
        }
      }
      if (!Object.keys(entry.at).length) delete pending[relPath];
    }

    if (current.length) {
      appendEvent(root, { ts: Date.now(), event: 'block', tier: 'grammar', codes: current.map((d) => d.code), file: relPath });
      const e = pending[relPath] ?? (pending[relPath] = { at: {} });
      const now = Date.now();
      for (const d of current) {
        const key = pendingKey(d.code, d.line);
        if (!(key in e.at)) e.at[key] = { code: d.code, ts: now };
      }
    }

    savePending(root, pending);
  } catch {}
}

/**
 * Whole-repo sweep of every pending entry, for files never re-touched through the hook at all — the
 * only way a commit-and-forget circumvention is ever seen. `cmPath` is the checker to shell out to
 * (the same one the caller is already running), so this agrees with the hook about what blocks.
 */
export function reconcileAll(root, cmPath) {
  const pending = loadPending(root);
  const files = Object.keys(pending);
  let checked = 0;
  // cm:guard a file the checker cannot verify right now is skipped, leaving its pending entry exactly
  //   as it was — never guessed at as held or circumvented on the strength of a failed subprocess
  for (const relPath of files) {
    if (!existsSync(join(root, relPath))) continue;
    // cm:why spawnSync, not execFileSync — verify exits 1 when it finds violations, which is the
    //   ordinary outcome here, not a failure execFileSync should throw on
    const res = spawnSync(process.execPath, [cmPath, 'verify', '--tier', 'grammar', '--json', relPath],
      { cwd: root, encoding: 'utf8' });
    if (res.status !== 0 && res.status !== 1) continue;
    let current;
    try {
      current = blockingDiags(JSON.parse(res.stdout)).map((d) => ({ code: d.code, line: d.line }));
    } catch { continue; }
    reconcile(root, relPath, current);
    checked++;
  }
  return { pendingBefore: files.length, checked };
}

function readEvents(root) {
  let raw;
  try { raw = readFileSync(join(metricsDir(root), EVENTS_FILE), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** One line per file, once — `git blame --line-porcelain` gives every line's author-mail in one call. */
function blameAuthors(root, relPath) {
  const byLine = new Map();
  try {
    const out = execFileSync('git', ['-C', root, 'blame', '--line-porcelain', '--', relPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let line = 0;
    for (const l of out.split('\n')) {
      const hdr = /^[0-9a-f]{40} \d+ (\d+)/.exec(l);
      if (hdr) { line = Number(hdr[1]); continue; }
      const mail = /^author-mail <(.+)>$/.exec(l);
      if (mail) byLine.set(line, mail[1]);
    }
  } catch {}
  return byLine;
}

/**
 * Annotation counts by tag, and the count of DISTINCT authors who wrote one — never the authors'
 * identities in the shape that would ever be sent (see `buildPayload`); `show` may print them locally.
 */
export function annotationCounts(root, g) {
  const byTag = { guard: g.guards.length, edge: g.edges.length, hack: g.hacks.length, why: g.whys.length };
  byTag.flow = [...g.flows.values()].reduce((n, f) => n + f.steps.length, 0);

  const authors = new Set();
  for (const [file, anns] of g.byFile) {
    const blame = blameAuthors(root, file);
    for (const a of anns) {
      const who = blame.get(a.line);
      if (who) authors.add(who);
    }
  }
  return { total: Object.values(byTag).reduce((a, b) => a + b, 0), byTag, distinctAuthors: authors.size, authors: [...authors].sort() };
}

/** Which checks this repo has turned off — the most direct "this check cries wolf" signal (§5). */
export function registrySnapshot(reg) {
  const languagesDisabled = Object.entries(reg.languages ?? {})
    .filter(([, v]) => v.enforce === false).map(([id]) => id).sort();
  return {
    grammarEnabled: reg.enforce?.grammar !== false,
    advisoryEnabled: Boolean(reg.enforce?.advisory),
    languagesDisabled,
  };
}

/**
 * Aggregate local events into counts by (event, code) — the shape `show` prints and `send` transmits.
 * Never per-file: a per-file table on an installed repo with real customer data is exactly the
 * content this module exists to keep off the wire.
 */
export function eventCounts(events) {
  const byCode = {};
  for (const e of events) {
    if (!['block', 'held', 'circumvented'].includes(e.event)) continue;
    for (const code of e.codes ?? []) {
      const k = byCode[code] ?? (byCode[code] = { block: 0, held: 0, circumvented: 0 });
      k[e.event]++;
    }
  }
  return byCode;
}

/**
 * The one payload both `cm metrics show --json` and `cm metrics send` produce — shape only, ready to
 * leave the machine. `send` without `--yes` prints exactly this and stops (see cm.mjs), so there is
 * no separate "preview" implementation that could drift from what actually gets sent.
 */
export function buildPayload(root, { reg, g }) {
  const events = readEvents(root);
  const pendingCount = Object.keys(loadPending(root)).length;
  const ann = annotationCounts(root, g);
  return {
    specVersion: reg.specVersion ?? 'codemap/1',
    generatedAt: new Date().toISOString(),
    blocks: eventCounts(events),
    pendingUnresolved: pendingCount,
    annotations: { total: ann.total, byTag: ann.byTag, distinctAuthors: ann.distinctAuthors },
    registry: registrySnapshot(reg),
  };
}

/** Appends one point to the annotation-count time series — run this on a cadence (`cm metrics show`,
 *  ideally the weekly bot NORTH-STAR §5 already runs) or the trend has no points to show a slope with. */
export function recordAnnotationSnapshot(root, ann) {
  appendEvent(root, {
    ts: Date.now(), event: 'annotation-snapshot',
    data: { total: ann.total, byTag: ann.byTag, distinctAuthors: ann.distinctAuthors },
  });
}

export function recordRegistrySnapshot(root, snap) {
  appendEvent(root, { ts: Date.now(), event: 'registry-snapshot', data: snap });
}

/** The registry on/off series, oldest first. */
export function registryTrend(root) {
  return readEvents(root).filter((e) => e.event === 'registry-snapshot')
    .map((e) => ({ ts: e.ts, ...e.data }));
}

/** How many times grammar/advisory flipped on↔off across the series — required outcome 3 (ISS-3):
 *  the rate a check gets turned off is the most direct "this check cries wolf" signal there is. */
export function registryFlips(trend) {
  let flips = 0;
  for (let i = 1; i < trend.length; i++) {
    if (trend[i].grammarEnabled !== trend[i - 1].grammarEnabled) flips++;
    if (trend[i].advisoryEnabled !== trend[i - 1].advisoryEnabled) flips++;
  }
  return flips;
}

/** The annotation-count series, oldest first — what turns one snapshot into a trend. */
export function annotationTrend(root) {
  return readEvents(root).filter((e) => e.event === 'annotation-snapshot')
    .map((e) => ({ ts: e.ts, ...e.data }));
}

export function metricsPaths(root) {
  return { dir: metricsDir(root), events: join(metricsDir(root), EVENTS_FILE), pending: join(metricsDir(root), PENDING_FILE) };
}
