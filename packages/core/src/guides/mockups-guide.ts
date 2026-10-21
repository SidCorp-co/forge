import { MOCKUP_KIND_MIMES, MOCKUP_KINDS, MOCKUP_LIMITS } from '@forge/contracts/mockups';
import type { CoreGuide } from './types.js';

const kib = (bytes: number) => `${Math.round(bytes / 1024)} KiB`;
const kinds = MOCKUP_KINDS.map(
  (k) => `\`${k}\` (${MOCKUP_KIND_MIMES[k].join(', ')}, at most ${kib(MOCKUP_LIMITS.bytes[k])})`,
).join('; ');

export const MOCKUPS_GUIDE: CoreGuide = {
  slug: 'mockups',
  audience: 'agent',
  title: 'Mockups: proposed, tried and discussed on the item they shape',
  summary:
    'When to propose a mockup (MK-n) instead of describing a screen or building a local file, which item it belongs on, its kinds and limits, how a person tries it, pins comments to it and accepts or returns it in Approvals, how a next revision answers the comments, and how an accepted one is pinned into a requirement baseline.',
  version: 1,
  body: `## Mockups: proposed, tried and discussed on the item they shape

A mockup (MK-n) is a screen or a call proposed for a person to try before anything is built: a
wireframe board, a sketch, an image, a self-contained HTML page, or an API example. It lives on the
item it shapes, waits for a person like any other proposal, and is never edited: a change is its
next revision. The door is \`/api/projects/:id/mockups\`, the \`forge_design\` MCP tool's
\`mockup_*\` actions, and on a requirement's BA chat \`ba_propose_mockup\`.

### When to make one
- A requirement, a feedback item or an issue is about a screen, and words or the revision's picture
  will not settle what it looks like or how it behaves. Propose the mockup **before** the screen is
  built, so the person agrees on it, not on code.
- **Never build it as a local file, paste it as code in a chat, or publish it elsewhere.** A mockup
  outside Forge is one nobody can find, comment on or pin: the reason this guide exists is a screen
  built that way.
- The revision's **picture** stays what it is: the rough sketch shown at once with no accept. A
  mockup is what a person tries and decides.

### Which item it belongs on
Exactly one target per mockup:
- \`{ requirement: "REQ-n", revision? }\` — the requirement whose screen it shows, at the open draft
  or proposed revision, else the current one (\`revision\` left out picks that). A superseded or
  withdrawn revision takes none: \`MOCKUP_REVISION_SUPERSEDED\`.
- \`{ feedback: "FB-n" }\` — what a reporter or triager proposes as the fix for an item.
- \`{ issue: "ISS-n" }\` — a screen an issue builds that its requirement does not already show.
Prefer the requirement wherever one says what the screen is for. At most
${MOCKUP_LIMITS.openPerTarget} wait on one item (\`MOCKUP_QUEUE_FULL\`).

### Kinds and limits
${kinds}. A caption is at most ${MOCKUP_LIMITS.captionChars} characters, a name
${MOCKUP_LIMITS.nameChars}. Send exactly one of \`contentBase64\` with \`name\`, \`document\` (a
wireframe-v1 board) or \`source\` (an upload already in the project): \`MOCKUP_CONTENT_REQUIRED\`,
\`MOCKUP_TYPE_INVALID\` and \`MOCKUP_TOO_LARGE\` name what is wrong.

**An HTML mockup runs its own scripts, isolated from Forge.** The page is shown in a sandboxed frame
with scripts allowed and no same origin, under a policy that refuses every request a script makes:
it reads no Forge session, cookie or data and calls no API. So make it **one self-contained file**:
inline its CSS, scripts, images (as data: URIs) and sample data. The one exception is a library:
fonts from Google Fonts, and scripts and stylesheets from cdnjs.cloudflare.com, cdn.jsdelivr.net or
unpkg.com, load; nothing else does. State kept in the page lives only while it is open.

### How it is reviewed
1. **Proposed** — it waits on a holder of \`mockups.approve\`. It is listed on its item's page, where
   it opens full screen and runs, and in **Approvals** with an inline preview.
2. **Comments** — while it is proposed, or returned with no next revision, a person comments on it
   (\`POST …/mockups/MK-n/comments { body, pin? }\`, at most ${MOCKUP_LIMITS.commentsPerMockup}) and may
   pin the comment to a point \`{ x, y }\` or a region \`{ x, y, w, h }\` of the frame, each a fraction
   0..1 of its width and height. \`GET …/mockups/MK-n/comments\` reads every comment on it and on the
   revisions before it, with where each points and whether a revision settled it.
3. **Accepted or returned** — \`accept\` (a reason optional) or \`return\` (a reason required). Its author
   may \`withdraw\` it while it waits. A decided mockup stays decided.
4. **Next revision** — a returned mockup is answered by proposing it again with \`revises: "MK-n"\`. It
   keeps the item (a requirement moves to its open or current revision), counts its \`round\`, and
   settles each comment it names: \`answers: [{ comment, note? }]\` for one it changed,
   \`resolves: [{ comment, note }]\` for one it closes without a change. A comment not on that mockup or
   an earlier revision is \`MOCKUP_COMMENT_UNKNOWN\`, one already settled \`MOCKUP_COMMENT_SETTLED\`, a
   mockup not returned or already revised \`MOCKUP_REVISES_INVALID\`. Earlier revisions stay readable.
   Read the comments first and settle every open one you addressed.

### Pinned into a baseline
An **accepted** mockup of a requirement is pinned by its next agree or re-pin, beside the linked
designs: an agreed requirement whose mockup is accepted later is re-pinned to take it in. A job on
an issue of that requirement is given each pinned mockup as a line with its fetch
(\`GET …/mockups/MK-n/content\`), and a job on an issue is given the mockups accepted on that issue.
On a \`no_egress\` project the bytes are withheld from agents and the line says so.

### Talking about one
- Feedback can be filed **about a mockup**: \`mockup: "MK-n"\` as its one target.
- Opened full screen on its item's page, a mockup is what the Ask Agent panel's chat is about: the
  assistant reads its text, its comments and where they point.`,
};
