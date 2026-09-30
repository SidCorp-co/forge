# A deployment made outside Forge is not seen by the release gate

Found by ISS-1346's review (consult 1881fe, F1) and left standing there on purpose.

Where a project declares no `verify.probes`, the automatic release weighs a verdict against what
Forge itself last deployed through the project's deploy bindings:
`packages/core/src/release-batch/deployed-reading.ts:readForgeDeployments` takes, per bound target,
the latest `deploy.succeeded` delivery Forge recorded for a deploy or rollback it dispatched, and the
commit the provider's own record of that deployment reports. That is the identity ISS-1346's Outcome
asks for — "a change Forge itself deployed through the project's deploy binding carries that
deployment's commit" — and it is blind to anything that deployed the same resource without Forge:
Coolify's own git webhook, a redeploy pressed in Coolify's UI, another tool holding the token.

The direction it can be wrong in is the releasing one. Forge deploys A; something else deploys B to
the same application; the reading still says A; a verdict judged at A stands and the issue ships
while B is what runs. Where B is the same branch a little later it carries A, which is the ordinary
case and why this was not built against; where B is a different branch or an older image, the
verdict was judged at code that is not running.

What would close it: a read of what the resource is running NOW, from the provider, compared with
the deployment Forge recorded — agreeing, the reading stands; disagreeing, the target is unread and
names the deployment Forge did not make. Coolify has no field on the application that says so
(`git_commit_sha` is the configured ref, `HEAD` on forge-dev's own), and the endpoint the rollback
control reads, `GET /api/v1/applications/{uuid}/rollback-images`, answered 404 on forge-dev's Coolify
on 2026-09-29, so the one current-image read this repository already calls is not there to lean on.
A deployment listing per application is the likely route, and nothing here has shown it exists on
the Coolify these projects run.

## Honest costs

The price of doing this, not of leaving it:

| Cost | What it takes |
|---|---|
| An endpoint proved before it is depended on | Whichever current-state read is chosen has to be shown answering on the Coolify these projects actually run, not on its documentation; the rollback control is the standing example of a path built against an endpoint that is not there. |
| A second provider call per target per sweep tick | The reading already asks one deployment record per target every tick a project has waiting rows; a confirmation doubles that, against a provider that also serves every deploy. |
| A target that stops answering where it answered | Where the confirmation cannot be read, the target has to read as unread rather than as its last Forge deployment — which holds rows today's reading releases, and is the right trade only once the endpoint is known to answer. |
| The same question for every provider that gains `deployedCommit` | The adapter capability says which commit a deployment built; a provider joining it would owe the current-state half too, or carry the same blind spot. |
