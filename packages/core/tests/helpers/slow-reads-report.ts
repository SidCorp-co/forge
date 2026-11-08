// What the scale read test (`tests/integration/slow-reads-at-scale-e2e.test.ts`) records of each read:
// its statements, where each was sent from, and what their plans touch. SLOW_READS_ALL adds every
// statement's shape with how many times the read sent it, so two reads can be compared shape by shape.

import type { Doc } from './ecosystem-world.js';

export interface Statement {
  text: string;
  params: unknown;
  ms: number;
  /** The rows it answered, each one the process parses and maps. */
  rows?: number;
  /** Its plan's planning and execution time, run again alone (`buffersOf`). */
  planMs?: number;
  execMs?: number;
  /** The `src/` frames that sent it, when SLOW_READS_STACKS asks for them. */
  site?: string | undefined;
}

export interface Measure {
  path: string;
  status: number;
  ms: number;
  /** What the app's own `Server-Timing` says it spent: the database's share, the app's, the whole. */
  timing: string;
  statements: Statement[];
  body: Doc;
  /** The answer's size in bytes, as the wire carries it. */
  bytes: number;
}

export function report(label: string, m: Measure): string {
  const slowest = [...m.statements].sort((a, b) => b.ms - a.ms).slice(0, 8);
  const same = new Map<string, number>();
  for (const s of m.statements) same.set(s.text, (same.get(s.text) ?? 0) + 1);
  const repeated = [...same].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return [
    `## ${label} ${m.path} -> ${m.status}: ${m.ms.toFixed(0)} ms, ${m.statements.length} statements, ${m.bytes} bytes, ${repeated.reduce((n, [, c]) => n + c - 1, 0)} repeats | ${m.timing}`,
    ...slowest.map(
      (s) => `  ${s.ms.toFixed(1).padStart(8)} ms  ${s.text.replace(/\s+/g, ' ').slice(0, 260)}`,
    ),
    ...repeated.slice(0, process.env.SLOW_READS_STACKS ? 20 : 5).map(([t, n]) => {
      const sites = [...new Set(m.statements.filter((x) => x.text === t).map((x) => x.site))];
      const at = process.env.SLOW_READS_STACKS ? `\n      from ${sites.join('\n      from ')}` : '';
      return `  x${n} ${t.replace(/\s+/g, ' ').slice(0, 200)}${at}`;
    }),
    ...(process.env.SLOW_READS_STACKS ? sitesOf(m) : []),
    ...(process.env.SLOW_READS_ALL ? everyShape(m) : []),
  ].join('\n');
}

/** The statements touching the most shared buffers, by the code that sent them where it is named. */
export function heaviestSites(heaviest: { own: number; s: Statement }[]): string[] {
  const by = new Map<string, { n: number; own: number; rows: number; plan: number }>();
  for (const { own, s } of heaviest) {
    const at = s.site?.split(' < ')[0] ?? s.text.replace(/\s+/g, ' ').slice(0, 120);
    const was = by.get(at) ?? { n: 0, own: 0, rows: 0, plan: 0 };
    by.set(at, {
      n: was.n + 1,
      own: was.own + own,
      rows: was.rows + (s.rows ?? 0),
      plan: was.plan + (s.planMs ?? 0),
    });
  }
  const top = (of: (v: { own: number; rows: number; plan: number }) => number) =>
    [...by]
      .sort((a, b) => of(b[1]) - of(a[1]))
      .slice(0, Number(process.env.SLOW_READS_HEAVIEST ?? 8));
  const rows = heaviest.reduce((n, { s }) => n + (s.rows ?? 0), 0);
  const plan = heaviest.reduce((n, { s }) => n + (s.planMs ?? 0), 0);
  const exec = heaviest.reduce((n, { s }) => n + (s.execMs ?? 0), 0);
  return [
    `  alone, the database plans them in ${plan.toFixed(0)} ms and runs them in ${exec.toFixed(0)} ms`,
    ...top((v) => v.own).map(
      ([at, { n, own, rows }]) => `  ${String(own).padStart(8)} buf in ${n} (${rows} rows)  ${at}`,
    ),
    ...top((v) => v.plan).map(
      ([at, { n, plan }]) => `  ${plan.toFixed(1).padStart(8)} ms planning ${n}  ${at}`,
    ),
    `  ${rows} rows in all`,
    ...top((v) => v.rows).map(
      ([at, { n, own, rows }]) => `  ${String(rows).padStart(8)} rows in ${n} (${own} buf)  ${at}`,
    ),
  ];
}

/** Each call site's statements: how many, and their summed time, the most first. */
function sitesOf(m: Measure): string[] {
  const by = new Map<string, { n: number; ms: number }>();
  for (const s of m.statements) {
    const at = by.get(s.site ?? '?') ?? { n: 0, ms: 0 };
    by.set(s.site ?? '?', { n: at.n + 1, ms: at.ms + s.ms });
  }
  return [...by]
    .sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms)
    .map(
      ([site, { n, ms }]) => `  @${String(n).padStart(3)} ${ms.toFixed(0).padStart(6)} ms  ${site}`,
    );
}

/** Every statement's text, its lists of parameters folded, with how many times the read sent it. */
function everyShape(m: Measure): string[] {
  const by = new Map<string, number>();
  for (const s of m.statements) {
    const shape = s.text
      .replace(/\s+/g, ' ')
      .replace(/\$\d+(, \$\d+)*/g, '$')
      .trim()
      .slice(0, 220);
    by.set(shape, (by.get(shape) ?? 0) + 1);
  }
  return [...by].sort((a, b) => b[1] - a[1]).map(([shape, n]) => `  = ${n} ${shape}`);
}
