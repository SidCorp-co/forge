// The active-organisation scope: which projects a screen shows once the caller has switched org.

/** What the scope reads of a project: its org, and the caller's role there (null where they are no member). */
export interface OrgScoped {
	orgId: string;
	orgRole: string | null;
}

/**
 * Whether a project shows under the active org. One whose org the caller is not a member of,
 * reached through a project invite alone, shows under every org, since no switch reaches it.
 * Core scopes /me/attention with it and the project lists call the same predicate.
 */
export function inActiveOrg(p: OrgScoped, activeOrgId: string | null): boolean {
	return !activeOrgId || p.orgId === activeOrgId || p.orgRole === null;
}
