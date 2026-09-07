// cm:guard the ONLY reader of `SOURCE_COMMIT` in this package. `/version` and the Sentry `release` both descend from this constant, because two independent reads of "which commit is this" can disagree and the disagreement is silent.
// cm:edge contract -> docker-compose.prod.yml — `core.build.args.SOURCE_COMMIT` is where the value enters; renaming the argument there without renaming it here serves `null` on every deploy and nothing fails.
// cm:edge lockstep -> packages/core/Dockerfile — the runtime stage's `ARG SOURCE_COMMIT` + `ENV SOURCE_COMMIT` is what freezes the value into the image; drop either line and this reads `undefined` in the container while every test on a dev box still passes.
import { parseSourceCommit } from '@forge/observability';

/** The commit this build was made from, or `null` when the build was not told. */
export const sourceCommit: string | null = parseSourceCommit(process.env.SOURCE_COMMIT);
