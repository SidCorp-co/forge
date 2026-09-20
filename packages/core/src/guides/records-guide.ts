// The record tier of the capability-guide registry, split out of registry.ts on
// size grounds. Same shape, same consumers.
//
// Altitude (NT1): teach an agent where each thing it has to record belongs, so
// the comment thread stays readable by a person. Not the schema of each store —
// each store's own tool carries that.

import {
  ISSUE_ASSERTION_ROUTE,
  RECORD_DESTINATIONS,
  RECORD_GUIDE_SLUG,
} from '../messaging/record-screen.js';
import type { ForgeGuide } from './types.js';

const route = (kind: string): string => `\`${RECORD_DESTINATIONS[kind] ?? ''}\``;

export const RECORDS_GUIDE: ForgeGuide = {
  slug: RECORD_GUIDE_SLUG,
  title: 'What a comment is for, and where a record goes',
  summary:
    'A comment carries what a person wrote for a person to read; a structured record goes to the store its kind names, with the comment keeping the pointer back.',
  version: 1,
  body: `## What a comment is for, and where a record goes

A comment is prose a person reads. Everything else a run has to record has a store of its own, and
putting it in the comment body instead is how a thread ends up 99% machine content with a hundred
characters of human writing in it. Measured on forge-dev, 2026-09-20: on two of five recent issues
the person's share of the thread was 98 and 123 characters against 26,000 and 46,000 of fences.

### What goes where

| What you have | Where it goes | Format |
|---|---|---|
| A sentence a person needs to read | \`comments\` | prose, no fence, no field list. Say what happened and what it means |
| A verdict on a step, per attempt | ${route('verdict')} → \`issue_step_contexts\` | the handoff payload, keyed \`(issue, step, attempt)\`, \`verdict\` typed |
| A review of a head, per attempt | ${route('review')} → \`issue_step_contexts\` | the same key; the findings are the payload |
| An assertion about the issue itself — blocking, delivered, obligation, supersedes, human_required | \`${ISSUE_ASSERTION_ROUTE}\` → \`issue_attributes\` | typed value under a registered key, \`sourceCommentId\` pointing at the line that asserted it |
| A transcript, a tool result, what the agent said | \`agent_session_turns\` | written by the session; never copied into a comment |
| A log, a diff, an evidence file | an attachment | the file, uploaded. A comment names it, does not paste it |
| Who moved this issue and when | \`kernel_transitions\` | written by the transition, not narrated |
| A lesson a *different* issue would reuse | \`forge_memory\` | one entry, natural key, refined not duplicated |
| Project prose — a rule, a build command, a guide | \`knowledge_entries\` | one slug, \`injection\` decides reach |

### What core has no store for, said plainly

A run's own records — a baseline, a decision, a correction, a park, a merged mark — have no store
here that holds them whole. \`issue_attributes\` takes ten registered keys of issue assertions and
refuses anything else by name, so a baseline's gate/result/commit does not fit it and a route that
would reject the write is not somewhere to be sent. Until one exists: put the assertions such a
record makes ABOUT the issue at \`${ISSUE_ASSERTION_ROUTE}\` under a registered key, and keep the
sentence in the comment. The rule says so rather than naming a route you would be refused at —
pointing somewhere that cannot hold it is the substitution this whole rule exists to refuse.

### Two rules

**A record and its human line are joined, not duplicated.** The structured row holds the fields;
the comment holds the sentence and the pointer. Neither repeats the other, and
\`issue_attributes.source_comment_id\` is what joins them — write the comment first, then send its
id as \`sourceCommentId\` on the attribute, and a reader of either can reach the other.

**A fence in a comment is the smell.** A \` \\\`\\\`\\\`forge-record \` block in a comment body means a
record was serialised instead of stored. That is what the \`record-in-comment\` rule refuses — by
name, telling you the route for your record's own kind, never by a character count. A cap could not
tell a 4,000-character record from a 4,000-character explanation somebody wants, and an agent
meeting a cap splits across comments rather than writing less. \`COMMENT_BODY_MAX_CHARS\` is not the
lever and is not moved.

### When the rule refuses and when it only warns

The refusal is reachable only through a capability the caller declares in the
\`x-forge-capabilities\` request header: a client that sends \`record-route\` is saying it has
somewhere else to write, so a fence from it is a bug and is refused 400. A client that declares
nothing is written and answered with a warning carrying the same sentence. That is deliberate — the
writer lives in a second repo on a different release clock, and a refusal that landed before its
callers could obey would break every one of them on a deploy they did not ask for.

The MCP comment door declares nothing and cannot: a tool handler is given its arguments and no
request context, so a fence written through \`forge_comments\` is warned and never refused. It is
still the wrong place to put a record.`,
};
