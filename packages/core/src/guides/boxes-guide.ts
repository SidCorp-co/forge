import { BOX_LIMITS, BOX_READ_VERBS } from '@forge/contracts/boxes';
import { RELEASE_CLIP_MAX_SECONDS } from '@forge/contracts/release-page';
import type { CoreGuide } from './types.js';

const reads = (verbs: readonly string[]) => verbs.map((v) => `\`${v}\``).join(', ');

/** ISS-1276: a UI test runs in a Forge Box a person can watch, take over and hand back. */
export const BOXES_GUIDE: CoreGuide = {
  slug: 'boxes',
  audience: 'agent',
  title: 'Forge Box: test a UI where a person can watch',
  summary:
    "Open a box (browser, android or desktop) for the issue and criterion you test, drive it with `forge-runner box act` or forge_box, mark each criterion's span so its clip attaches to the issue, and close it. A person may take control: your writes are refused BOX_HELD_BY_PERSON, your reads still answer; wait, read what they did, go on.",
  version: 1,
  doors: [
    'POST /api/projects/:id/boxes',
    'POST /api/boxes/:id/acts',
    'POST /api/boxes/:id/spans',
    'POST /api/boxes/:id/close',
  ],
  body: `## Forge Box: test a UI where a person can watch

A box is a screen Forge gives you to test a UI in: a web page (\`browser\`), an Android app
(\`android\`) or a Linux desktop app (\`desktop\`). The owner opens Forge and watches it live, takes
control, tests by hand, and hands it back. Every box records its session, so the criterion you show
there gets its clip without \`pnpm clip\`. Nothing forces a box on you: you choose to open one when
the criterion is something a person sees.

### 1. Open one
\`POST /api/projects/:id/boxes\` (or forge_box \`open\`) with the \`mode\`, the \`issueId\`, the
\`criterion\` you test and your \`runId\`. A browser box takes a \`viewport\` (390×844 for a phone)
and a \`url\`. The box runs on your run's device.

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

### 3. When a person holds it
While a person holds the box your writes are refused \`BOX_HELD_BY_PERSON\`, naming who and since
when, and nothing on the box changes. Wait and read: snapshot to follow along. When the box reads
\`agent\` again, read what they did (\`GET /api/boxes/:id/acts?by=person\`; your next act's answer
also says \`personActed\`) and go on from the screen as they left it. Never retry a refused write in
a loop, and never open a second box to get around a hold. A hold with no input for
${BOX_LIMITS.holdIdleSeconds}s expires back to you on the record.

### 4. Mark each criterion's span
Before you show a criterion, \`POST /api/boxes/:id/spans\` \`{ criterion, edge: "start" }\`; after,
\`{ criterion, edge: "end" }\`. Forge has the device cut the span's clip and its opening still and
attaches both to the issue as \`box-<box>-c<n>-<span>.webm\` and \`.png\`. Cite the clip in that
criterion's verdict evidence by its name, id or download URL. A span longer than
${RELEASE_CLIP_MAX_SECONDS}s keeps its last ${RELEASE_CLIP_MAX_SECONDS}s, so keep each demonstration
short.

### 5. Close it
\`POST /api/boxes/:id/close\` once the criteria are shown: the device reaps every process it started
and the room goes to the next request. The recording stays on the device until the issue ends.`,
};
