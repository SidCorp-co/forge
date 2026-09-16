# A release run verifies one endpoint, and closes the roster for all of them

**Status:** proposal. **Raised by:** ISS-1046, which made the shape reachable.
**Blocked on:** nothing technical — this is work, not a decision.

## What is true today

`resolveReleaseChannels` returns the whole live deploy SET. That is the right answer to "where
does this project release to", and ISS-1046 widened it deliberately: a project whose only live
binding was an error tracker used to present as a project with nothing to release.

The attempt ledger was not widened with it, and still holds exactly one reading per run:

- `createReleaseBatch` writes one `commitBefore`, read from one channel's probes.
- `POST .../attempts/:key/account` takes core's own reading from one channel's `verify`.
- `finishReleaseBatch` closes the WHOLE roster on that single verdict.
- `loadReleaseReadiness` reports the first channel's `rollback` mode and text, so settings shows
  one binding's declaration for the set.

So a release to two endpoints would be proved at one of them and claimed for both.

## What stands in the way of that happening

`createReleaseBatch` now throws `ReleaseMultiChannelUnsupportedError` — `409
RELEASE_MULTI_CHANNEL_UNSUPPORTED` — when a project declares more than one live deploy binding.
Measured over the fleet at the 0253 cutover: of the 12 projects carrying a live deploy binding,
**zero** carry two. The refusal therefore takes nothing away from anybody today; it stands between
the first operator who adds a second live binding and a silently half-verified release.

It is a refusal and not a fix. The operator who meets it is told to leave one binding active or to
split the project, and neither is what they asked for.

## What the fix is

Make the reading per binding rather than per run:

1. Key the baseline by binding id: `commitBefore` becomes a map, written at creation from each
   channel's own probes.
2. Carry that identity through `release-batch/state.ts` and the account route, so an attempt says
   which endpoint it is an account of.
3. `finishReleaseBatch` closes the roster only when EVERY channel's reading passes, and names the
   channel that did not.
4. `ReleaseReadiness` returns per-binding entries, with the aggregate gaps derived from them, so
   settings can name the binding whose rollback declaration needs correcting rather than showing
   the first one's for the set.
5. Remove `ReleaseMultiChannelUnsupportedError` and this file in the same change.

Until (5) lands, the refusal is the honest answer.

## Honest costs

| Cost | What it takes |
|---|---|
| A wider `commitBefore` | `pipeline_runs.metadata.commitBefore` becomes a map keyed by binding id. Every reader of that key — the prompt, `readReleaseRunState`, the attempt ledger — changes with it, and runs opened before the change carry the old scalar, so both shapes have to be read for as long as any such run can still be finished. |
| An attempt says which endpoint it is about | `POST .../attempts` gains a required binding id once a project has more than one channel. That is a new required field on a route agents already call, so the release skill in `forge-plugin` has a second half — a repo this one cannot gate. |
| `finish` gets stricter | It closes only when EVERY channel reads back the expected commit. A project whose second endpoint is slow to come up now fails a release that would previously have closed, and the operator has to re-run it rather than being told nothing. |
| `ReleaseReadiness` changes shape | Settings moves from one rollback declaration to a list of per-binding entries. The web contract mirror in `packages/web-v2/src/features/project-settings/types.ts` changes with it, and the release section has to render a list where it renders a single value. |
| The refusal has to go in the same change | `ReleaseMultiChannelUnsupportedError` and this file are deleted by whoever lands the above. Leaving the refusal in place beside a working multi-channel path is two live answers to one question. |
