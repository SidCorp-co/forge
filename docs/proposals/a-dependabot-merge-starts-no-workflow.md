# A Dependabot merge starts no workflow

Found by ISS-1308 while writing down what merges and what releases, and left standing here because
closing it needs a credential no agent on this project can write.

[`.github/workflows/dependabot-auto-merge.yml`](../../.github/workflows/dependabot-auto-merge.yml)
turns on auto-merge with `secrets.GITHUB_TOKEN`, and GitHub then merges the pull request as
`github-actions`. GitHub starts no workflow for a push made with that token, so the merge commit on
`main` runs none of the workflows that a push to `main` starts:

- `ci.yml` does not run, so the four jobs that run only after a merge (`core-integration`,
  `whole-tree`, `images`, `runner-platforms`) never see that commit until the nightly run.
- `runner-autorelease.yml` does not run, so a bump under `packages/runner/` cuts no `runner-v*` tag.
  The change waits on `main`, in no build, until the next runner change merged by a person. That is
  the state ISS-1165 was filed against.
- `sentry-release.yml` does not register the commit.

Measured 2026-10-19. Pull request #1096 bumped `sha2` under `packages/runner/` and was merged by
`app/github-actions` on 2026-10-18 as `b70f00098`. The only run on that commit is CodeQL's.
`runner-autorelease.yml`'s newest run is from 2026-10-16. `git log runner-v0.17.125..origin/main --
packages/runner` lists `b70f00098` alone.

## What would close it

Either of these. Both are the owner's to choose.

- **Merge with a token whose push starts workflows.** A GitHub App installation token, or a
  fine-grained token, stored as a repository secret and passed to `gh pr merge`. No agent here can
  write a repository secret.
- **Release the runner on a clock as well as on a push.** Add a `schedule` trigger to
  `runner-autorelease.yml` that cuts a tag when `main` holds runner commits past the newest
  `runner-v*` tag. Post-merge CI would still be missing for those commits.

## Honest costs

| Cost | What it takes |
|---|---|
| A credential to rotate | A token that can push to `main` and start workflows has more power than `GITHUB_TOKEN`, and somebody has to own it. |
| A tag on a commit no person merged | Once the runner releases on a Dependabot merge, a dependency bump reaches every auto-updating box with no person involved. The label for Cargo minors stays the only human gate. |
