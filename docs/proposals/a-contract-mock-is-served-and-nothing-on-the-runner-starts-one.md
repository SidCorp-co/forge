# A contract mock is served, and nothing on the runner starts one

ISS-60 (dev) gave core the half a mock needs: `GET /api/projects/:id/contracts/:contract/versions/:version/artifact`
hands back the stored bytes of one version (`ecosystem/contract/routes.ts`), as JSON for `openapi`,
`json-schema` and `mcp-tools` and as SDL text for `graphql`, with the version's approval state and
artifact sha256 in `X-Forge-Contract-Approval` and `X-Forge-Contract-Sha256`. A job whose issue names
`contract:<project>/<contract>@<version>` is told that route in its prompt
(`ecosystem/contract/named-context.ts:renderNamedContracts`).

Nothing in `packages/runner` fetches it or starts a mock server, so a consumer run that wants one
starts it by hand (`npx @stoplight/prism-cli mock <file>`), unpinned. The design asks for the mock to
be generated in the job's worktree from the pinned version, with the tool pinned by version and
sha256 the way `ecosystem/contract/oasdiff.ts` pins oasdiff; that pinning and its download path are
not small, which is why this is a line here rather than part of ISS-60.

## What would close it

- A `forge-runner` verb that, given a job's named contract version, fetches the artifact route,
  verifies the sha256 against `X-Forge-Contract-Sha256`, and starts a pinned Prism (OpenAPI) or
  graphql-tools mock (SDL) bound to the job's lifetime.
- A refusal by name where the version's kind has no mock generator (`asyncapi`, `protobuf`, `opaque`),
  matching `CONTRACT_ARTIFACT_NOT_MOCKABLE` at the route.
