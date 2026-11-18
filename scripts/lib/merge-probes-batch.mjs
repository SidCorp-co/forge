// One merge check for a batch (ISS-1294): the batch's one gate runs the kept probes of every issue it
// lands, so its one report is recorded on each of them. A batch names each issue by its id beside
// that issue's saved criteria read, `--probes <issue id>=<file>`, once per issue; the report then
// carries each issue's probes and standing under its id (`issues`), and core holds the issue it is
// recorded on to its own (`packages/core/src/issues/merge-check-batch.ts:reportForIssue`), refusing
// MERGE_CHECK_ISSUE_NOT_COVERED one the report does not name. A single `--probes <file>` and
// `--probes none` read as before (`lib/merge-probes.mjs:readProbesFlag`), and their reports keep the
// top-level `probes` and `standing`.

import { NO_ISSUE, readProbesFlag, runProbes, standingLines } from './merge-probes.mjs';

/** An issue's id, the uuid `GET /api/issues/<key>` answers as `id`. */
const ISSUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<issue id>=<file>`: what names an issue, before the first `=`, holds no path separator. */
const KEYED = /^([^=/\\]+)=(.+)$/;

const BATCH_SHAPE =
  'a batch names each issue it lands as `--probes <issue id>=<file>`, the file the saved answer of `GET /api/issues/<issue id>/criteria`';

/**
 * What the `--probes` values say: one file or `none`, as before (`{ criteria }`), or a batch, each
 * issue's id with its criteria (`{ batch: [{ issue, criteria }] }`); or the refusal naming the value
 * that is wrong and the shape that is valid. `read` is the reader of one file, a seam for tests.
 */
export function readProbesFlags(values, read = readProbesFlag) {
  if (values.length === 1 && !KEYED.test(values[0])) return read(values[0]);
  if (values.includes(NO_ISSUE))
    return {
      refusal: `--probes ${NO_ISSUE} names no issue, so it stands alone; ${BATCH_SHAPE}`,
    };
  const batch = [];
  for (const value of values) {
    const keyed = KEYED.exec(value);
    if (!keyed) return { refusal: `--probes ${value} names no issue; ${BATCH_SHAPE}` };
    const [, issue, file] = keyed;
    if (!ISSUE_ID.test(issue))
      return {
        refusal: `--probes ${value}: ${issue} is not an issue id (the uuid \`GET /api/issues/<key>\` answers as \`id\`); ${BATCH_SHAPE}`,
      };
    if (batch.some((b) => b.issue === issue.toLowerCase()))
      return { refusal: `--probes names issue ${issue} twice; ${BATCH_SHAPE}, once each` };
    if (file === NO_ISSUE)
      return {
        refusal: `--probes ${value}: an issue the batch lands has a criteria read; ${BATCH_SHAPE}`,
      };
    const got = read(file);
    if (got.refusal) return { refusal: `issue ${issue}: ${got.refusal}` };
    batch.push({ issue: issue.toLowerCase(), criteria: got.criteria });
  }
  return { batch };
}

/**
 * Run what the `--probes` read owes: one issue's probes (or none's) as `runProbes` does, or each
 * issue's of a batch, its checks scoped to it, its bindings and standing kept under its id
 * (`issues`), and each probe missing or red naming its issue.
 */
export async function runProbesRead(read, opts) {
  if (!read.batch) return runProbes(read.criteria, opts);
  const out = { checks: [], bindings: [], standing: [], missing: [], red: [], issues: [] };
  for (const { issue, criteria } of read.batch) {
    const one = await runProbes(criteria, { ...opts, issue });
    out.checks.push(...one.checks);
    out.missing.push(...one.missing.map((m) => ({ ...m, issue })));
    out.red.push(...one.red.map((r) => ({ ...r, issue })));
    out.issues.push({ issue, probes: one.bindings, standing: one.standing });
  }
  return out;
}

/** What the run prints of the standing criteria, each line of a batch's naming its issue. */
export function probeStandingLines(probeRun, base) {
  if (!probeRun.issues) return standingLines(probeRun.standing, base);
  return probeRun.issues.flatMap(({ issue, standing }) =>
    standingLines(standing, base).map((line) => `issue ${issue}: ${line}`),
  );
}
