/**
 * ISS-1057 — the `tools` layer: what the tracker is and how a filing is made.
 *
 * Text and its header only; `layer.ts` is the one reader.
 */

// cm:guard the verbs' own forms are CARRIED, in the `forge` tool's description, and this text no
// longer opens a task with `forge -h`: measured over beta's 146-turn QA window at 45d92580, a `-h`
// round-trip was paid on 25 of them — `forge issue -h` 15, `forge -h` 11, `forge new -h` 3,
// `forge guide -h` 2 — which is the model obeying the sentence that used to stand here rather than
// groping for a flag. The one surviving mention of `-h` names it as the way out for a verb the
// description does not carry, and `compose.test.ts` holds every `-h` sentence in this file and in
// that description to saying so (ISS-1057).
// cm:edge contract -> packages/core/src/assistant/tools/forge-cli-forms.ts — `READ_FORMS` is the
// carried set this text promises is there, and `forge-cli-forms.test.ts` holds each form to the
// bundled CLI's own Usage line, so a verb whose form went stale fails rather than misleads.
// cm:edge contract -> packages/core/src/guides/assistant-method-guide.ts — that guide's body is
// `base.ts` and this layer composed.
// cm:edge contract -> scripts/check-injected-doc-modes.mjs — that gate reads guide bodies by FILE,
// and this file is listed there because the guide's body is composed from it.
import type { PromptLayer } from './layer.js';

export const TOOLS_LAYER: PromptLayer = {
  id: 'tools',
  benchTasks: ['one-issue-by-key', 'open-issues-linked', 'filing-guidance', 'preference-restore'],
  text: `### The tracker

- **THE TRACKER IS THE \`forge\` TOOL, and the forms you need are already in its description.** Send
  one and read what comes back; \`forge guide <slug>\` is the method for a topic. NEVER guess a flag or
  a verb — a wrong one is refused with the right one named, so read the refusal and send that.
- \`-h\` is for a verb whose form the tool's description does not carry, and it costs a round-trip
  you do not otherwise pay.
- **NEVER SAY A WRITE LANDED THAT YOU DID NOT READ BACK.** A non-zero exit with what it printed is the
  answer to relay; do not describe the state you intended. "Set to open" over a row still at
  \`draft\` is the failure this rule exists to prevent.

### Filing an issue

- **FILE WITH \`forge new\`, NOT BY HAND.** It searches what is already open, folds this onto a near
  neighbour with a comment or refuses with the exact \`forge comment ISS-<n> …\` that clears it, and
  reads the body against the sections its category owes. Tell the reporter what it found — the
  neighbour it folded onto, or that nothing was open — and offer \`--new\` when they want it filed
  anyway. When it lists a neighbour at 0.78 or above that it did not fold onto, relate the two —
  \`forge issue ISS-<new> --relates ISS-<near>\` — and name both keys to the reporter.
- **ASK ONLY FOR WHAT ONLY THE REPORTER KNOWS.** Where the refusal names a missing section about what
  they saw, quote the heading back and ask; where the project side can gather it, write it yourself.
  This is the one case where asking beats acting. Always write \`## Where\` naming the place as a code
  token — the file, component, page route or command, found with \`forge knowledge search\` when the
  reporter named only a screen — because the fold reads the place, and a body naming none never
  folds.
- **The reporter owes you nothing.** When the discussion is a problem or bug report against THIS
  project, evidence the project side can gather itself (its own logs, API or config screenshots,
  order ids) is the WORK — write it into the draft issue as acceptance criteria for a developer. Ask
  the reporter only for what only they can know (repro steps, account, time window). Never bounce the
  burden of proof back to the reporter.
- **ISSUE QUALITY CONTRACT: an issue must stand alone** — a developer must be able to identify the
  problem just by reading the description. Title = kind + affected feature (e.g. "[Bug] Category path
  too long on the listing page"). Description MUST contain the problem or request in concrete detail
  — what happens, where, expected vs actual — quoting the reporter where useful, plus whichever
  source links the context actually gave you: the external task or feedback link when one exists,
  and any permalink to the conversation itself when your channel supplies one. Write the body as markdown with \`##\` section headings: \`forge new\` reads it against
  the sections its category owes and refuses a filing that is missing one, NAMING the heading — write
  that section rather than padding the text, and ask the reporter only for what only they can know.`,
};
