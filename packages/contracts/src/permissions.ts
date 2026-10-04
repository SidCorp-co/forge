// One permission vocabulary (pattern v2 BC-20, ADR 0007): every check in core asks
// `can(actor, permission, resource)` for a `<resource>.<verb>` named here, and nothing else decides
// who may act. A role is a permission set declared below as data; a membership may carry a grant of
// further permissions on its project; a token narrows what its holder reaches.

/** Every resource an approve-type act decides, each with its own `<resource>.approve`. */
export const APPROVAL_RESOURCES = [
	"requirements",
	"mockups",
	"suggestions",
	"workflow-designs",
	"contracts",
	"feedback",
	"releases",
	"plans",
] as const;
export type ApprovalResource = (typeof APPROVAL_RESOURCES)[number];
export type ApprovalPermission = `${ApprovalResource}.approve`;

export const approvalPermission = (resource: ApprovalResource): ApprovalPermission =>
	`${resource}.approve`;

const APPROVE = APPROVAL_RESOURCES.map(approvalPermission);

/** Read every row of a project. */
const READ = ["project.read"] as const;

/**
 * Write a project's rows. The resource-named writes are acts that once read the actor's agency; they
 * are plain writes now, held by whoever holds the role.
 */
const WRITE = [
	"project.write",
	"workflow-designs.write",
	"questionnaires.write",
	"onboarding.write",
	"ecosystem-links.write",
	"contracts.write",
	"suggestions.write",
] as const;

/**
 * Acts that once refused an agent. They are permissions a member holds, and a token holds only
 * where its grant names them (`TOKEN_EXPLICIT_PERMISSIONS`).
 */
const PERSONAL = [
	"questionnaires.answer",
	"onboarding.request",
	"charter.write",
	"commitments.write",
] as const;

/**
 * Configure the project, manage its members, admit an issue straight to `open` (`issues.admit`), and
 * the admin acts that once refused an agent.
 */
const ADMIN = [
	"project.admin",
	"members.admin",
	"issues.admit",
	"feedback.redact",
	"comments.moderate",
] as const;

/**
 * Dispatch, cancel or roll back a deploy. Admin's by default; a member or an agent's membership holds
 * it only where the project's grant names it.
 */
const DEPLOY = ["deploys.run"] as const;

/**
 * Send a dead outbox delivery of the project back to its consumer. Admin's by default; a member or an
 * agent's membership holds it only where the project's grant names it.
 */
const OPERATE = ["outbox.replay"] as const;

export const PROJECT_PERMISSIONS = [
	...READ,
	...WRITE,
	...PERSONAL,
	...APPROVE,
	...DEPLOY,
	...OPERATE,
	...ADMIN,
] as const;
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

/** An organization's own acts; an org owner or admin also holds project `admin` on every project of the org. */
export const ORG_PERMISSIONS = ["org.read", "org.admin", "org.own"] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const PERMISSIONS = [...PROJECT_PERMISSIONS, ...ORG_PERMISSIONS] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
	(PERMISSIONS as readonly string[]).includes(value);

export const isProjectPermission = (value: string): value is ProjectPermission =>
	(PROJECT_PERMISSIONS as readonly string[]).includes(value);

/** The project roles, weakest first. */
export const PROJECT_ROLES = ["viewer", "member", "admin"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * What each project role holds. Approval is admin's by default; to let members approve, add
 * `...APPROVE` to the member line.
 */
export const ROLE_PERMISSIONS: Readonly<Record<ProjectRole, readonly ProjectPermission[]>> = {
	viewer: [...READ],
	member: [...READ, ...WRITE, ...PERSONAL],
	admin: [...READ, ...WRITE, ...PERSONAL, ...APPROVE, ...DEPLOY, ...OPERATE, ...ADMIN],
};

export const ORG_ROLES = ["member", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_ROLE_PERMISSIONS: Readonly<Record<OrgRole, readonly OrgPermission[]>> = {
	member: ["org.read"],
	admin: ["org.read", "org.admin"],
	owner: ["org.read", "org.admin", "org.own"],
};

/**
 * Permissions a token holds only where its grant names them: neither a full grant (`*`) nor a token
 * minted before grants existed reaches them. A session holds them by its role. Every approve
 * permission is one (ADR 0007): a token approves only where its grant names the approval.
 */
export const TOKEN_EXPLICIT_PERMISSIONS: readonly Permission[] = [
	"questionnaires.answer",
	"onboarding.request",
	"charter.write",
	"commitments.write",
	"feedback.redact",
	"comments.moderate",
	...APPROVE,
];

/** The verb of a permission: anything but `read` is a write, and needs a token's `write` scope. */
export const permissionVerb = (permission: Permission): string =>
	permission.slice(permission.lastIndexOf(".") + 1);

export const PERMISSION_REFUSAL_CODES = ["PERMISSION_FORBIDDEN"] as const;
export type PermissionRefusalCode = (typeof PERMISSION_REFUSAL_CODES)[number];

export type PermissionScope =
	| { kind: "project"; id: string }
	| { kind: "org"; id: string };

/**
 * What a project permission is asked about: a resource of a project. Only `projectId` decides today;
 * `type` and `id` name the row so that per-resource permissions need no call site to change.
 */
export interface ProjectResource {
	type: string;
	id: string | null;
	projectId: string;
}

/** What an org permission is asked about. */
export interface OrgResource {
	type: "org";
	id: string;
}

export type PermissionResource = ProjectResource | OrgResource;

/** The one refusal for a missing permission; `permission` and `scope` ride beside the envelope's fields. */
export interface PermissionRefusal {
	code: PermissionRefusalCode;
	path: string;
	detail: string;
	permission: Permission;
	scope: PermissionScope;
}

export const PERMISSION_GRANT_REFUSAL_CODES = ["MEMBER_GRANT_UNKNOWN_PERMISSION"] as const;
