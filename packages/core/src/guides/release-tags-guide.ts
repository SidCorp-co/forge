import { RELEASE_TAG_CODES } from '@forge/contracts/releases';
import type { CoreGuide } from './types.js';

const codes = RELEASE_TAG_CODES.map((c) => `\`${c}\``).join(', ');

/** REQ-63 BC-13..15: the tag a shipped release puts on its commit, and how a build reads it. */
export const RELEASE_TAGS_GUIDE: CoreGuide = {
  slug: 'release-tags',
  audience: 'agent',
  title: 'Release tags: how a build reads its release version',
  summary:
    'When a release ships, Forge tags the commit it shipped v<version> on the project source host through its binding; how a project deployed outside Forge reads that version at build time, and what the release says when it could not tag.',
  version: 1,
  body: `## Release tags: how a build reads its release version

When a release ships, Forge puts the lightweight tag \`v<version>\` (release \`0.5.0\` → \`v0.5.0\`)
on the commit the release shipped, on the project's source host. Forge holds the credential: the
tag goes through the project's GitHub or GitLab binding, the same one its merges take, and nothing
is asked of a caller. A project deployed outside Forge reads its own release version from that tag;
it never stamps a version file or sets a tag by hand.

### Which commit, and when
- The commit is the one the release recorded it shipped: what a verified deploy served, the commit a
  recorded landing or deploy names, or the last merge of a release that merges change requests.
- The tag is written once the release is shipped, never at the cut, and just after it: the ship
  tells Forge's outbox, which asks the host. A build that must carry the
  version runs on the tag: GitHub Actions \`on: push: tags: ['v*']\` reads \`$GITHUB_REF_NAME\`;
  GitLab CI \`rules: - if: $CI_COMMIT_TAG\` reads \`$CI_COMMIT_TAG\`. Any other build reads it from git
  at the commit it builds: \`git fetch --tags && git describe --tags --exact-match HEAD\`, which
  fails where the commit carries no tag yet, rather than answering an older one.

### Idempotent, and never moved
- Tagging again a release whose tag already stands on its commit writes nothing.
- A tag of that name already on another commit is refused \`RELEASE_TAG_CONFLICT\`, naming that
  commit, and Forge never moves it: delete or rename the tag on the host if it is wrong.

### What the release says
The release page shows the tag beside the release's status. Where there is none, it says why, by
one of ${codes}, and the developer view gives the sentence. A host that failed is asked again by
itself, with backoff, for some hours; past that its delivery is kept dead, and a platform admin
replays it (\`GET /api/admin/outbox/dead\`, \`POST /api/admin/outbox/deliveries/:did/replay\`).

### What the binding needs
- GitHub: the App's \`contents: write\`, which merging already asks.
- GitLab: a token whose role may create tags; a protected tag pattern covering \`v*\` needs the role
  that protection names.`,
};
