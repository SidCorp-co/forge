// The merge check's probes (REQ-36 BC-1, BC-9; ISS-472 round 4): each kept probe of the change's
// issue, run against the change before it lands. The probes come from the issue's criteria read
// (`GET /api/issues/:id/criteria`, saved to a file and passed as `--probes <file>`), so this script
// holds no credential and asks core nothing. Core applies the same rule when the report is recorded
// (`packages/core/src/issues/merge-check-rules.ts:probeRefusals`), against the criteria it holds.
//
//   kind      how it runs here
//   command   its argv, spawned without a shell in the checkout at its `cwd`; FORGE_PROBE_ORIGIN is
//             the `--probe-origin` given, and unset (said in the check's note) where none is
//   request   sent to `--probe-origin` when it is anonymous and names no service; a replayer request
//             (the merge check holds no credential), a service's request, or any request with no
//             origin given cannot run here, and is reported with result `none` and why
//
// A kept probe that did not run, or an observable criterion keeping none, is MERGE_PROBE_MISSING; a
// probe that ran and answered something else is MERGE_PROBE_RED. A criterion classed a code property,
// or one no design classes, that keeps no probe owes none.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from './direct-test-run.mjs';

/** The variable a command probe reads the running build's origin from (contracts `PROBE_ORIGIN_ENV`). */
export const PROBE_ORIGIN_ENV = 'FORGE_PROBE_ORIGIN';

/** `--probes none`: the run names no issue (CI's), so it has no kept probe to run. */
export const NO_ISSUE = 'none';

/** A probe left running this long did not answer; it is red, never waited on past it. */
export const PROBE_TIMEOUT_MS = 10 * 60 * 1000;

const SHAPE =
  'the saved answer of `GET /api/issues/:id/criteria` (`{ criteria: [{ n, class, probe }] }`), or `none` for a run that names no issue';

/**
 * The criteria a `--probes` file holds, or the refusal naming what is wrong with it. Each criterion
 * keeps `n`, `class` and `probe` from the criteria read; anything else in the file is left alone.
 */
export function criteriaOf(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { refusal: `--probes ${path} is not JSON (${e.message}); it is ${SHAPE}` };
  }
  const list = parsed?.criteria;
  if (!Array.isArray(list)) {
    return { refusal: `--probes ${path} holds no \`criteria\` list; it is ${SHAPE}` };
  }
  for (const [i, c] of list.entries()) {
    if (!Number.isInteger(c?.n) || c.n < 1) {
      return { refusal: `--probes ${path}: criteria[${i}] has no criterion number \`n\`; it is ${SHAPE}` };
    }
    if (c.probe != null && (typeof c.probe.id !== 'string' || !['command', 'request'].includes(c.probe.kind))) {
      return {
        refusal: `--probes ${path}: criterion ${c.n}'s probe has no \`id\` or no \`kind\` of command or request; it is ${SHAPE}`,
      };
    }
  }
  return { criteria: list.map((c) => ({ n: c.n, class: c.class ?? null, probe: c.probe ?? null })) };
}

/** Read `--probes`: `none`, or a criteria read saved to a file. */
export function readProbesFlag(value) {
  if (value === NO_ISSUE) return { criteria: null };
  let text;
  try {
    text = readFileSync(value, 'utf8');
  } catch (e) {
    return { refusal: `--probes ${value} cannot be read (${e.code ?? e.message}); it is ${SHAPE}` };
  }
  return criteriaOf(text, value);
}

/** The origin `--probe-origin` names, or the refusal: an http(s) origin, no path, no credential. */
export function originOf(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { refusal: `--probe-origin ${value} is not a URL; it is the http(s) origin serving the change` };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { refusal: `--probe-origin ${value} is not an http(s) origin without a credential` };
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return { refusal: `--probe-origin ${value} has a path; it is an origin, and each probe names its own path` };
  }
  return { origin: url.origin };
}

/**
 * What the issue's criteria owe the merge: each kept probe to run, and each observable criterion that
 * keeps none. A code property, or a criterion no design classes, that keeps none owes nothing.
 */
export function probesOwed(criteria) {
  const runs = [];
  const missing = [];
  for (const c of criteria) {
    if (c.class === 'code_property') continue;
    if (c.probe) runs.push({ criterion: c.n, probe: c.probe });
    else if (c.class === 'observable')
      missing.push({ criterion: c.n, why: 'it is observable and keeps no probe' });
  }
  return { runs, missing };
}

/** The command line a probe's check records: what it ran, never a credential (a probe holds none). */
export function probeCommand(probe) {
  if (probe.kind === 'command') {
    const at = probe.command.cwd ? ` (in ${probe.command.cwd})` : '';
    return `${probe.command.argv.join(' ')}${at}`.slice(0, 500);
  }
  return `${probe.request.method} ${probe.request.path} as ${probe.request.as}`.slice(0, 500);
}

const missingIncludes = (text, wanted = []) => wanted.filter((w) => !text.includes(w));

/** Why a request probe cannot run here, or null where it can. */
export function requestUnrunnable(probe, origin) {
  if (!origin) return 'no --probe-origin names a build of the change to send it to';
  if (probe.request.as === 'replayer')
    return 'it goes out with the replayer\'s credential, and the merge check holds none';
  if (probe.request.service)
    return `it names service \`${probe.request.service}\`, and --probe-origin names one origin`;
  return null;
}

/** Run one command probe in the checkout; the runner is a seam, so a test drives it whole. */
export function runCommandProbe(probe, { root, origin, env = process.env, spawn = spawnSync }) {
  const started = Date.now();
  const childEnv = { ...env };
  delete childEnv[PROBE_ORIGIN_ENV];
  if (origin) childEnv[PROBE_ORIGIN_ENV] = origin;
  const r = spawn(probe.command.argv[0], probe.command.argv.slice(1), {
    cwd: probe.command.cwd ? join(root, probe.command.cwd) : root,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const originNote = origin ? `${PROBE_ORIGIN_ENV}=${origin}` : `${PROBE_ORIGIN_ENV} unset: no --probe-origin given`;
  const stdout = r.stdout ?? '';
  let fault = null;
  if (r.error) fault = `it could not be started or did not finish (${r.error.code ?? r.error.message})`;
  else if (r.status !== probe.expect.exitCode)
    fault = `it exited ${r.status ?? `on ${r.signal}`}, expected ${probe.expect.exitCode}`;
  else {
    const absent = missingIncludes(stdout, probe.expect.stdoutIncludes);
    if (absent.length) fault = `its stdout lacks ${absent.map((a) => JSON.stringify(a)).join(', ')}`;
  }
  return {
    result: fault ? 'fail' : 'pass',
    detail: fault ?? `exited ${r.status}`,
    note: originNote,
    startedAt: started,
    durationMs,
  };
}

/** Send one request probe to the origin serving the change; `fetchImpl` is a seam. */
export async function runRequestProbe(probe, { origin, fetchImpl = fetch }) {
  const started = Date.now();
  const unrunnable = requestUnrunnable(probe, origin);
  if (unrunnable) {
    return { result: 'none', detail: `could not run: ${unrunnable}`, startedAt: started, durationMs: 0 };
  }
  const { method, path, headers, body } = probe.request;
  let res;
  let text;
  try {
    res = await fetchImpl(`${origin}${path}`, {
      method,
      headers: headers ?? {},
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    return {
      result: 'none',
      detail: `could not run: ${origin} did not answer (${e.cause?.code ?? e.name ?? e.message})`,
      startedAt: started,
      durationMs: Date.now() - started,
    };
  }
  const durationMs = Date.now() - started;
  let fault = null;
  if (res.status !== probe.expect.status) fault = `it answered ${res.status}, expected ${probe.expect.status}`;
  else {
    const absent = missingIncludes(text, probe.expect.bodyIncludes);
    if (absent.length) fault = `its body lacks ${absent.map((a) => JSON.stringify(a)).join(', ')}`;
  }
  return {
    result: fault ? 'fail' : 'pass',
    detail: fault ?? `answered ${res.status}`,
    startedAt: started,
    durationMs,
  };
}

/**
 * Run what the criteria owe and write each as a `probes` check, bound to the kept probe it ran.
 * `criteria` null is a run naming no issue: one check, result `none`, saying so.
 */
export async function runProbes(criteria, { root, origin, env, spawn, fetchImpl } = {}) {
  if (criteria === null) {
    const c = check({
      name: 'probes',
      kind: 'probes',
      scope: 'no issue',
      command: '--probes none',
      files: [],
      result: 'none',
      startedAt: Date.now(),
      durationMs: 0,
      note: 'this run names no issue, so it ran no kept probe; core holds the report to the kept probes of the issue it is recorded on',
    });
    return { checks: [c], bindings: [], missing: [], red: [] };
  }
  const { runs, missing } = probesOwed(criteria);
  const checks = [];
  const bindings = [];
  const red = [];
  const notRun = [...missing];
  for (const { criterion, probe } of runs) {
    const out =
      probe.kind === 'command'
        ? runCommandProbe(probe, { root, origin, env, spawn })
        : await runRequestProbe(probe, { origin, fetchImpl });
    const c = check({
      name: 'probes',
      kind: 'probes',
      scope: `criterion ${criterion}`,
      command: probeCommand(probe),
      files: [],
      result: out.result,
      startedAt: out.startedAt,
      durationMs: out.durationMs,
      note: [`probe ${probe.id}: ${out.detail}`, out.note].filter(Boolean).join('; ').slice(0, 500),
    });
    checks.push(c);
    bindings.push({ criterion, probe: probe.id, check: c.id });
    if (out.result === 'none') notRun.push({ criterion, why: out.detail });
    if (out.result === 'fail') red.push({ criterion, why: out.detail });
  }
  if (checks.length === 0) {
    checks.push(
      check({
        name: 'probes',
        kind: 'probes',
        scope: 'issue',
        command: 'the issue keeps no probe to run',
        files: [],
        result: 'none',
        startedAt: Date.now(),
        durationMs: 0,
      }),
    );
  }
  return { checks, bindings, missing: notRun, red };
}

/** The refusals a probe run ends in, by name, in the words core uses: none where every probe held. */
export function probeRefusalLines({ missing, red }) {
  const lines = [];
  if (missing.length)
    lines.push(
      `MERGE_PROBE_MISSING — ${missing.map((m) => `criterion ${m.criterion}: ${m.why}`).join('; ')}`,
    );
  if (red.length)
    lines.push(`MERGE_PROBE_RED — ${red.map((r) => `criterion ${r.criterion}: ${r.why}`).join('; ')}`);
  return lines;
}
