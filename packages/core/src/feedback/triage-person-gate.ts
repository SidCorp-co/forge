/**
 * The issue fields of a triage a person's web session may not send (REQ-68 BC-6): a person routes an
 * item to a fix, and the project's agents file or link the issue that carries it. An agent's or the
 * master's token sends them as before; the route reads this only on a session cookie.
 */

import type { FeedbackTriage } from '@forge/contracts/feedback';
import type { Refusal } from '../lib/refusal.js';

const FIELDS = [
  { field: 'issue', path: '/issue', sent: (t: FeedbackTriage) => t.issue !== undefined },
  {
    field: 'createIssue.title',
    path: '/createIssue/title',
    sent: (t: FeedbackTriage) => t.createIssue?.title !== undefined,
  },
  {
    field: 'createIssue.description',
    path: '/createIssue/description',
    sent: (t: FeedbackTriage) => t.createIssue?.description !== undefined,
  },
] as const;

/** One refusal per issue field a person's triage sent, at that field; empty where it sent none. */
export function personIssueActsOf(triage: FeedbackTriage): Refusal[] {
  return FIELDS.filter((f) => f.sent(triage)).map((f) => ({
    code: 'FEEDBACK_ISSUE_ACT_FORBIDDEN',
    path: f.path,
    detail: `a person names or titles no issue in a triage (\`${f.field}\`): route the item with \`{ route: "issue", createIssue: {} }\` and the project's agents file or link the issue that carries it`,
  }));
}
