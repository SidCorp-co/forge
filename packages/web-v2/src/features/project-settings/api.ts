
import type { ProjectDetail } from "@/features/projects/types";
import { apiClient } from "@/lib/api/client";
import type {
	ProjectInvitationRow,
	LabelCreateInput,
	LabelPatchInput,
	PolicyDocument,
	PolicyRead,
	ProjectLabel,
	ProjectMemberRow,
	PluginDesignation,
	MemoryModel,
	MemoryModelStatus,
	MemoryReindexEstimate,
	ProjectUpdateInput,
	ReleaseReadiness,
} from "./types";

export const projectSettingsApi = {
	/** `PATCH /api/projects/:id` — basics + repo (owner only). Returns the row. */
	update: (id: string, patch: ProjectUpdateInput) =>
		apiClient<ProjectDetail>(`/projects/${id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),

	archive: (id: string) =>
		apiClient<ProjectDetail>(`/projects/${id}/archive`, { method: "POST" }),

	/** `POST /api/projects/:id/unarchive` — clear `archivedAt` (owner only). */
	unarchive: (id: string) =>
		apiClient<ProjectDetail>(`/projects/${id}/unarchive`, { method: "POST" }),

	/** `GET /api/projects/:id/policy` — the policy dispatch reads, or `declared: false`. */
	getPolicy: (id: string) => apiClient<PolicyRead>(`/projects/${id}/policy`),

	/** `PUT /api/projects/:id/policy` — the whole document, against the revision it was read at
	 *  (`null` when there is none). A 422 carries `error.refusals`, each naming its path. */
	putPolicy: (id: string, baseRevision: number | null, document: PolicyDocument) =>
		apiClient<PolicyRead & { created: boolean }>(`/projects/${id}/policy`, {
			method: "PUT",
			body: JSON.stringify({ baseRevision, document }),
		}),

	runAssistantWeekly: (id: string) =>
		apiClient<
			| { outcome: "posted"; windowId: string }
			| { outcome: "skipped"; windowId: string; reason: string }
			| { outcome: "failed"; windowId: string; error: string }
		>(`/projects/${id}/assistant-weekly/run`, { method: "POST" }),

	/** `PATCH /api/projects/:id/plugins` — replaces `agentConfig.plugins` whole. */
	updatePlugins: (id: string, plugins: PluginDesignation[]) =>
		apiClient<{ plugins: PluginDesignation[] }>(`/projects/${id}/plugins`, {
			method: "PATCH",
			body: JSON.stringify({ plugins }),
		}),

	/** `GET /api/projects/:id/release-readiness` — what this project still owes
	 *  before its first issue runs. Member-gated. */
	getReleaseReadiness: (id: string) =>
		apiClient<ReleaseReadiness>(`/projects/${id}/release-readiness`),

	getKnowledgeEntry: (id: string, slug: string) =>
		apiClient<{ slug: string; body: string }>(`/projects/${id}/knowledge/${slug}`),

	/** `GET /api/projects/:id/members` — members with emails. */
	listMembers: (id: string) =>
		apiClient<ProjectMemberRow[]>(`/projects/${id}/members`),

	directAddMember: (
		id: string,
		userId: string,
		role: "admin" | "member" | "viewer",
	) =>
		apiClient<ProjectMemberRow>(`/projects/${id}/members`, {
			method: "POST",
			body: JSON.stringify({ userId, role }),
		}),

	/** `POST /api/projects/:id/members/invite` — invite by email (owner/admin). */
	inviteMember: (
		id: string,
		email: string,
		role: "admin" | "member" | "viewer",
	) =>
		apiClient<unknown>(`/projects/${id}/members/invite`, {
			method: "POST",
			body: JSON.stringify({ email, role }),
		}),

	/** `DELETE /api/projects/:id/members/:userId` — remove a member. */
	removeMember: (id: string, userId: string) =>
		apiClient<unknown>(`/projects/${id}/members/${userId}`, {
			method: "DELETE",
		}),

	/** `PATCH /api/projects/:id/members/:userId` — change a member's role (owner only). */
	updateMemberRole: (
		id: string,
		userId: string,
		role: "admin" | "member" | "viewer",
	) =>
		apiClient<unknown>(`/projects/${id}/members/${userId}`, {
			method: "PATCH",
			body: JSON.stringify({ role }),
		}),

	/** `GET /api/projects/:id/members/invitations` — pending invitations (owner/admin). */
	listInvitations: (id: string) =>
		apiClient<ProjectInvitationRow[]>(`/projects/${id}/members/invitations`),

	/** `DELETE /api/projects/:id/members/invitations?email=` — revoke a pending invitation. */
	revokeInvitation: (id: string, email: string) =>
		apiClient<unknown>(
			`/projects/${id}/members/invitations?email=${encodeURIComponent(email)}`,
			{ method: "DELETE" },
		),

	/** `GET /api/projects/:id/labels` — project labels. */
	listLabels: (id: string) =>
		apiClient<ProjectLabel[]>(`/projects/${id}/labels`),

	/** `POST /api/projects/:id/labels` — create a label or a module (admin). */
	createLabel: (id: string, body: LabelCreateInput) =>
		apiClient<ProjectLabel>(`/projects/${id}/labels`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	/** `PATCH /api/labels/:labelId` — rename / recolour / re-parent / re-describe
	 *  (admin, top-level route). */
	updateLabel: (labelId: string, patch: LabelPatchInput) =>
		apiClient<ProjectLabel>(`/labels/${labelId}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),

	/** `DELETE /api/labels/:labelId` — delete a label (note: top-level route). */
	deleteLabel: (labelId: string) =>
		apiClient<unknown>(`/labels/${labelId}`, { method: "DELETE" }),

	/** `GET /api/app-config/:id/memory-model/reindex` → `{ model, reindex }` (viewer). */
	getMemoryModel: (id: string) =>
		apiClient<MemoryModelStatus>(`/app-config/${id}/memory-model/reindex`),

	/** `GET /api/app-config/:id/memory-model/estimate` (viewer) — nothing is enqueued. */
	getMemoryEstimate: (id: string) =>
		apiClient<MemoryReindexEstimate>(`/app-config/${id}/memory-model/estimate`),

	/** `POST /api/app-config/:id/memory-model { model }` (admin). `chunked` → 202 with the
	 *  queued state, 409 `REINDEX_LIVE` while a reindex runs; `flat` → 200 at once. */
	setMemoryModel: (id: string, model: MemoryModel) =>
		apiClient<MemoryModelStatus>(`/app-config/${id}/memory-model`, {
			method: "POST",
			body: JSON.stringify({ model }),
		}),

	/** `DELETE /api/app-config/:id/memory-model/reindex` (admin) — 409 when nothing is live. */
	cancelMemoryReindex: (id: string) =>
		apiClient<MemoryModelStatus>(`/app-config/${id}/memory-model/reindex`, {
			method: "DELETE",
		}),
};
