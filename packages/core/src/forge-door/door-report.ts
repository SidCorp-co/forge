/**
 * An agent's report that a door or a piece of teaching failed it (ISS-1251): the action it reached
 * for did not do what it needed, the guide, lesson or brief line did not say when or how, or no door
 * does what it needed. It is filed as feedback about Forge (REQ-47), naming the door and the feature
 * that owns it, under one signal key per door and verdict, so a second agent meeting the same gap adds
 * an occurrence to the one item rather than a new one, and the item's count says how often it bit.
 */

import {
  DOOR_REF_SHAPE,
  DOOR_REPORT_KIND,
  type DoorReportRefusalCode,
  type DoorReportRequest,
  type DoorReportVerdict,
} from '@forge/contracts/door-use';
import type { ForgeFeedbackFiled, ForgeFeedbackRequest } from '@forge/contracts/forge-feedback';
import type { ReadDoor } from '../feedback/index.js';
import { doorCatalog } from '../lib/door-catalog.js';
import type { Refusal } from '../lib/refusal.js';
import { type Answer, type ForgeDoorCaller, submitForgeFeedback } from './service.js';

/** The door or teaching a report names, as the catalog knows it. */
export interface ReportedDoor {
  /** The ref as filed: the catalog's id for a door, `<kind>:<key>` for teaching. */
  id: string;
  /** `whereSeen`: `tool <action>`, `route <METHOD /path>`, `guide <slug>`, … */
  where: string;
  feature: string;
}

const refusal = (code: DoorReportRefusalCode, detail: string): Refusal => ({
  code,
  path: '/door',
  detail,
});

const TEACHING = /^(guide|lesson|knowledge|skill|brief):\s*(\S.*)$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)$/;
const ACTION = /^([a-z_]+)\.([a-z_]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A logged path's ids as the contract writes its params, so one route reads as one door. */
const templateOf = (path: string) =>
  path
    .split('/')
    .map((s) => (UUID.test(s) ? ':id' : s))
    .join('/');

/** The door a report names, or the refusal saying which refs are doors. */
export function reportedDoor(ref: string): { ok: true; door: ReportedDoor } | Refusal {
  const teaching = TEACHING.exec(ref);
  if (teaching) {
    const [, kind, key] = teaching as unknown as [string, string, string];
    const where = kind === 'guide' || kind === 'skill' ? `${kind} ${key}` : `other ${kind} ${key}`;
    return {
      ok: true,
      door: { id: `${kind}:${key}`, where, feature: `teaching: the ${kind} ${key}` },
    };
  }
  const catalog = doorCatalog();
  const route = ROUTE.exec(ref);
  if (route) {
    const [, method, path] = route as unknown as [string, string, string];
    const found = catalog.doorOf({ tool: 'rest', action: `${method} ${path}` });
    const id = found?.id ?? `${method} ${templateOf(path)}`;
    return {
      ok: true,
      door: { id, where: `route ${id}`, feature: found?.feature ?? templateOf(path) },
    };
  }
  const action = ACTION.exec(ref);
  const found = catalog.doors.find((d) => d.surface === 'mcp' && d.id === ref);
  if (action && found) {
    return { ok: true, door: { id: found.id, where: `tool ${found.id}`, feature: found.feature } };
  }
  const near = action
    ? catalog.doors.filter((d) => d.surface === 'mcp' && d.id.startsWith(`${action[1]}.`))
    : [];
  return refusal(
    'DOOR_REPORT_UNKNOWN_DOOR',
    `${ref.slice(0, 120)} is no door Forge serves${
      near.length > 0 ? `; ${action?.[1]} serves ${near.map((d) => d.id).join(', ')}` : ''
    }. Name ${DOOR_REF_SHAPE}; forge_find { query } lists the actions by what they do.`,
  );
}

const SAYS: Record<DoorReportVerdict, string> = {
  did_not_help: 'did not do what the agent needed',
  unclear: 'did not say when or how to use it',
  missing: 'no door does what the agent needed',
};

/** The feedback a report files: the door and its feature named, under the door's own signal key. */
export function doorFeedbackOf(
  request: DoorReportRequest,
  door: ReportedDoor | null,
): ForgeFeedbackRequest {
  const about = door ? door.id : 'a missing door';
  const lines = [
    request.what,
    '',
    `Verdict: ${request.verdict} (${SAYS[request.verdict]}).`,
    door ? `Door: ${door.id}. Feature: ${door.feature}.` : 'Door: none yet.',
  ];
  return {
    kind: DOOR_REPORT_KIND[request.verdict],
    title: `${about}: ${SAYS[request.verdict]}`.slice(0, 300),
    body: lines.join('\n'),
    whereSeen: door ? door.where : 'other missing door',
    signalKey:
      `door:${request.verdict}:${door?.id ?? request.what.slice(0, 60).toLowerCase()}`.slice(
        0,
        200,
      ),
    ...(request.from ? { from: request.from } : {}),
  };
}

/** Files the report as the caller's own feedback about Forge, or refuses the door it names by name. */
export async function reportDoor(
  caller: ForgeDoorCaller,
  request: DoorReportRequest,
  readDoor: ReadDoor,
): Promise<Answer<ForgeFeedbackFiled & { door: ReportedDoor | null }>> {
  if (!request.door && request.verdict !== 'missing') {
    return {
      ok: false,
      refusals: [
        refusal(
          'DOOR_REPORT_DOOR_REQUIRED',
          `${request.verdict} is about one door or one piece of teaching: name it as ${DOOR_REF_SHAPE}`,
        ),
      ],
    };
  }
  let door: ReportedDoor | null = null;
  if (request.door) {
    const read = reportedDoor(request.door);
    if (!('ok' in read)) return { ok: false, refusals: [read] };
    door = read.door;
  }
  const filed = await submitForgeFeedback(caller, doorFeedbackOf(request, door), readDoor);
  return filed.ok ? { ok: true, value: { ...filed.value, door } } : filed;
}
