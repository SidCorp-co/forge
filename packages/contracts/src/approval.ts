// Approval is a permission (owner ruling 2026-10-04, docs/adr/0007-approval-is-a-permission.md):
// who may approve, accept, agree, sign or verify is decided only by whether the actor holds
// `<resource>.approve` on the project. Neither agency nor authorship is read.

/** Every resource an approve-type act decides, each with its own permission. */
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

/** The project roles, weakest first, as core ranks them (an org owner or admin holds `admin` on every project of the org). */
export const APPROVAL_ROLES = ["viewer", "member", "admin"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

/** The default grant: the least project role holding each permission. */
export const APPROVAL_GRANTS: Readonly<Record<ApprovalPermission, ApprovalRole>> = {
	"requirements.approve": "admin",
	"mockups.approve": "admin",
	"suggestions.approve": "admin",
	"workflow-designs.approve": "admin",
	"contracts.approve": "admin",
	"feedback.approve": "admin",
	"releases.approve": "admin",
	"plans.approve": "admin",
};

export const APPROVAL_REFUSAL_CODES = ["APPROVE_PERMISSION_REQUIRED"] as const;
export type ApprovalRefusalCode = (typeof APPROVAL_REFUSAL_CODES)[number];

/** The one refusal for a missing permission; `permission` and `resource` ride beside the envelope's fields. */
export interface ApprovalRefusal {
	code: ApprovalRefusalCode;
	path: string;
	detail: string;
	permission: ApprovalPermission;
	resource: string;
}
