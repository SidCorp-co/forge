import { parseSourceCommit } from "@forge/observability";

export const sourceCommit: string | null = parseSourceCommit(import.meta.env.VITE_SOURCE_COMMIT);
