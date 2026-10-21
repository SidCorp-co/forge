// The steward's act catalogue as doors (REQ-48 BC-12): each tool a steward turn may call is one
// existing REST door, called through core's own app with the steward account's token, so the door
// checks the steward's access as it would any client's. A read answers the turn; a write that lands
// is logged in `steward_acts` with what it wrote and the door that undoes it, and one the door
// refuses is kept on the run, which then ends failed naming it.

import type { StewardAct } from '@forge/contracts/steward';
import { STEWARD_ACT_DOORS } from '@forge/contracts/steward-runtime';
import { z } from 'zod';
import { recordAct } from './acts-store.js';
import { doorName, refusalCodeOfAnswer } from './door-call.js';
import { type DoorContext, type DoorSpec, key, read } from './door-kit.js';
import { LESSON_CONFUSION } from './door-lessons.js';
import { WRITE_DOORS } from './door-writes.js';

export type { DoorContext } from './door-kit.js';

const READS: DoorSpec<never>[] = [
  read(
    'steward_read_standings',
    "Read the project's open items' standings: group, waiting on, due, stuck and basis.",
    z.strictObject({}),
    (_a, ctx) => `/api/projects/${ctx.projectId}/standings`,
  ),
  read(
    'steward_read_requirement',
    'Read a requirement by key: its head revision, criteria, links and issues.',
    z.strictObject({ requirement: key }),
    (a, ctx) => `/api/projects/${ctx.projectId}/requirements/${encodeURIComponent(a.requirement)}`,
  ),
  read(
    'steward_read_feedback',
    'Read a feedback item by key.',
    z.strictObject({ feedback: key }),
    (a, ctx) => `/api/projects/${ctx.projectId}/feedback/${encodeURIComponent(a.feedback)}`,
  ),
  read(
    'steward_read_issue',
    'Read an issue by key: status, plan, criteria and their verdicts.',
    z.strictObject({ issue: key }),
    (a, ctx) => `/api/issues/${encodeURIComponent(a.issue)}?projectId=${ctx.projectId}`,
  ),
  read(
    'steward_read_suggestion',
    "Read a requirement's proposed suggestions, the breakdown among them.",
    z.strictObject({ requirement: key }),
    (a, ctx) =>
      `/api/projects/${ctx.projectId}/suggestions?requirement=${encodeURIComponent(a.requirement)}&status=proposed`,
  ),
  read(
    'steward_read_master_standing',
    "Read whether the project's master serves: in_pass, runs_out, idle, waiting_person, silent or none.",
    z.strictObject({}),
    (_a, ctx) => `/api/projects/${ctx.projectId}/masters/standing`,
  ),
] as unknown as DoorSpec<never>[];

const CATALOGUE: ReadonlyMap<string, DoorSpec<never>> = new Map(
  [...READS, ...WRITE_DOORS, LESSON_CONFUSION as unknown as DoorSpec<never>].map((d) => [
    d.name,
    d,
  ]),
);

/** The doors one act may call, as tools: its menu in `STEWARD_ACT_DOORS`. */
export function doorsOf(act: StewardAct): DoorSpec<never>[] {
  return STEWARD_ACT_DOORS[act].map((name) => {
    const spec = CATALOGUE.get(name);
    if (!spec)
      throw new Error(`steward: ${act} names door ${name}, which the catalogue does not hold`);
    return spec;
  });
}

/** One door call: parsed, made, and logged where it was a write that landed. */
export async function callStewardDoor(
  name: string,
  argsJson: string,
  ctx: DoorContext,
): Promise<{ ok: boolean; text: string }> {
  const spec = CATALOGUE.get(name);
  if (!spec) return { ok: false, text: JSON.stringify({ error: `no steward door named ${name}` }) };
  let raw: unknown;
  try {
    raw = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { ok: false, text: JSON.stringify({ error: `${name}: the arguments are not JSON` }) };
  }
  const parsed = spec.params.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      text: JSON.stringify({ error: `${name}: ${z.prettifyError(parsed.error)}` }),
    };
  }
  const { request, answer, act } = await spec.call(parsed.data, ctx);
  if (!answer.ok) {
    if (spec.write) {
      ctx.refused.push(
        `${doorName(request)}: ${refusalCodeOfAnswer(answer) ?? answer.status} ${answer.text.slice(0, 300)}`,
      );
    }
    return {
      ok: false,
      text:
        answer.text || JSON.stringify({ error: `${doorName(request)} answered ${answer.status}` }),
    };
  }
  if (spec.write && act) {
    ctx.acts.push(
      await recordAct({ ...act, runId: ctx.runId, projectId: ctx.projectId, act: ctx.act }),
    );
  }
  return { ok: true, text: answer.text };
}

export function doorJsonSchema(spec: DoorSpec<never>): Record<string, unknown> {
  return z.toJSONSchema(spec.params, { io: 'input' }) as Record<string, unknown>;
}
