// The box's pure guards (ISS-1276, ADR 0015): whether a mode can be served on a device, and whether
// an act may reach a box in the state it stands. Each answers the refusal's code and words, or null.

import type { BoxModeReport } from '@forge/contracts/box-wire';
import {
  BOX_ATTACH_MODES,
  BOX_MODES,
  BOX_UNSERVED_MODES,
  type BoxMode,
  type BoxRefusalCode,
  type BoxState,
} from '@forge/contracts/boxes';

export interface BoxFault {
  code: BoxRefusalCode;
  detail: string;
}

/** A mode string a request named, refused by name where no box serves it at all. */
export function modeFault(mode: string): BoxFault | null {
  if ((BOX_UNSERVED_MODES as readonly string[]).includes(mode)) {
    return {
      code: 'BOX_MODE_UNAVAILABLE',
      detail: `no box serves ${mode} yet: iOS needs a Mac or a device cloud no runner reports (the owner put iOS out of scope on 2026-11-17). Open a ${BOX_MODES.join(', ')} box instead`,
    };
  }
  if (!(BOX_MODES as readonly string[]).includes(mode)) {
    return {
      code: 'BOX_MODE_UNAVAILABLE',
      detail: `"${mode}" is not a box mode: a box is one of ${BOX_MODES.join(', ')}`,
    };
  }
  return null;
}

/** Whether the device's last report serves `mode`, and if not, what it lacks and the fix. */
export function deviceModeFault(
  mode: BoxMode,
  report: BoxModeReport | null,
  measured: boolean,
): BoxFault | null {
  if (!measured) {
    return {
      code: 'BOX_MODE_UNAVAILABLE',
      detail: `this device has not reported which box modes it serves: its runner predates Forge Box or has not run \`forge-runner doctor\`. Update the runner and run \`forge-runner setup\` on it`,
    };
  }
  if (report === null) {
    return {
      code: 'BOX_MODE_UNAVAILABLE',
      detail: `this device's runner does not report the ${mode} mode at all: update the runner and run \`forge-runner setup\``,
    };
  }
  if (report.serves) return null;
  const lacks = report.lacks.length > 0 ? report.lacks.join(', ') : 'something it did not name';
  return {
    code: 'BOX_MODE_UNAVAILABLE',
    detail: `this device cannot serve a ${mode} box: it lacks ${lacks}. Fix: ${report.fix ?? '`forge-runner setup` on the device'}`,
  };
}

/** Whether an agent's act of `kind` may reach a box in `state`; a person's hold refuses only writes. */
export function actFault(
  state: BoxState,
  kind: 'read' | 'write',
  held: { name: string; since: Date } | null,
): BoxFault | null {
  if (state === 'closed' || state === 'failed') {
    return { code: 'BOX_CLOSED', detail: `the box is ${state}: open a new one to go on` };
  }
  if (state === 'waiting' || state === 'opening' || state === 'warm') {
    return {
      code: 'BOX_NOT_READY',
      detail: `the box is ${state}, not running for you yet: read it (GET /api/boxes/:id) until it stands at agent, then act`,
    };
  }
  if (state === 'person' && kind === 'write') {
    const who = held
      ? `${held.name} has held it since ${held.since.toISOString()}`
      : 'a person holds it';
    return {
      code: 'BOX_HELD_BY_PERSON',
      detail: `${who}, so your state-changing act was refused and nothing on the box changed. Your reads (snapshot, get, screenshot) still answer: follow along, and act again once the box is handed back (its state reads agent). What the person did is in GET /api/boxes/:id/acts?by=person`,
    };
  }
  return null;
}

/** Why each mode outside `BOX_ATTACH_MODES` attaches nothing: what an attached tool would hold. */
const UNGUARDED: Record<Exclude<BoxMode, (typeof BOX_ATTACH_MODES)[number]>, string> = {
  android: "an android box's adb serial",
  desktop: "a desktop box's DISPLAY and AT-SPI bus",
};

const attachable = (mode: BoxMode): mode is (typeof BOX_ATTACH_MODES)[number] =>
  (BOX_ATTACH_MODES as readonly BoxMode[]).includes(mode);

const ACT_DOOR =
  'Drive it through the act door instead (`forge-runner box act <box> -- <command>`, forge_box act), which works from anywhere and where the hold binds';

/**
 * Whether an agent calling from `caller` (the device its credential is bound to, or none) may attach
 * to a box (ISS-1322): it runs, the caller is on its device, its mode's endpoint can be taken back
 * when a person takes the box, and the device reported one.
 */
export function attachFault(
  box: { state: BoxState; mode: BoxMode; deviceId: string; attach: { cdp: string } | null },
  caller: string | null,
): BoxFault | null {
  const state = actFault(box.state, 'read', null);
  if (state) return state;
  if (caller !== box.deviceId) {
    const from = caller
      ? `you call from device ${caller}`
      : 'the credential you call with is bound to no device';
    return {
      code: 'BOX_ATTACH_REMOTE',
      detail: `${from}, and the box runs on device ${box.deviceId}: its endpoint is that device's loopback, which no tunnel carries yet, so only an agent on that device attaches. ${ACT_DOOR}`,
    };
  }
  if (!attachable(box.mode)) {
    return {
      code: 'BOX_ATTACH_UNAVAILABLE',
      detail: `${UNGUARDED[box.mode]} cannot be taken back when a person takes the box, so Forge hands out no native endpoint for it. ${ACT_DOOR}`,
    };
  }
  if (!box.attach) {
    return {
      code: 'BOX_ATTACH_UNAVAILABLE',
      detail: `the device reported no CDP endpoint for this box: its runner predates attach (ISS-1322) or its proxy did not start (the runner's log says why). ${ACT_DOOR}`,
    };
  }
  return null;
}
