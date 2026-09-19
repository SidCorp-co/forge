import { parseSourceCommit } from '@forge/observability';

export const sourceCommit: string | null = parseSourceCommit(process.env.SOURCE_COMMIT);
