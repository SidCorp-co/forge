/**
 * What a Forge GitHub App has to be granted, derived from what Forge's own code calls.
 *
 * ISS-1153: the manifest and the call sites were two lists with nothing between them. The manifest
 * asked for six permissions; `readProtection` called `GET /repos/{owner}/{repo}/branches/{branch}/
 * protection`, which needs `administration: read`, and every health signal Forge had said the
 * integration was fine because none of them exercised a permission. An owner met it as a 403 in the
 * middle of a merge.
 *
 * The three tables below are the required side of that comparison: every endpoint Forge sends, every
 * event it subscribes to, and every permission it needs for something that is not a REST call. The
 * requested side stays where it was, in `connect.ts`. `app-permissions.test.ts` compares them, and
 * compares this table against the paths it resolves out of the source — a call site whose path is in
 * no table, and a table row whose path is at no call site, both go red.
 *
 * `docs` is a field rather than a comment because it is the one claim here this repository cannot
 * check: the permission a GitHub endpoint needs is GitHub's to state, and a reader auditing a row
 * has to be able to open the page that states it.
 */

// cm:edge lockstep -> packages/core/src/integrations/github/connect.ts — `buildAppManifest` requests
// what these tables require. Nothing type-checks the pair; `app-permissions.test.ts` compares them,
// so a permission added here without being added there goes red naming it, and the reverse too.

/** As GitHub spells an App permission level, weakest first. */
export const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** How a call proves who it is. Only `installation` spends a repository permission. */
export type GitHubCallAuth = 'installation' | 'app-jwt' | 'none';

export interface GitHubEndpoint {
  /** The path as the resolver spells it: every interpolated segment is `:p`, no query string. */
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  auth: GitHubCallAuth;
  /** Null exactly when `auth` is not `installation` — an App JWT spends no permission. */
  permission: string | null;
  level: PermissionLevel | null;
  /** Where Forge makes this call, as `file.ts:symbol`. */
  callSites: readonly string[];
  /** The GitHub page that states the permission. */
  docs: string;
}

const REST = 'https://docs.github.com/en/rest';

/**
 * Every GitHub REST call Forge makes as the App, and what each one costs.
 *
 * Keyed by method AND path: `GET /repos/:p/:p/check-runs/:p` reads a check run with `checks: read`
 * and `PATCH` on the same path writes one, and a table keyed by path alone would let a write be
 * added under a read row without anything noticing.
 */
export const GITHUB_ENDPOINTS: readonly GitHubEndpoint[] = [
  {
    path: '/app-manifests/:p/conversions',
    method: 'POST',
    auth: 'none',
    permission: null,
    level: null,
    callSites: ['connect.ts:convertManifestCode'],
    docs: `${REST}/apps/apps#create-a-github-app-from-a-manifest`,
  },
  {
    path: '/app',
    method: 'GET',
    auth: 'app-jwt',
    permission: null,
    level: null,
    callSites: ['installation-permissions.ts:readAppIdentity'],
    docs: `${REST}/apps/apps#get-the-authenticated-app`,
  },
  {
    path: '/app/hook/config',
    method: 'GET',
    auth: 'app-jwt',
    permission: null,
    level: null,
    callSites: ['hook-config.ts:readAppHookConfig'],
    docs: `${REST}/apps/webhooks#get-a-webhook-configuration-for-an-app`,
  },
  {
    path: '/app/installations',
    method: 'GET',
    auth: 'app-jwt',
    permission: null,
    level: null,
    callSites: ['repositories.ts:listInstallationRepositories'],
    docs: `${REST}/apps/apps#list-installations-for-the-authenticated-app`,
  },
  {
    path: '/app/installations/:p',
    method: 'GET',
    auth: 'app-jwt',
    permission: null,
    level: null,
    callSites: [
      'install-resolve.ts:findBindingOwningInstallation',
      'installation-permissions.ts:readInstallationGrants',
    ],
    docs: `${REST}/apps/apps#get-an-installation-for-the-authenticated-app`,
  },
  {
    path: '/app/installations/:p/access_tokens',
    method: 'POST',
    auth: 'app-jwt',
    permission: null,
    level: null,
    callSites: ['app-auth.ts:installationTokenWithExpiry'],
    docs: `${REST}/apps/apps#create-an-installation-access-token-for-an-app`,
  },
  {
    path: '/installation/repositories',
    method: 'GET',
    auth: 'installation',
    permission: 'metadata',
    level: 'read',
    callSites: ['repositories.ts:listInstallationRepositories'],
    docs: `${REST}/apps/installations#list-repositories-accessible-to-the-app-installation`,
  },
  {
    path: '/repos/:p/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'metadata',
    level: 'read',
    callSites: [
      'adapter.ts:healthcheck',
      'runner-release-repo.ts:readRepositoryHead',
      'runner-release-repo.ts:readDefaultBranch',
    ],
    docs: `${REST}/repos/repos#get-a-repository`,
  },
  {
    path: '/repos/:p/:p/actions/jobs/:p/logs',
    method: 'GET',
    auth: 'installation',
    permission: 'actions',
    level: 'read',
    callSites: ['agent-ops.ts:readCheckRunLog'],
    docs: `${REST}/actions/workflow-jobs#download-job-logs-for-a-workflow-run`,
  },
  {
    path: '/repos/:p/:p/branches/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['live-divergence.ts:headOf'],
    docs: `${REST}/branches/branches#get-a-branch`,
  },
  {
    path: '/repos/:p/:p/branches/:p/protection',
    method: 'GET',
    auth: 'installation',
    permission: 'administration',
    level: 'read',
    callSites: ['merge-read.ts:readProtection'],
    docs: `${REST}/branches/branch-protection#get-branch-protection`,
  },
  {
    path: '/repos/:p/:p/check-runs',
    method: 'POST',
    auth: 'installation',
    permission: 'checks',
    level: 'write',
    callSites: ['check-run.ts:publishCheckRun'],
    docs: `${REST}/checks/runs#create-a-check-run`,
  },
  {
    path: '/repos/:p/:p/check-runs/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'checks',
    level: 'read',
    callSites: ['agent-ops.ts:readCheckRunLog'],
    docs: `${REST}/checks/runs#get-a-check-run`,
  },
  {
    path: '/repos/:p/:p/check-runs/:p',
    method: 'PATCH',
    auth: 'installation',
    permission: 'checks',
    level: 'write',
    callSites: ['check-run.ts:publishCheckRun'],
    docs: `${REST}/checks/runs#update-a-check-run`,
  },
  {
    path: '/repos/:p/:p/commits/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['runner-release-repo.ts:readCommitSha'],
    docs: `${REST}/commits/commits#get-a-commit`,
  },
  {
    path: '/repos/:p/:p/commits/:p/check-runs',
    method: 'GET',
    auth: 'installation',
    permission: 'checks',
    level: 'read',
    callSites: ['check-run.ts:existingRunId', 'merge-read.ts:readHeadChecks'],
    docs: `${REST}/checks/runs#list-check-runs-for-a-git-reference`,
  },
  {
    path: '/repos/:p/:p/compare/:p...:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: [
      'projection-refresh.ts:refreshPullRequestRow',
      'live-divergence.ts:readLiveDivergence',
    ],
    docs: `${REST}/commits/commits#compare-two-commits`,
  },
  {
    path: '/repos/:p/:p/contents/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['runner-release-repo.ts:readFileAtRef'],
    docs: `${REST}/repos/contents#get-repository-content`,
  },
  {
    path: '/repos/:p/:p/git/ref/tags/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['runner-release-repo.ts:readTagRef'],
    docs: `${REST}/git/refs#get-a-reference`,
  },
  {
    path: '/repos/:p/:p/git/refs',
    method: 'POST',
    auth: 'installation',
    permission: 'contents',
    level: 'write',
    callSites: ['runner-release-repo.ts:createTagRef'],
    docs: `${REST}/git/refs#create-a-reference`,
  },
  {
    path: '/repos/:p/:p/git/tags',
    method: 'POST',
    auth: 'installation',
    permission: 'contents',
    level: 'write',
    callSites: ['runner-release-repo.ts:createTagRef'],
    docs: `${REST}/git/tags#create-a-tag-object`,
  },
  {
    path: '/repos/:p/:p/git/tags/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['runner-release-repo.ts:readTagRef'],
    docs: `${REST}/git/tags#get-a-tag`,
  },
  {
    path: '/repos/:p/:p/issues/:p/comments',
    method: 'POST',
    auth: 'installation',
    permission: 'issues',
    level: 'write',
    callSites: ['agent-ops.ts:writePullRequestComment'],
    docs: `${REST}/issues/comments#create-an-issue-comment`,
  },
  {
    path: '/repos/:p/:p/pulls',
    method: 'POST',
    auth: 'installation',
    permission: 'pull_requests',
    level: 'write',
    callSites: ['agent-ops.ts:openPullRequest'],
    docs: `${REST}/pulls/pulls#create-a-pull-request`,
  },
  {
    path: '/repos/:p/:p/pulls/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'pull_requests',
    level: 'read',
    callSites: [
      'agent-ops.ts:readPullRequestDiff',
      'agent-ops.ts:submitReview',
      'merge-read.ts:readPullRequest',
      'projection-refresh.ts:refreshPullRequestRow',
    ],
    docs: `${REST}/pulls/pulls#get-a-pull-request`,
  },
  {
    path: '/repos/:p/:p/pulls/:p/merge',
    method: 'PUT',
    auth: 'installation',
    permission: 'contents',
    level: 'write',
    callSites: ['merge.ts:mergePullRequest'],
    docs: `${REST}/pulls/pulls#merge-a-pull-request`,
  },
  {
    path: '/repos/:p/:p/pulls/:p/requested_reviewers',
    method: 'POST',
    auth: 'installation',
    permission: 'pull_requests',
    level: 'write',
    callSites: ['agent-ops.ts:requestReview'],
    docs: `${REST}/pulls/review-requests#request-reviewers-for-a-pull-request`,
  },
  {
    path: '/repos/:p/:p/pulls/:p/reviews',
    method: 'POST',
    auth: 'installation',
    permission: 'pull_requests',
    level: 'write',
    callSites: ['agent-ops.ts:submitReview'],
    docs: `${REST}/pulls/reviews#create-a-review-for-a-pull-request`,
  },
  {
    path: '/repos/:p/:p/releases/tags/:p',
    method: 'GET',
    auth: 'installation',
    permission: 'contents',
    level: 'read',
    callSites: ['runner-release-repo.ts:readReleaseForTag'],
    docs: `${REST}/releases/releases#get-a-release-by-tag-name`,
  },
] as const;

export interface GitHubEventSubscription {
  event: string;
  /** The permission GitHub requires before it will deliver this event to an App. */
  permission: string;
  level: PermissionLevel;
  /** What acts on the delivery, as `file.ts:symbol`. */
  handler: string;
  docs: string;
}

const EVENT_DOCS = 'https://docs.github.com/en/webhooks/webhook-events-and-payloads';

/** Every webhook event the App subscribes to, and what GitHub charges for the subscription. */
export const GITHUB_EVENT_SUBSCRIPTIONS: readonly GitHubEventSubscription[] = [
  {
    event: 'issues',
    permission: 'issues',
    level: 'read',
    handler: 'webhooks/github-adapter.ts:handleGitHubEvent',
    docs: `${EVENT_DOCS}#issues`,
  },
  {
    event: 'pull_request',
    permission: 'pull_requests',
    level: 'read',
    handler: 'projection-events.ts:applyProjectedEvent',
    docs: `${EVENT_DOCS}#pull_request`,
  },
  {
    event: 'pull_request_review',
    permission: 'pull_requests',
    level: 'read',
    handler: 'projection-events.ts:applyProjectedEvent',
    docs: `${EVENT_DOCS}#pull_request_review`,
  },
  {
    event: 'check_run',
    permission: 'checks',
    level: 'read',
    handler: 'projection-events.ts:applyProjectedEvent',
    docs: `${EVENT_DOCS}#check_run`,
  },
  {
    event: 'push',
    permission: 'contents',
    level: 'read',
    handler: 'projection-events.ts:applyProjectedEvent',
    docs: `${EVENT_DOCS}#push`,
  },
  {
    event: 'workflow_run',
    permission: 'actions',
    level: 'read',
    handler: 'projection-events.ts:applyProjectedEvent',
    docs: `${EVENT_DOCS}#workflow_run`,
  },
] as const;

export interface GitHubNonRestUse {
  permission: string;
  level: PermissionLevel;
  /** What needs it, as `file.ts:symbol`. */
  owner: string;
  reason: string;
}

/**
 * Permissions Forge needs for something that is not a REST call, so the surplus check has a place
 * to read them from rather than an exemption nobody wrote down.
 */
export const GITHUB_NON_REST_USES: readonly GitHubNonRestUse[] = [
  {
    permission: 'contents',
    level: 'write',
    owner: 'git/github-app-credential.ts:mintGitCredential',
    reason:
      'a runner pushes over HTTPS with an installation token this helper mints, and a push is a ' +
      'write to the repository contents rather than a call to any endpoint above',
  },
] as const;

function rank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

/** Whether a grant at `held` covers a call that needs `needed`. */
export function levelSatisfies(held: string | undefined, needed: PermissionLevel): boolean {
  const at = PERMISSION_LEVELS.indexOf(held as PermissionLevel);
  return at >= 0 && at >= rank(needed);
}

/** What the three tables add up to: one level per permission, the strongest anything needs. */
export function requiredAppPermissions(): Map<string, PermissionLevel> {
  const out = new Map<string, PermissionLevel>();
  const take = (permission: string, level: PermissionLevel) => {
    const held = out.get(permission);
    if (!held || rank(level) > rank(held)) out.set(permission, level);
  };
  for (const e of GITHUB_ENDPOINTS) {
    if (e.auth === 'installation' && e.permission && e.level) take(e.permission, e.level);
  }
  for (const e of GITHUB_EVENT_SUBSCRIPTIONS) take(e.permission, e.level);
  for (const u of GITHUB_NON_REST_USES) take(u.permission, u.level);
  return out;
}

/** Which of the required permissions a grant does not cover, and what it holds instead. */
export interface PermissionShortfall {
  permission: string;
  required: PermissionLevel;
  /** The level the grant holds, or null where it holds the permission not at all. */
  held: string | null;
}

/**
 * What an installation is short of, read against `requiredAppPermissions`.
 *
 * The grant is GitHub's own answer for the installation, so an unknown level is a shortfall rather
 * than a pass: a level this code does not recognise cannot be shown to cover anything.
 */
export function installationShortfall(
  granted: Readonly<Record<string, string>>,
): PermissionShortfall[] {
  const out: PermissionShortfall[] = [];
  for (const [permission, required] of requiredAppPermissions()) {
    const held = granted[permission];
    if (levelSatisfies(held, required)) continue;
    out.push({ permission, required, held: held ?? null });
  }
  return out;
}

/** The App's own permissions page, which is where a permission is added. */
export function appPermissionsPageUrl(app: {
  slug: string;
  ownerLogin: string;
  ownerType: string;
}): string {
  const base =
    app.ownerType.toLowerCase() === 'organization'
      ? `https://github.com/organizations/${encodeURIComponent(app.ownerLogin)}/settings`
      : 'https://github.com/settings';
  return `${base}/apps/${encodeURIComponent(app.slug)}/permissions`;
}

function spell(shortfall: PermissionShortfall): string {
  return shortfall.held === null
    ? `\`${shortfall.permission}: ${shortfall.required}\`, which it does not hold at all`
    : `\`${shortfall.permission}: ${shortfall.required}\`, which it holds only at \`${shortfall.held}\``;
}

/**
 * The sentence an operator is given for an installation that cannot do what Forge will ask of it.
 *
 * Three things, because leaving any one of them out cost ISS-1153's owner a round: WHICH permission,
 * WHERE it is added — the App's own page, not the installation's — and that adding it there does
 * nothing until the installation accepts the new grant. A change on the App is not a grant.
 */
export function describeShortfall(args: {
  repository: string;
  shortfall: readonly PermissionShortfall[];
  permissionsUrl: string | null;
  installationUrl: string | null;
}): string {
  const missing = args.shortfall.map(spell).join('; ');
  const where = args.permissionsUrl
    ? `Add ${args.shortfall.length === 1 ? 'it' : 'them'} on the App's own permissions page, ${args.permissionsUrl}`
    : "Add them under the App's Settings, Permissions & events — this is the App's own page, not the installation's";
  const accept = args.installationUrl
    ? `then accept the new grant on the installation at ${args.installationUrl}`
    : 'then accept the new grant on the installation';
  return (
    `The App is installed on ${args.repository} and is not granted everything Forge will ask of ` +
    `it: it needs ${missing}. ${where}, and ${accept} — until that second step is taken the ` +
    'change on the App does nothing, and Forge will meet the gap as a 403 in the middle of ' +
    'whichever operation needs it first.'
  );
}
