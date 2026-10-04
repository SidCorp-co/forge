# A contract mock is served, and nothing on the runner starts one

**Removed when:** a forge-runner verb fetches a job's pinned contract version, checks its sha256 and
starts a pinned mock bound to the job's lifetime, which dev ISS-121 carries. The change that lands
it deletes this file.

ISS-60 (dev) gave core the half a mock needs: `GET /api/projects/:id/contracts/:contract/versions/:version/artifact`
hands back the stored bytes of one version (`ecosystem/contract/routes.ts`), as JSON for `openapi`,
`json-schema` and `mcp-tools` and as SDL text for `graphql`, with the version's approval state and
artifact sha256 in `X-Forge-Contract-Approval` and `X-Forge-Contract-Sha256`. A job on an issue whose
requirement's latest baseline pins a contract version is told that route in its prompt
(`workflows/pinned-contracts.ts:renderPinnedContracts`).

Nothing in `packages/runner` fetches it or starts a mock server, so a consumer run that wants one
starts it by hand (`npx @stoplight/prism-cli mock <file>`), unpinned. The design asks for the mock to
be generated in the job's worktree from the pinned version, with the tool pinned by version and
sha256 the way `ecosystem/contract/oasdiff.ts` pins oasdiff; that pinning and its download path are
not small, which is why this is a line here rather than part of ISS-60.

## What would close it

- A `forge-runner` verb that, given a job's pinned contract version, fetches the artifact route,
  verifies the sha256 against `X-Forge-Contract-Sha256`, and starts a pinned Prism (OpenAPI) or
  graphql-tools mock (SDL) bound to the job's lifetime.
- A refusal by name where the version's kind has no mock generator (`asyncapi`, `protobuf`, `opaque`),
  matching `CONTRACT_ARTIFACT_NOT_MOCKABLE` at the route.

## Honest costs

- **Leaving it means every consumer run picks its own mock.** An unpinned `npx` Prism may answer
  differently from the version the job is given, and nothing records which one ran.
- **Taking it puts two pinned tool downloads on every runner box.** Prism and graphql-tools each need
  a version, a sha256 and a refresh path that someone keeps current, as oasdiff does today.
- **A mock bound to the job's lifetime is one more process the run owns.** It has to be reaped with
  the worktree, or it outlives the run holding a port.
