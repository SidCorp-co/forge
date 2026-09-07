// cm:guard the ONLY reader of `SOURCE_COMMIT` in this package. `/version` and the Sentry `release` both descend from this constant, because two independent reads of "which commit is this" can disagree and the disagreement is silent.
// cm:edge contract -> docker-compose.prod.yml — `core.build.args.SOURCE_COMMIT` is where the value enters; renaming the argument there without renaming it here serves `null` on every deploy and nothing fails.
// cm:edge lockstep -> packages/core/Dockerfile — the runtime stage's `ARG SOURCE_COMMIT` + `ENV SOURCE_COMMIT` is what freezes the value into the image; drop either line and this reads `undefined` in the container while every test on a dev box still passes.

// cm:why a shape test rather than a passthrough: the Coolify application records `git_commit_sha=HEAD`, so `HEAD` and an unexpanded `${SOURCE_COMMIT}` are both values a build can plausibly receive. Serving one as an identity would make `release-gate` condition 4 pass on a deploy nobody can identify, which is worse than the gap it replaces — so anything that is not a commit hash is the same answer as nothing at all.
const SHA = /^[0-9a-f]{7,40}$/i;

const raw = process.env.SOURCE_COMMIT?.trim();

/** The commit this build was made from, or `null` when the build was not told. */
export const sourceCommit: string | null = raw && SHA.test(raw) ? raw : null;
