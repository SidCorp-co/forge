import type { OpenApiDocument } from '../document/build.js';
import { openApiPath } from '../document/build.js';

/** Who sends a call: the people and programs around core, not core itself. */
export type Actor = 'Person' | 'Runner' | 'Master' | 'Agent';

export type FlowStep = {
  readonly from: Actor;
  /** `METHOD /path` exactly as the route is mounted, so the check can find it in the document. */
  readonly call: string;
  /** What the call achieves and what the caller reads from the answer, written as a sentence. */
  readonly note: string;
};

export type Flow = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly FlowStep[];
};

/**
 * The orders of calls an agent drives. Each step names an operation by its method and path; a step
 * that names a route the app does not serve fails `checkFlows`, so a flow cannot go on describing
 * a call after the route was renamed or removed.
 */
export const FLOWS: readonly Flow[] = [
  {
    id: 'pair-a-runner',
    title: 'Pair a runner',
    summary:
      'A box asks for a pairing code, a person approves it in the browser, and the box collects the credential that makes it a device. The credential is shown once.',
    steps: [
      {
        from: 'Runner',
        call: 'POST /api/devices/login/init',
        note: 'A pairing code and the page the person opens, valid for ten minutes.',
      },
      {
        from: 'Person',
        call: 'POST /api/devices/login/approve',
        note: 'The code is bound to the person, or to an agent they administer.',
      },
      {
        from: 'Runner',
        call: 'GET /api/devices/login/poll',
        note: 'Answers 204 while pending, then the device credential once, and 410 after that.',
      },
      {
        from: 'Runner',
        call: 'POST /api/devices/heartbeat',
        note: 'The box reports itself with its new credential and is online.',
      },
      {
        from: 'Runner',
        call: 'GET /api/devices/me/runners',
        note: 'The projects this box is bound to, and where each is checked out.',
      },
    ],
  },
  {
    id: 'claim-and-finish-a-job',
    title: 'Claim and finish a job',
    summary:
      'A master reads the pool, takes a job in two acts so a failed start gives it back, and the runner reports it through to a terminal status.',
    steps: [
      {
        from: 'Master',
        call: 'GET /api/devices/me/pool',
        note: 'The queued jobs this box may take, with what is held.',
      },
      {
        from: 'Master',
        call: 'POST /api/devices/me/pool/prepare',
        note: 'The job is held for this session, with its token and prompt, and stays queued.',
      },
      {
        from: 'Master',
        call: 'POST /api/devices/me/pool/start',
        note: 'The stamp that ends the hold and makes the job run.',
      },
      {
        from: 'Runner',
        call: 'POST /api/jobs/:id/ack',
        note: 'The dispatch reached the box; a repeat reports acked false.',
      },
      {
        from: 'Runner',
        call: 'POST /api/jobs/:id/events',
        note: "A batch of the agent's events, in order.",
      },
      {
        from: 'Runner',
        call: 'POST /api/jobs/:id/complete',
        note: 'The job ends with its exit code and a summary; /fail and /blocked end it the other ways.',
      },
      {
        from: 'Master',
        call: 'POST /api/devices/me/pool/release',
        note: 'Gives back anything the session still holds.',
      },
    ],
  },
  {
    id: 'move-an-issue',
    title: 'Move an issue through its statuses',
    summary:
      'An issue is opened in a project and moved one status at a time. A move the issue has not earned is refused with the entry it lacks, and a status that waits on a person says what it needs.',
    steps: [
      {
        from: 'Agent',
        call: 'POST /api/projects/:id/issues',
        note: 'The issue, with its key and its first status.',
      },
      {
        from: 'Agent',
        call: 'GET /api/issues/:id',
        note: 'The issue as it stands, to read its status before moving it.',
      },
      {
        from: 'Agent',
        call: 'POST /api/issues/:id/transition',
        note: 'The new status, or a 409 or 422 naming what the move is owed.',
      },
      {
        from: 'Agent',
        call: 'POST /api/issues/:id/comments',
        note: 'The record the next status is earned on.',
      },
      {
        from: 'Agent',
        call: 'GET /api/issues/:id/activity',
        note: 'What moved the issue, in order.',
      },
    ],
  },
  {
    id: 'grant-and-use-a-token',
    title: 'Grant and use a token',
    summary:
      'A person with a fresh session mints a token that names what it may reach, hands it to an agent, and the agent sends it as a bearer. The secret is returned once.',
    steps: [
      {
        from: 'Person',
        call: 'GET /api/pat',
        note: 'The tokens already held, and the menu of permissions a new one may be granted.',
      },
      {
        from: 'Person',
        call: 'POST /api/pat',
        note: 'The token, returned once, granted exactly the permissions named.',
      },
      {
        from: 'Agent',
        call: 'GET /api/issues/:id',
        note: 'Sent as a bearer: allowed with issues:read, and a 403 naming the permission it lacks otherwise.',
      },
      {
        from: 'Person',
        call: 'GET /api/pat/:id/audit',
        note: 'What the token did.',
      },
      {
        from: 'Person',
        call: 'POST /api/pat/:id/rotate',
        note: 'A new secret for the same grant, the old one revoked.',
      },
      {
        from: 'Person',
        call: 'DELETE /api/pat/:id',
        note: 'The token is revoked.',
      },
    ],
  },
];

/**
 * The operation a step names, or null where the document has none under that method and path. A
 * step names a path by its shape, so `/api/issues/:id` finds the route whatever it calls the parameter.
 */
export function operationOfStep(
  document: OpenApiDocument,
  call: string,
): Record<string, unknown> | null {
  const [method, ...rest] = call.split(' ');
  const shape = (path: string) => openApiPath(path).replace(/\{[^}]+\}/g, '{}');
  const wanted = shape(rest.join(' '));
  for (const [path, operations] of Object.entries(document.paths)) {
    if (shape(path) === wanted) return operations[(method ?? '').toLowerCase()] ?? null;
  }
  return null;
}

/** Each step of each flow that names no operation of the document, by flow and step. */
export function checkFlows(document: OpenApiDocument, flows: readonly Flow[] = FLOWS) {
  const missing: Array<{ flow: string; step: number; call: string }> = [];
  for (const flow of flows) {
    flow.steps.forEach((step, index) => {
      if (!operationOfStep(document, step.call)) {
        missing.push({ flow: flow.id, step: index + 1, call: step.call });
      }
    });
  }
  return missing;
}

/** The longest a line of a drawn label may be: a sequence draws each gap as wide as its widest label. */
const LABEL_WIDTH = 34;

/** A label broken at word boundaries into lines no longer than `LABEL_WIDTH`, which mermaid breaks with `<br/>`. */
export function labelLines(text: string): string {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= LABEL_WIDTH)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.join('<br/>');
}

/**
 * A flow as a Mermaid sequence diagram: one arrow to core per step, one answer back. Core sits
 * between the two actors it talks to, so every arrow joins neighbouring lifelines and no label is
 * drawn across a third one. A flow of more than two actors has no such order, and is refused.
 */
export function toMermaid(flow: Flow): string {
  const actors = [...new Set(flow.steps.map((s) => s.from))];
  if (actors.length > 2) {
    throw new Error(
      `flow ${flow.id} names ${actors.length} actors (${actors.join(', ')}): a sequence with core between them crosses a lifeline with some label, so a flow names at most two`,
    );
  }
  const [left, right] = actors;
  const lines = [
    'sequenceDiagram',
    `  participant ${left}`,
    '  participant Core',
    ...(right ? [`  participant ${right}`] : []),
  ];
  flow.steps.forEach((step, index) => {
    lines.push(`  ${step.from}->>Core: ${index + 1}. ${step.call}`);
    lines.push(`  Core-->>${step.from}: ${labelLines(step.note.replace(/[;\n]/g, ','))}`);
  });
  return lines.join('\n');
}
