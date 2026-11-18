// The run's own account of its release (ISS-1334): the `note` its finish carried, kept on the run
// (`pipeline_runs.metadata.account`) and shown on the release page, the one place it is read from.
// A later finish carrying another note replaces it: the account is the run's latest word.

import { writeRunMetadata } from '../pipeline/index.js';

interface RunAccount {
  text: string;
  at: string;
}

export async function writeRunAccount(runId: string, text: string): Promise<void> {
  const account: RunAccount = { text, at: new Date().toISOString() };
  await writeRunMetadata(runId, { merge: { account }, touch: false });
}

/** The account a run's finish carried, or null where it carried none. */
export function runAccountOf(metadata: unknown): string | null {
  const raw = (metadata as { account?: { text?: unknown } } | null)?.account;
  return typeof raw?.text === 'string' && raw.text.length > 0 ? raw.text : null;
}
