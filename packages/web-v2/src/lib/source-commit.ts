import { parseSourceCommit } from "@forge/observability";

export const sourceCommit: string | null = parseSourceCommit(process.env.NEXT_PUBLIC_SOURCE_COMMIT);
