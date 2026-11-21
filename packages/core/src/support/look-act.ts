// A room agent's look at a screen (ISS-1356; owner 2026-11-19: "it confirms UI that is not there").
// It opens a Forge Box (`boxes/`) in browser mode on one of the room's own project's environments, as
// the room's principal through the box door's own grant (project.write, the one a master's boxes
// take), waits for it to answer, and answers what the screen shows: the address, the accessibility
// snapshot and the screenshot, with the address a person watches the box at. A look again runs one
// browser command first; any address it names must be one of the same project's environments, and
// a box of another project is refused by name. Each look is kept on the room under its turn, which is
// what a reply's claim about a screen is read against (`screen-claims.ts`). Nothing refuses a reply
// for lacking a look: the act is a tool, taught by its card and the room guide.

import {
  SUPPORT_LOOK_READY_SECONDS,
  SUPPORT_LOOK_VIEWPORTS,
  type SupportLookRequest,
  type SupportLookView,
} from '@forge/contracts/support-look';
import { sessionRowById } from '../agent-sessions/index.js';
import { agentAct, boxById, closeBox, openBox } from '../boxes/index.js';
import { RefusalError } from '../lib/refusal.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { environmentsOf, readProjectDocument, sitesOf } from '../project-config/index.js';
import { namedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';

export type LookActInput = { action: 'look' } & SupportLookRequest;

/** How much of a snapshot a look answers; the rest is cut and says so. */
const SNAPSHOT_SHOWN = 12_000;

/** Each environment of the project with an address, by name, and every origin its sites serve. */
async function environmentsWithAddress(
  projectId: string,
): Promise<{ named: Map<string, URL>; origins: Set<string> }> {
  const held = await readProjectDocument(projectId);
  const named = new Map<string, URL>();
  const origins = new Set<string>();
  for (const env of held ? environmentsOf(held.document) : []) {
    for (const site of sitesOf(env)) {
      const url = urlOf(site.url);
      if (!url) continue;
      origins.add(url.origin);
      if (site.name === env.name) named.set(env.name, url);
    }
  }
  return { named, origins };
}

function urlOf(text: string | undefined): URL | null {
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** The driver verbs that move the page to an address, and those that run script in it. */
const NAVIGATES = new Set(['open', 'goto', 'navigate', 'tab', 'window']);
const SCRIPTS = new Set(['eval', 'evaluate', 'addscript', 'addinitscript']);

/**
 * Why a look's step may not run, or null where it may: it runs script, which reaches any address,
 * or it names an address on none of the project's environments (a bare host a navigation takes
 * included).
 */
export function stepRefusal(step: readonly string[], origins: ReadonlySet<string>): string | null {
  const verb = (step[0] ?? '').toLowerCase();
  if (SCRIPTS.has(verb)) {
    return `${verb} runs script in the page, which reaches any address: a look clicks, fills and opens addresses on its own project's environments only`;
  }
  for (const arg of step.slice(1)) {
    if (arg.startsWith('-')) continue;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(arg) ? urlOf(arg) : null;
    const outside = url ? !origins.has(url.origin) : NAVIGATES.has(verb) && /[./]/.test(arg);
    if (outside) {
      return `${arg} is on none of this project's environments (${[...origins].join(', ') || 'none declared'}): a look reaches only its own project's screens, by their full address`;
    }
  }
  return null;
}

const boxSaid = (err: unknown): string | null =>
  err instanceof RefusalError ? err.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ') : null;

/** Run `step`, answering a box refusal as the look's own, carrying the box's code and words. */
async function boxStep<T>(path: string, step: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await step() };
  } catch (err) {
    const said = boxSaid(err);
    if (said === null) throw err;
    return no('SUPPORT_LOOK_BOX_REFUSED', path, `${said}. Nothing was looked at.`);
  }
}

/** The box once it answers, or as it stands when the wait runs out. */
async function untilReady(id: string): Promise<{ state: string }> {
  const deadline = Date.now() + SUPPORT_LOOK_READY_SECONDS * 1000;
  for (;;) {
    const row = await boxById(id);
    const state = row?.state ?? 'gone';
    if (state !== 'opening' && state !== 'waiting') return { state };
    if (Date.now() >= deadline) return { state };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The device the room's session runs on, so the screenshot lands where the agent reads it. */
async function sessionDevice(room: RoomRow): Promise<string | null> {
  return room.sessionId ? ((await sessionRowById(room.sessionId))?.deviceId ?? null) : null;
}

const cut = (text: string, at: number) =>
  text.length > at ? `${text.slice(0, at)} [cut: ${text.length - at} more characters]` : text;

/** `look`: open a box on an environment and look, or look again on one an earlier look opened. */
export async function lookAct(
  room: RoomRow,
  input: LookActInput,
): Promise<Outcome<SupportLookView>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const project = await namedProject(room, undefined);
  if (!project.ok) return project;
  const actor = { userId: room.principalUserId, agency: 'agent' as const };
  const { named, origins } = await environmentsWithAddress(room.projectId);
  const names = [...named.keys()].join(', ') || 'none';

  let boxId: string;
  let environment: string | null = null;
  if (input.box) {
    if (input.environment || input.path || input.viewport) {
      return no(
        'SUPPORT_LOOK_ENVIRONMENT_UNKNOWN',
        '/box',
        'name a first look ({ thread, environment, path?, viewport? }) or a look again ({ thread, box, step?, close? }), never both. Nothing was looked at.',
      );
    }
    const row = await boxById(input.box);
    if (!row || row.projectId !== room.projectId || row.createdBy !== room.principalUserId) {
      return no(
        'SUPPORT_LOOK_OUTSIDE_PROJECT',
        '/box',
        `${input.box} is no box of ${project.value.slug}: look again only on a box a look of this room opened. Nothing was looked at.`,
      );
    }
    boxId = row.id;
    if (input.step) {
      const refused = stepRefusal(input.step, origins);
      if (refused)
        return no('SUPPORT_LOOK_OUTSIDE_PROJECT', '/step', `${refused}. Nothing was run.`);
      const ran = await boxStep('/step', () => agentAct(actor, boxId, input.step ?? []));
      if (!ran.ok) return ran;
    }
  } else {
    environment = input.environment ?? null;
    const base = environment ? named.get(environment) : undefined;
    if (!base) {
      return no(
        'SUPPORT_LOOK_ENVIRONMENT_UNKNOWN',
        '/environment',
        `${environment ? `${environment} is no environment of ${project.value.slug} with an address` : 'name the environment to look at'}: its environments with one are ${names}. Nothing was looked at.`,
      );
    }
    const url = new URL(input.path ?? '/', base).toString();
    const device = await sessionDevice(room);
    const open = (deviceId: string | null) =>
      openBox(actor, room.projectId, {
        mode: 'browser',
        url,
        viewport: SUPPORT_LOOK_VIEWPORTS[input.viewport ?? 'desktop'],
        ...(deviceId ? { deviceId } : {}),
      });
    // the session's own device first, so the shot lands where the agent reads it; another of the
    // project's devices where that one does not serve the project's boxes
    let opened = await boxStep('/environment', () => open(device));
    if (!opened.ok && device && opened.refusals[0]?.detail.startsWith('BOX_NO_DEVICE')) {
      opened = await boxStep('/environment', () => open(null));
    }
    if (!opened.ok) return opened;
    boxId = opened.value.id;
  }

  const watch = `${webBaseUrl() ?? ''}/projects/${project.value.slug}/boxes/${boxId}`;
  const { state } = await untilReady(boxId);
  if (state !== 'agent' && state !== 'person') {
    return {
      ok: true,
      value: { box: boxId, state, url: null, snapshot: null, shot: null, watch, closed: false },
    };
  }
  const read = async (command: string[]) => {
    const done = await boxStep('/box', () => agentAct(actor, boxId, command));
    return done.ok && done.value.act.state === 'done' ? (done.value.act.stdout ?? '') : null;
  };
  const at = (await read(['get', 'url']))?.trim() || null;
  const snapshot = await read(['snapshot']);
  const shot = (await read(['screenshot']))?.trim() || null;
  const closed =
    input.close === true && (await boxStep('/close', () => closeBox(boxId, actor))).ok === true;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: 'look',
    input: {
      box: boxId,
      ...(environment ? { environment } : {}),
      ...(input.step ? { step: input.step } : {}),
    },
    output: { url: at, shot, snapshot: snapshot !== null, closed },
  });
  return {
    ok: true,
    value: {
      box: boxId,
      state,
      url: at,
      snapshot: snapshot === null ? null : cut(snapshot, SNAPSHOT_SHOWN),
      shot,
      watch,
      closed,
    },
  };
}
