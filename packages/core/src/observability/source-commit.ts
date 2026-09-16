import { parseSourceCommit } from '@forge/observability';

/** The commit this build was made from, or `null` when the build was not told. */
export const sourceCommit: string | null = parseSourceCommit(process.env.SOURCE_COMMIT);
