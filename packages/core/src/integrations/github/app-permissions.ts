/**
 * What a Forge GitHub App has to be granted: the strongest level anything Forge does needs, per
 * permission. The App manifest (`connect.ts:buildAppManifest`) requests exactly this, and an
 * installation is read against it, so the requested and the required side are one list (ISS-1153:
 * they were two, and an owner met the gap as a 403 mid-merge). `administration: read` is for branch
 * protection reads; `contents: write` also covers the HTTPS push a runner makes with a minted token.
 */
const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const;
type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const APP_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = {
  metadata: 'read',
  actions: 'read',
  contents: 'write',
  administration: 'read',
  checks: 'read',
  issues: 'write',
  pull_requests: 'write',
};

/** The webhook events the App subscribes to; each needs a permission listed above. */
export const APP_EVENTS = ['pull_request', 'pull_request_review', 'check_run', 'push'] as const;

/** Whether a grant at `held` covers a call that needs `needed`. */
function levelSatisfies(held: string | undefined, needed: PermissionLevel): boolean {
  const at = PERMISSION_LEVELS.indexOf(held as PermissionLevel);
  return at >= 0 && at >= PERMISSION_LEVELS.indexOf(needed);
}

/** Which of the required permissions a grant does not cover, and what it holds instead. */
export interface PermissionShortfall {
  permission: string;
  required: PermissionLevel;
  /** The level the grant holds, or null where it holds the permission not at all. */
  held: string | null;
}

/**
 * What an installation is short of, read against `APP_PERMISSIONS`.
 *
 * The grant is GitHub's own answer for the installation, so an unknown level is a shortfall rather
 * than a pass: a level this code does not recognise cannot be shown to cover anything.
 */
export function installationShortfall(
  granted: Readonly<Record<string, string>>,
): PermissionShortfall[] {
  const out: PermissionShortfall[] = [];
  for (const [permission, required] of Object.entries(APP_PERMISSIONS)) {
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
