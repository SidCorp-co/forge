// The Forge Box door on MCP (ISS-1276): `forge_box` open, act, span, close and read, each calling what
// its REST route calls (`routes.ts`, `forge-runner box act`), so the two count as one door
// (`mcp/twins.ts`). Teaching, never forcing: core infers no criterion's need for a box; the agent
// chooses to open one.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { type ContextScopedMcpToolFactory, sourceOf, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { onArg, onResolved } from '../permissions/index.js';
import { agentAct } from './acts.js';
import { attachBox } from './attach.js';
import { setBoxRecording } from './recording.js';
import { closeBox, openBox, readBox } from './service.js';
import { markSpan } from './spans.js';

const ACTIONS = ['open', 'act', 'attach', 'span', 'record', 'close', 'read'] as const;

const inputSchema = z.strictObject({
  action: z.enum(ACTIONS),
  projectId: z.uuid().optional().describe('open: the project'),
  boxId: z.uuid().optional().describe('act, attach, span, record, close, read: the box'),
  mode: z.string().optional().describe('open: browser, android or desktop'),
  issueId: z.uuid().optional().describe('open: the issue the box tests'),
  criterion: z.number().int().min(1).optional().describe('open, span: the criterion number'),
  runId: z.string().optional().describe('open, act, attach: your run (FORGE_RUN)'),
  viewport: z
    .strictObject({ width: z.number().int(), height: z.number().int() })
    .optional()
    .describe('open: a browser box’s size, e.g. 390×844'),
  url: z.string().optional().describe('open: where a browser box starts'),
  record: z
    .boolean()
    .optional()
    .describe('open: record the whole session (off by default); record: true starts, false stops'),
  command: z.array(z.string()).optional().describe('act: the driver argv, e.g. ["click", "@e22"]'),
  edge: z.enum(['start', 'end']).optional().describe('span: start or end'),
});

export const BOX_CARDS = {
  open: {
    purpose:
      'Opens a Forge Box: a browser, Android or desktop screen you use a UI in as a person would, which a person can watch live from Forge and take over.',
    situations: [
      {
        when: 'you build or judge a criterion a person sees (a page, an app screen, a desktop window)',
        do: "open a box in its mode with the issue and criterion (a builder at its first UI change, on its worktree's dev server), then drive it with `forge-runner box act <box> -- <command>`, never a private Playwright script",
        watch:
          'it answers BOX_SLOT_UNAVAILABLE with its place and reason when the device is busy: it starts on its own, read the box until it runs',
      },
    ],
    practice: [
      'Name the mode (browser, android, desktop), the issue and the criterion; a browser box takes a viewport such as 390×844 and a url. ios, and a mode the device lacks, are refused BOX_MODE_UNAVAILABLE by name.',
      'Nothing records unless asked: leave `record` off and mark a span for each criterion you show, which records its own clip; `record: true` only when the whole session is evidence.',
      'It reads opening until its screen answers: read it until agent. One failed BOX_DEVICE_GONE names the box its request goes on as. Close the box once the criterion is shown.',
    ],
    example: {
      mode: 'browser',
      issueId: '<issue id>',
      criterion: 2,
      viewport: { width: 390, height: 844 },
      url: 'http://localhost:5173',
    },
    redFlag:
      'A screen proven by a render test or a private Playwright script, where nobody can watch it and no clip reaches the criterion.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ['a screen proven by a private script and a clip cut by hand'],
  },
  act: {
    purpose:
      'Runs one driver command on your box (agent-browser, agent-device or agent-desktop): what `forge-runner box act` and MCP forge_box call.',
    situations: [
      {
        when: 'you drive a box: snapshot, click, fill, type, open',
        do: 'send the command as its argv; a read (snapshot, get, screenshot, wait) always answers',
      },
      {
        when: 'your act is refused BOX_HELD_BY_PERSON',
        do: 'a person holds the box: wait and read (snapshot, get) until it reads agent again, then read what they did in the acts feed (`?by=person`) and go on from where they left it',
        watch:
          'never retry the write in a loop, and never open a second box to get around the hold',
      },
    ],
    practice: [
      'The answer carries `personActed` after a hand-back: read that feed before your next write.',
      'A slow command answers `pending`; read it later in GET /api/boxes/:id/acts.',
      'After each change, screenshot and look: layout, copy, the empty, error and loading states, and phone width (`set viewport 390 844`).',
    ],
    example: { command: ['click', '@e22'] },
    redFlag: 'Retrying a refused write while a person holds the box.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ['an agent click while a person held the box'],
  },
  attach: {
    purpose:
      "Gives an agent on the box's device a browser box's CDP URL, so its Playwright or MCP flow drives the browser the person watches.",
    situations: [
      {
        when: 'you already drive browsers with Playwright or chrome-devtools-mcp and the screen is one a person should see',
        do: 'attach to your box and connect the tool to the URL it answers (`chromium.connectOverCDP(url)`, `chrome-devtools-mcp --browserUrl url`), never a private headless browser',
        watch:
          'while a person holds the box your tool’s input and navigation answer BOX_HELD_BY_PERSON and the page does not move; reads still answer',
      },
    ],
    practice: [
      'The act door comes first: agent-browser’s snapshot and refs are compact for an agent. Attach only when a flow you already have is worth keeping.',
      'Only an agent on the box’s device attaches (BOX_ATTACH_REMOTE elsewhere), and only a browser box (BOX_ATTACH_UNAVAILABLE for android and desktop): use act for those.',
      'Every write your tool makes reaches the box’s feed `via: cdp` by its method name; a refused one reads refused.',
    ],
    example: { boxId: '<box id>', runId: '<your run>' },
    redFlag:
      'A private headless Chrome launched for a UI a person should watch, or a refused CDP write retried in a loop while a person holds the box.',
    family: 'issue-work',
    audience: ['master', 'run'],
    scenarios: ['a Playwright flow that launched its own headless Chrome nobody could watch'],
  },
  span: {
    purpose:
      "Marks a criterion's demonstration; the span records itself, and Forge attaches its clip and opening still to the issue.",
    situations: [
      {
        when: 'you are about to show a criterion on a box',
        do: "mark the criterion's span start, show it, mark its end, then cite the attached clip in the verdict's evidence",
        watch:
          "the span's start begins the recording and its end stops it, so a clip needs no recording left running",
      },
    ],
    practice: [
      'Record a span when the clip is a criterion’s evidence, never exploratory work: explore first, then mark the span and show it.',
      'A span longer than the release page ceiling keeps its last 20 seconds: keep the demonstration short.',
      'The clip attaches as box-<box>-c<n>-<span>.mp4 with a .png still; cite it by name, id or download URL (VERDICT_CLIP_REQUIRED reads it there).',
    ],
    example: { criterion: 2, edge: 'start' },
    redFlag: 'Cutting a clip by hand for a criterion you just showed on a box.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ["a criterion's span marked on a box"],
  },
  record: {
    purpose:
      "Starts or stops a box's recording. Nothing records by default, because recording costs the device's resources; a span records its own clip.",
    situations: [
      {
        when: 'the whole session, not one criterion, is the evidence (a flow a person must replay)',
        do: 'turn recording on with record: true, and off with record: false when that part is done',
        watch:
          'a recording you turned on keeps running past every span’s end until you stop it or close the box',
      },
    ],
    practice: [
      'For a criterion’s clip, mark its span instead: the span starts and stops the recording itself.',
      'Never record exploratory work: it costs disk and CPU and no verdict reads it.',
    ],
    example: { boxId: '<box id>', record: true },
    redFlag: 'Recording a whole session to cut one criterion’s clip from it.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ['a browser box that recorded 21 MB nobody asked for'],
  },
  close: {
    purpose:
      'Closes a box: the device reaps every process it started; the recording stays until the issue ends.',
    situations: [
      {
        when: 'the criteria you opened a box for are shown',
        do: 'close the box so its room goes to the next request',
      },
    ],
    practice: ['A waiting box closed leaves the queue at once.'],
    example: { boxId: '<box id>' },
    redFlag:
      'A box left open after its criteria are shown, holding room another request waits for.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ['a box closed once its criterion was shown'],
  },
  read: {
    purpose:
      'Reads a box: its state, who holds it and since when, its place in the queue, its view.',
    situations: [
      {
        when: 'your box waits (BOX_SLOT_UNAVAILABLE) or a person holds it',
        do: 'read it until it stands at agent; its queue names its place and the health reason it waits on',
      },
    ],
    practice: [
      'A waiting box starts on its own when the device’s health leaves room: never open a second one.',
    ],
    example: { boxId: '<box id>' },
    redFlag: 'Opening another box because the first one waits.',
    family: 'issue-work',
    audience: ['master', 'run', 'person'],
    scenarios: ['a box that waited on CPU pressure, read until it ran'],
  },
} satisfies Record<string, CapabilityCardBody>;

const DESCRIPTION = [
  'Forge Box: a browser, Android or desktop screen you test a UI in, which a person watches live from Forge and can take over.',
  'open {projectId, mode, issueId, criterion, runId, viewport?, url?, record?}: a box, opening until it is ready, or BOX_SLOT_UNAVAILABLE naming its place and why while it waits.',
  'act {boxId, command, runId}: one driver command; a write is refused BOX_HELD_BY_PERSON while a person holds the box, a read always answers.',
  'attach {boxId, runId}: for an agent on the box’s device, a browser box’s CDP URL for Playwright connectOverCDP or chrome-devtools-mcp --browserUrl; the hold still binds and its writes reach the feed via cdp.',
  "span {boxId, criterion, edge}: mark a criterion's demonstration; a span records its own clip, which attaches to the issue with its still.",
  'record {boxId, record}: start or stop recording; nothing records unless asked, so record a span, not exploratory work.',
  'close {boxId}; read {boxId}.',
].join(' ');

export const forgeBoxTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_box',
  reach: 'project',
  route: '/api/boxes',
  grant: {
    byAction: Object.fromEntries(
      ACTIONS.map((a) => [a, a === 'read' ? 'pipeline:read' : 'pipeline:write']),
    ),
  },
  permission: {
    byAction: {
      open: onArg('project.write'),
      act: onResolved('project.write', "the box's project, found from the box"),
      attach: onResolved('project.write', "the box's project, found from the box"),
      span: onResolved('project.write', "the box's project, found from the box"),
      record: onResolved('project.write', "the box's project, found from the box"),
      close: onResolved('project.write', "the box's project, found from the box"),
      read: onResolved('project.read', "the box's project, found from the box"),
    },
  },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  cards: BOX_CARDS,
  source: sourceOf(import.meta.url),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const actor = { userId: ctx.principal.userId, agency: principalAgency(ctx.principal) };
    const boxId = () => need({ boxId: input.boxId }, input.action, 'boxId').boxId;
    switch (input.action) {
      case 'open':
        return {
          box: await openBox(
            actor,
            need({ projectId: input.projectId }, 'open', 'projectId').projectId,
            {
              mode: need({ mode: input.mode }, 'open', 'mode').mode,
              ...(input.issueId ? { issueId: input.issueId } : {}),
              ...(input.criterion ? { criterion: input.criterion } : {}),
              ...(input.runId ? { runId: input.runId } : {}),
              ...(input.viewport ? { viewport: input.viewport } : {}),
              ...(input.url ? { url: input.url } : {}),
              ...(input.record !== undefined ? { record: input.record } : {}),
            },
          ),
        };
      case 'act':
        return agentAct(
          actor,
          boxId(),
          need({ command: input.command }, 'act', 'command').command,
          input.runId,
        );
      case 'attach':
        return attachBox(actor, ctx.principal.deviceId ?? null, boxId(), input.runId);
      case 'span':
        return {
          span: await markSpan(
            actor,
            boxId(),
            need({ criterion: input.criterion }, 'span', 'criterion').criterion,
            need({ edge: input.edge }, 'span', 'edge').edge,
          ),
        };
      case 'record':
        return {
          box: await setBoxRecording(
            boxId(),
            actor,
            need({ record: input.record }, 'record', 'record').record,
          ),
        };
      case 'close':
        return { box: await closeBox(boxId(), actor) };
      case 'read':
        return { box: await readBox(boxId(), actor) };
    }
  },
});
