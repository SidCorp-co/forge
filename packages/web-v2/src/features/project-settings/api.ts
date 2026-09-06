// web-v2 feature module: project-settings — REST surface, verified against core (ISS-316).
// The project detail itself is NOT here: `GET /api/projects/:id` lives in the `projects`
// feature as `projectApi.getById` and is reached through `useProject`.

import type { ProjectDetail } from "@/features/projects/types";
import { apiClient } from "@/lib/api/client";
import type {
	ApplyUxPresetInput,
	PipelineConfig,
	ProjectFactsPatch,
	ProjectFactsResponse,
	ProjectInvitationRow,
	LabelCreateInput,
	LabelPatchInput,
	ProjectLabel,
	ProjectMemberRow,
	PluginDesignation,
	MemoryModel,
	MemoryModelStatus,
	MemoryReindexEstimate,
	ProjectUpdateInput,
	ReleaseReadiness,
	UxContractRule,
	UxContractRulePatch,
	UxFinding,
} from "./types";

export const projectSettingsApi = {
	/** `PATCH /api/projects/:id` — basics + repo (owner only). Returns the row. */
	update: (id: string, patch: ProjectUpdateInput) =>
		apiClient<ProjectDetail>(`/projects/${id}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),

	/** `POST /api/projects/:id/archive` — soft archive (owner only). Returns the
	 *  updated row with `archivedAt` set. Non-destructive (ISS-353). */
	archive: (id: string) =>
		apiClient<ProjectDetail>(`/projects/${id}/archive`, { method: "POST" }),

	/** `POST /api/projects/:id/unarchive` — clear `archivedAt` (owner only). */
	unarchive: (id: string) =>
		apiClient<ProjectDetail>(`/projects/${id}/unarchive`, { method: "POST" }),

	/** `GET /api/projects/:id/pipeline-config` → `{ pipelineConfig }`. 404
	 *  `FEATURE_OFF` when the `pipelineControl` flag is disabled. */
	getPipelineConfig: (id: string) =>
		apiClient<{ pipelineConfig: PipelineConfig }>(
			`/projects/${id}/pipeline-config`,
		),

	/** `PATCH /api/projects/:id/pipeline-config` — full config (owner only).
	 *  Core returns `{ pipelineConfig, warnings }`; `warnings` are non-blocking
	 *  advisories (e.g. an enabled stage with no skill that will auto-skip). */
	updatePipelineConfig: (id: string, pipelineConfig: PipelineConfig) =>
		apiClient<{ pipelineConfig: PipelineConfig; warnings?: string[] }>(
			`/projects/${id}/pipeline-config`,
			{
				method: "PATCH",
				body: JSON.stringify(pipelineConfig),
			},
		),

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

	/** `GET /api/projects/:id/project-facts` → `{ projectFacts, projectFactsConfig,
	 *  maxAlwaysInjectChars }`. Member-gated. */
	getProjectFacts: (id: string) =>
		apiClient<ProjectFactsResponse>(`/projects/${id}/project-facts`),

	/** `PATCH /api/projects/:id/project-facts` — per-key merge (admin only).
	 *  Returns the merged `ProjectFactsResponse`. */
	updateProjectFacts: (id: string, patch: ProjectFactsPatch) =>
		apiClient<ProjectFactsResponse>(`/projects/${id}/project-facts`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),

	/** `GET /api/projects/:id/members` — members with emails. */
	listMembers: (id: string) =>
		apiClient<ProjectMemberRow[]>(`/projects/${id}/members`),

	/** `POST /api/projects/:id/members` — direct-add a user who is ALREADY a
	 *  member of the project's org (no email round trip). 409 `NOT_ORG_MEMBER`
	 *  when the user is outside the org, 409 `ALREADY_MEMBER` when redundant. */
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

	/** `GET /api/projects/:id/ux-contract-rules[?status=]` — viewer-gated. */
	listUxRules: (id: string, status?: string) =>
		apiClient<UxContractRule[]>(
			`/projects/${id}/ux-contract-rules${status ? `?status=${encodeURIComponent(status)}` : ""}`,
		),

	/** `GET /api/projects/:id/ux-findings` — viewer-gated, for evidence links. */
	listUxFindings: (id: string) =>
		apiClient<UxFinding[]>(`/projects/${id}/ux-findings`),

	/** `POST /api/projects/:id/ux-contract/apply-preset` (admin) — REPLACES the
	 *  whole rule set + recompiles `projectFacts['ux-contract']`. */
	applyUxPreset: (id: string, input: ApplyUxPresetInput) =>
		apiClient<{ applied: number; preset: string }>(
			`/projects/${id}/ux-contract/apply-preset`,
			{ method: "POST", body: JSON.stringify(input) },
		),

	/** `PATCH /api/ux-contract-rules/:ruleId` (admin, top-level route). */
	patchUxRule: (ruleId: string, patch: UxContractRulePatch) =>
		apiClient<UxContractRule>(`/ux-contract-rules/${ruleId}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),

	/** `DELETE /api/ux-contract-rules/:ruleId` (admin, top-level route) — 204. */
	deleteUxRule: (ruleId: string) =>
		apiClient<unknown>(`/ux-contract-rules/${ruleId}`, { method: "DELETE" }),

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
