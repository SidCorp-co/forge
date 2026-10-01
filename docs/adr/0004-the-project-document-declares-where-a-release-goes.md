# 0004 — The project document declares where a release goes

**Status:** accepted · **Date:** 2026-10-01 · **Supersedes:** [0003](0003-a-release-chain-replaces-the-release-model-enum.md)

## Context

ADR 0003 put a project's release path on one column, `projects.release_chain`. Each deploy
binding declared the `stages` it served, `preview` or `live`. What an environment was and how it
was tested lived in a third place, the `projects.environments` JSON. Whether production deployed
without a person was a fourth, `agentConfig.pipelineConfig.autoProdDeploy`.

The project document (`project-v1`, ISS-11) declares each of these once. Work lands on
`source.git.defaultBranch`. Each environment has a `tier`, at most one of which is `production`.
An environment `deploysFrom` a branch, and its `deployment` names the binding that deploys it,
with a `trigger`. `promotions` say how a change crosses from one branch to the next. Runtime
probes are declared per environment. With the document in place, the four older homes are second
copies of facts the document already states.

## Decision

The release path is read from the project document and nowhere else
(`packages/core/src/project-config/release-path.ts`):

- **Where a release starts.** It starts from `source.git.defaultBranch`.
- **Where it goes.** It goes to the production environment. The branch production deploys from
  must be reachable from the default branch by `promotions`. A path that cannot reach it is refused
  as `RELEASE_TARGET_UNDECLARED`, naming the gap. So is a production environment that is external,
  unbound or bound to an inactive binding.
- **No production environment means Forge ships nothing.**
- **Which environment a deploy binding serves** is the environment whose `deployment.binding` names
  it. A binding has no `stages`, and a coolify connection has no `targets`.
- **The production gate** waives the human only where production's `trigger` is `on-land`.
- **The deploy lock** is keyed by environment name.
- **What an environment runs** is its environment state, read from the deployment record and from
  the probes it declares.
- **A release is proved** by production's probes that identify the source.

`release_chain`, `live_branch`, `release_model`, `release_strategy`, `autoProdDeploy`,
`projects.environments` and a binding's `stages` have no reader and no writer. Every door that
used to take one refuses it by name and points at `PUT /api/projects/:id/config`. ISS-16 dropped
the `projects` columns, `base_branch` among them: the default work branch 0003 kept as a column is
`source.git.defaultBranch`, the one place both facts are now read from. It also dropped
`webhook_secret`, now the project secret `secret://project/webhook-secret`, and `api_key`, which no
route read. `scripts/check-retired-model.mjs` (rules `release-path-keys` and
`legacy-project-columns`) names any of them that reappears in source.

There is no data migration (design D8). An operator re-enters by hand what the old columns held,
read from `scripts/export-legacy-project-config.mjs` run against the database before the release.

## Consequences

- **One production environment means one release channel.** `RELEASE_RUNNER_AMBIGUOUS` and
  `RELEASE_MULTI_CHANNEL_UNSUPPORTED` cannot arise, and they are gone.
- **A release's verification window is not declarable.** `project-v1` carries no
  `timeoutSeconds` or `stableReads`, so every release waits the defaults in
  `packages/core/src/release-batch/verify.ts:verifyDeployed`: 300 s, two stable reads.
- **Test credentials leave the project row.** A tester gets in through the testing profile an
  environment names. That profile holds `secret://` references. The one route that hands out the
  value behind one is `GET /api/jobs/self/testing-profiles/<profile>/secrets`
  (`packages/core/src/project-config/testing-secrets.ts:resolveTestingSecrets`): it answers only a
  running job's own credential, only for the profile named by the environment whose `deploysFrom`
  is the target its issue's merge mark recorded, audits each read and scrubs each value from that
  job's output.
- **forge-plugin reads the deleted fields.** It reads `releaseModel`, `liveBranch`,
  `releaseStrategy` and `environments` from `forge_projects.get` and `forge_config`, and `stages`
  from `forge_coolify_deploy list`. Those readers break until that repository moves to the
  document. This is a boundary, not an amnesty: this repository cannot edit it.
