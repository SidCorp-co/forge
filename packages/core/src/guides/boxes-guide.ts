import { BOX_LIMITS, BOX_READ_VERBS } from '@forge/contracts/boxes';
import { RELEASE_CLIP_MAX_SECONDS } from '@forge/contracts/release-page';
import type { CoreGuide } from './types.js';

const reads = (verbs: readonly string[]) => verbs.map((v) => `\`${v}\``).join(', ');

/** ISS-1276, ISS-1320: a screen is used in a Forge Box a person can watch, take over and hand back, by its builder from the first UI change and by its judge. */
export const BOXES_GUIDE: CoreGuide = {
  slug: 'boxes',
  audience: 'agent',
  title: 'Forge Box: use a screen as a person would, where a person can watch',
  summary:
    "A screen is proven by being used: its builder opens a box (browser, android or desktop) on its worktree's dev server from the first UI change, and its judge on the running build. Drive it with `forge-runner box act` or forge_box; an agent on the box's device with a Playwright or MCP flow attaches it to the box's browser instead of a private headless one. Screenshot and look after each change, mark each criterion's span so it records its own clip and attaches it to the issue, and close it. Nothing records unless asked. A person may take control: your writes are refused BOX_HELD_BY_PERSON, your reads still answer; wait, read what they did, go on.",
  version: 6,
  doors: [
    'POST /api/projects/:id/boxes',
    'POST /api/boxes/:id/acts',
    'POST /api/boxes/:id/attach',
    'POST /api/boxes/:id/spans',
    'POST /api/boxes/:id/recording',
    'POST /api/boxes/:id/close',
  ],
  body: `## Forge Box: use a screen as a person would, where a person can watch

A box is a screen Forge gives you to use a UI in: a web page (\`browser\`), an Android app
(\`android\`) or a Linux desktop app (\`desktop\`). The owner opens Forge and watches it live, takes
control, tests by hand, and hands it back. A screen is proven by being used there, not by a render
test that lays nothing out: its builder uses it while building, its judge on the running build. A
criterion you show there gets its clip from its span (step 5). Nothing refuses work done without a
box; a screen line its judge marked no visual for reads "visual owed" on its release.

### 1. Open one
\`POST /api/projects/:id/boxes\` (or forge_box \`open\`) with the \`mode\`, the \`issueId\`, the
\`criterion\` you work and your \`runId\`. A browser box takes a \`viewport\` (1440×900 on a desktop,
390×844 for a phone) and a \`url\`. The box runs on your run's device. It answers \`opening\` until
its screen answers, a warm box handed to you included; read it until it stands at \`agent\`.

- **A builder opens one at its first UI change**, not at the end: a browser box whose \`url\` is its
  worktree's dev server on localhost (start it on a port of your own; the box shares your device),
  or an android box on the dev build. Keep it open while you build: a box nothing used for
  ${BOX_LIMITS.agentIdleSeconds / 60} minutes (no act, span or recording change) closes on the record and
  reads \`closedWhy: idle\`; open a new one.
- **A person watches it at its own address**: \`/projects/<project slug>/boxes/<box id>\` on Forge's web
  app opens the box's screen alone, full screen, where they can take control. Link that address
  wherever you ask a person to watch (an issue comment, a room post), not the Boxes page.
- **A credential that cannot drive a box is refused its open** \`PAT_GRANT_PREDATES_ROUTE\`, as it
  is every box call: the refusal names who mints one that reaches the box, and by which door.

- **Nothing records unless asked.** Recording costs the device's CPU and disk, so a box records
  only while something needs it: a criterion's span (step 5) records itself. Add \`record: true\`
  only when the whole session is the evidence, and never record exploratory work. A recording you
  asked for runs until you stop it (\`POST /api/boxes/:id/recording\` \`{ on: false }\`, forge_box
  \`record\`) or close the box; a person may turn it on or off from the Boxes page.
- **A box whose screen is gone** (an emulator that died, a browser daemon or display gone) fails
  \`BOX_DEVICE_GONE\` with what the check found, and is never handed out. If it was being handed
  to you, its detail names the box your request goes on as: read that one.

- **It may wait.** A device starts a box while its measured health has room (memory past its reserve,
  CPU pressure under its ceiling, disk) for the mode's cost: there is no count of boxes. When there
  is no room the open answers \`BOX_SLOT_UNAVAILABLE\` naming the box, its place in the queue and
  why, and the box starts on its own when room returns. Read it (\`GET /api/boxes/:id\`) until it
  stands at \`agent\`; do not open another.
- **A mode the device lacks** is refused \`BOX_MODE_UNAVAILABLE\` with what it lacks and the fix.
  \`ios\` is refused by name: no box serves it yet.

### 2. Drive it
\`forge-runner box act <box> -- <command>\` (\`POST /api/boxes/:id/acts\`, forge_box \`act\`) runs
one command of the mode's driver: agent-browser for a browser box, agent-device for android,
agent-desktop for desktop. Every act goes through Forge, which keeps the box's one lock.

- **Reads always answer:** browser ${reads(BOX_READ_VERBS.browser)}; android
  ${reads(BOX_READ_VERBS.android)}; desktop ${reads(BOX_READ_VERBS.desktop)}. Every other verb is a
  write.
- **A slow act answers \`pending\`** after ${BOX_LIMITS.actWaitSeconds}s; read it in
  \`GET /api/boxes/:id/acts\`.
- **After each change, walk the criterion as a user:** \`snapshot\` to find, act, then
  \`screenshot\` and look at it. Judge the layout, the copy, the empty, error and loading states, and
  phone width (\`set viewport 390 844\`, then back to \`1440 900\`). What you see there is the proof; a
  private Playwright or headless-Chrome script is not.

### 3. Bring a tool you already use: attach
The act door comes first: agent-browser's snapshot and refs are compact for an agent, and every act
is on the record. When you already drive browsers with Playwright or chrome-devtools-mcp, attach it
to the box rather than start a browser of your own: \`forge-runner box attach <box>\`
(\`POST /api/boxes/:id/attach\`, forge_box \`attach\`) answers a browser box's CDP URL, served by
the device's proxy. Connect to it (\`chromium.connectOverCDP(url)\`, \`chrome-devtools-mcp
--browserUrl url\`) and your tool drives the browser the person watches.

- **Never start a private headless browser for a UI a person should see**: nobody watches it, takes
  it or reads what it did.
- **Only an agent on the box's device attaches**: the URL is that device's loopback, and a caller
  elsewhere is refused \`BOX_ATTACH_REMOTE\`. An android or desktop box is refused
  \`BOX_ATTACH_UNAVAILABLE\`, since its adb serial or display cannot be taken back when a person
  takes the box: drive those with act.
- **The hold binds:** while a person holds the box, every call that is not a read (\`Input.*\`,
  \`Page.navigate\`, \`Runtime.evaluate\` and the rest) answers a CDP error naming
  \`BOX_HELD_BY_PERSON\` and the page does not move; reads (a domain's \`enable\`, \`get…\`,
  screenshots) still answer. Do as step 4 says.
- **The feed sees it:** each write your tool makes is in the act feed \`via: cdp\` by its method
  name, a refused one as refused.

### 4. When a person holds it
While a person holds the box your writes are refused \`BOX_HELD_BY_PERSON\`, naming who and since
when, and nothing on the box changes. Wait and read: snapshot to follow along. When the box reads
\`agent\` again, read what they did (\`GET /api/boxes/:id/acts?by=person\`; your next act's answer
also says \`personActed\`) and go on from the screen as they left it. Never retry a refused write in
a loop, and never open a second box to get around a hold. A hold with no input for
${BOX_LIMITS.holdIdleSeconds}s expires back to you on the record.

### 5. Mark each criterion's span
Record a span when the clip is a criterion's evidence, never exploratory work: explore first, then
mark it and show the criterion. Before you show it, \`POST /api/boxes/:id/spans\`
\`{ criterion, edge: "start" }\`; after, \`{ criterion, edge: "end" }\`. A span begun on a box
that is not recording starts its recording, and the last open span's end stops it; a recording
someone asked for keeps running. Forge has the device cut the span's clip and its opening still and
attaches both to the issue as \`box-<box>-c<n>-<span>.mp4\` and \`.png\`. Cite the clip in that
criterion's verdict evidence by its name, id or download URL: \`VERDICT_CLIP_REQUIRED\` reads the
span's clip there like any clip attached to the issue. A span longer than
${RELEASE_CLIP_MAX_SECONDS}s keeps its last ${RELEASE_CLIP_MAX_SECONDS}s, so keep each demonstration
short.

### 6. Close it
\`POST /api/boxes/:id/close\` once the criteria are shown: the device reaps every process it started
and the room goes to the next request. What it recorded stays on the device until the issue ends.`,
};
