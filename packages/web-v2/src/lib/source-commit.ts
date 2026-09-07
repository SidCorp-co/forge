// cm:guard the ONLY reader of the injected commit in this package, and the member expression `process.env.NEXT_PUBLIC_SOURCE_COMMIT` must stay written out literally: Next substitutes that text at build time, so a computed lookup or a re-export resolves to nothing in the browser bundle.
// cm:edge lockstep -> packages/web-v2/Dockerfile — `ARG SOURCE_COMMIT` becomes `ENV NEXT_PUBLIC_SOURCE_COMMIT` above `RUN pnpm build`, and below that line it reaches no client.
// cm:edge contract -> packages/core/src/observability/source-commit.ts — the same parse over the same deploy argument, so `/version` and this bundle cannot name different commits.

// cm:why anything that is not a commit hash is treated as nothing: the Coolify application records `git_commit_sha=HEAD`, so `HEAD` and an unexpanded `${SOURCE_COMMIT}` are values a build can really receive, and a Sentry release named after either attributes errors to a deploy nobody can identify.
const SHA = /^[0-9a-f]{7,40}$/i;

const raw = process.env.NEXT_PUBLIC_SOURCE_COMMIT?.trim();

/** The commit this bundle was built from, or `null` when the build was not told. */
export const sourceCommit: string | null = raw && SHA.test(raw) ? raw : null;
