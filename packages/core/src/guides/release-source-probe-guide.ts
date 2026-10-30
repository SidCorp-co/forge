import type { CoreGuide } from './types.js';

/**
 * The runtime probe a production environment declares so a release, and a requirement's coverage,
 * can read which commit production serves. Written from `release-batch/channel.ts:releaseProbesOf`,
 * `closeVerification`, `release-batch/verify.ts:verifyDeployed` and
 * `integrations/deploy/runtime-probe.ts:readRuntimeProbe`; adminhub-api, 2026-10-30, met only the
 * sentence that production "declares no source probe" and found no shape to declare one by.
 */
export const RELEASE_SOURCE_PROBE_GUIDE: CoreGuide = {
  slug: 'release-source-probe',
  audience: 'agent',
  title: 'Release source probe: how production says which commit it serves',
  summary:
    'The runtime probe a production environment declares in the project document, what the URL it names must answer, and what a release and requirement coverage do with the commit it reads. Where none is declared, coverage says production "declares no source probe".',
  version: 1,
  body: `## Release source probe: how production says which commit it serves

A release is proved against the commit production serves, and a requirement's coverage asks the
same question of the live build. Forge reads that commit from a **source probe**: a URL on the
production environment that answers the commit it was built from. Without one, coverage says the
live build could not be read because production "declares no source probe".

### Where it is declared
In the project document, on the production environment (the one whose \`tier\` is
\`production\`), never on a deploy binding:

\`\`\`json
"environments": {
  "production": {
    "tier": "production",
    "deployment": { "binding": "<binding id>", "trigger": "on-land" },
    "verification": {
      "runtime": [
        { "type": "http", "url": "https://app.example.com/version.json", "path": "commit", "identifies": "source" }
      ]
    }
  }
}
\`\`\`

- \`runtime\` holds 1 to 3 probes, each with all four fields. \`url\` is https. \`path\` is a dot path
  into the JSON body (\`commit\`, \`build.sha\`). \`identifies\` is \`source\` for a commit of the
  project's repository; \`artifact\` names an image or a build and never proves a release.
- Write it with \`GET /api/projects/:id/config\`, then \`PUT /api/projects/:id/config\` with
  \`{ baseRevision, document }\`: the document is written whole, at the revision you read.
- A \`verify\` key on a binding or a connection is refused: probes live on the environment only.
- How long a release waits and how many readings it wants are not declared: 300 seconds, and two
  matching readings in a row.

### What the URL must answer
- Exactly HTTP 200 to a plain \`GET\` with no credential, within 5 seconds. Redirects are followed,
  and a \`_forge_cb\` query parameter is added to get past caches.
- A JSON body holding, at \`path\`, a non-empty string of at most 200 characters: the commit the
  running build was made from. Send the whole 40-character sha. An abbreviation of at least 7 hex
  characters is compared as that sha's prefix, and any other string never matches a commit.
- With several probes, each must answer, and all must answer the same commit. A fleet half on the
  new build is read as up, with no commit yet.

### What a release does with it
- When a release opens, it reads the probes once and keeps what production served then.
- \`POST /api/projects/:projectId/release-batches/:runId/finish\` with \`commit\` (the whole sha
  pushed) reads the probes every 5 seconds. It passes once two readings in a row answer that
  commit. A finish naming no commit passes once production serves a commit other than the one kept
  at the open, and is refused where the open read none.
- Nothing closes until it passes. A probe not answering, a fleet that disagrees, a body with no
  commit, or another commit is refused \`RELEASE_NOT_VERIFIED\`, with the reading.
- Only \`artifact\` probes on production is refused \`RELEASE_PROBES_UNREADABLE\`: a declaration to
  correct.
- With no runtime probe, a storefront's provider report proves the release where the binding has
  one. Everywhere else, production's deployment record must name the commit \`finish\` passes, and
  coverage cannot read the live build.`,
};
