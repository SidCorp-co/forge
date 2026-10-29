import { RELEASE_TAG_CODES } from '@forge/contracts/releases';
import type { CoreGuide } from './types.js';

const codes = RELEASE_TAG_CODES.map((c) => `\`${c}\``).join(', ');

/** REQ-63 r7 BC-13..15: the tag a release puts on its commit before the deploy, and how a build reads it. */
export const RELEASE_TAGS_GUIDE: CoreGuide = {
  slug: 'release-tags',
  audience: 'agent',
  title: 'Release tags: how a build reads its release version',
  summary:
    'Forge tags the commit a release names v<version> on the project source host before anything is deployed from it: the promotion merge, or the cut commit. How a project deployed outside Forge reads that version at build time with no redeploy, and what the release says when it could not tag.',
  version: 2,
  body: `## Release tags: how a build reads its release version

Forge puts the lightweight tag \`v<version>\` (release \`0.5.0\` → \`v0.5.0\`) on the commit a
release names, on the project's source host, before anything is deployed from it. Forge holds the
credential: the tag goes through the project's GitHub or GitLab binding, the same one its merges
take, and nothing is asked of a caller. A project deployed outside Forge reads its own release
version from that tag at build time, with no redeploy; it never stamps a version file or sets a tag
by hand.

### Which commit, and when
- A promotion release: the promotion's merge commit, the moment Forge records it merged. Merged
  through Forge, that is the merge itself; already merged when the release is cut, the cut. Merged on
  the host, Forge writes nothing from the host's report: the master is owed the record and makes it
  with \`forge-runner api issues/<issueId>/merge-pull-request -X POST\`, which answers
  \`alreadyMerged\` and tags the merge. The operator deploys from that merge afterwards, so the build
  being deployed already carries its tag.
- Any other release: the commit its cut names, at the cut. A release run reports it with
  \`forge-runner release range\` right after pushing the release commit and before deploying it; a
  recorded release or landing names it in its record; a release that merges change requests names
  its last merge.
- Each release is tagged once: the first commit named is the one tagged, and a later one never
  re-aims it. A release that ends without shipping keeps its tag, and its next attempt takes a new
  version rather than wearing that one again.
- The host is asked just after the commit is known, by Forge's outbox, so a build that starts the
  instant the merge lands may run before the tag exists. A build that must carry the version runs on
  the tag: GitHub Actions \`on: push: tags: ['v*']\` reads \`$GITHUB_REF_NAME\`; GitLab CI
  \`rules: - if: $CI_COMMIT_TAG\` reads \`$CI_COMMIT_TAG\`. Any other build reads it from git at the
  commit it builds: \`git fetch --tags && git describe --tags --exact-match HEAD\`, which fails where
  the commit carries no tag yet, rather than answering an older one.

### Idempotent, and never moved
- Tagging again a release whose tag already stands on its commit writes nothing.
- A tag of that name already on another commit is refused \`RELEASE_TAG_CONFLICT\`, naming that
  commit, and Forge never moves it: delete or rename the tag on the host if it is wrong.

### What the release says
The release page shows the tag beside the release's status: Pending while the host is asked, then
the tag's name. Where there is none, it says why, by one of ${codes}, and the developer view gives
the sentence. A host that failed is asked again by itself, with backoff, for some hours; past that
its delivery is kept dead, and a platform admin replays it (\`GET /api/admin/outbox/dead\`,
\`POST /api/admin/outbox/deliveries/:did/replay\`).

### What the binding needs
- GitHub: the App's \`contents: write\`, which merging already asks.
- GitLab: a token whose role may create tags; a protected tag pattern covering \`v*\` needs the role
  that protection names.`,
};
