import {
  loadCredentialsByIssue,
  reportWithheld,
  withholdCredentials,
} from '../comments/credential-guard.js';
import { db, type Tx } from '../db/client.js';

/** The words a move carries that reach a record somebody reads: a comment, the activity feed, the kernel log, a question. */
const TOLD = ['reason', 'transitionReason', 'needs', 'voidQuestions'] as const;

type Told = { [K in (typeof TOLD)[number]]?: string | undefined };

/**
 * A move's own words with the project's stored test credentials replaced in place, once, before any
 * of them is written. The reason is posted as a comment, and is also kept as the activity row's
 * `reason`, the kernel transition's reason, the live event and a park question's prompt: each holds
 * what the comment holds because each is written from this, never from what was sent.
 */
export async function withholdTransitionText<T extends Told>(
  issueId: string,
  options: T,
  executor: Tx = db,
): Promise<T> {
  if (!TOLD.some((key) => options[key]?.trim())) return options;
  const credentials = (await loadCredentialsByIssue([issueId], executor)).get(issueId) ?? [];
  if (credentials.length === 0) return options;
  const out: T = { ...options };
  const ids: string[] = [];
  for (const key of TOLD) {
    const text = options[key];
    if (text === undefined) continue;
    const withheld = withholdCredentials(text, credentials);
    for (const id of withheld.ids) if (!ids.includes(id)) ids.push(id);
    out[key] = withheld.text as T[typeof key];
  }
  reportWithheld(issueId, ids);
  return out;
}
