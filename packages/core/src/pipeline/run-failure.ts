// The failure a run's close recorded, read back in one place for every reader: the release page,
// the release run's state, the repair, and the run summary (`GET /api/pipeline-runs/:id`). The
// summary did not read it, so a release run that failed with its cause written read as failed with
// no code there (adminhub-api 46a3abe4, ISS-928).

/** What `runs-cascade.ts:failureMetadata` writes under `metadata.failure`, as a reader sees it. */
export interface RunFailure {
  code: string;
  detail: string;
  step: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The failure a run's close recorded, or null where none was. */
export function readRunFailure(metadata: unknown): RunFailure | null {
  const raw = (metadata as { failure?: unknown } | null)?.failure;
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const code = str(f.code);
  const detail = str(f.detail);
  if (!code || !detail) return null;
  return { code, detail, step: str(f.step) };
}
