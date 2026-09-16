import { parseSourceCommit } from "@forge/observability";

/** The commit this bundle was built from, or `null` when the build was not told. */
export const sourceCommit: string | null = parseSourceCommit(process.env.NEXT_PUBLIC_SOURCE_COMMIT);
