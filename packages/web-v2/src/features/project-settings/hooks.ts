"use client";

// web-v2 feature module: project-settings — React Query hooks. Every mutation invalidates the
// SHARED keys `['project', id]` and `['projects']` rather than a key of its own: those are what
// the dashboard, the console and the WS reconnect-replay read, and a private key updates none.

import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectSettingsApi } from "./api";
import { releaseReadinessKey } from "./config-hooks";
import type {
	LabelCreateInput,
	LabelPatchInput,
	PluginDesignation,
	ProjectUpdateInput,
} from "./types";

/** PATCH the project row (org, issue prefix, weekly assistant). Invalidates the detail + console list. */
export function useUpdateProject(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (patch: ProjectUpdateInput) =>
			projectSettingsApi.update(id as string, patch),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id] });
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast({ title: "Project saved", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't save project",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Soft archive a project (owner only). Invalidates the detail + console list
 *  so the archived project drops out of the default list (ISS-353). */
export function useArchiveProject(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: () => projectSettingsApi.archive(id as string),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id] });
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast({ title: "Project archived", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't archive project",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Unarchive a project (owner only); it reappears in the default list. */
export function useUnarchiveProject(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: () => projectSettingsApi.unarchive(id as string),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id] });
			qc.invalidateQueries({ queryKey: ["projects"] });
			toast({ title: "Project unarchived", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't unarchive project",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useUpdatePlugins(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (plugins: PluginDesignation[]) =>
			projectSettingsApi.updatePlugins(id as string, plugins),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id] });
			toast({ title: "Plugins saved", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't save plugins",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** What this project still owes before its first issue runs. */
export function useReleaseReadiness(id: string | undefined) {
	return useQuery({
		queryKey: releaseReadinessKey(id),
		queryFn: () => projectSettingsApi.getReleaseReadiness(id as string),
		enabled: Boolean(id),
	});
}

/** GET one knowledge entry by slug. A 404 is "no such entry" and not a failure, so
 *  this does not retry. It is NOT normalized to a success here: the query still
 *  reports `isError`, and the caller decides, because a 500 and a 404 must not
 *  render the same. */
export function useKnowledgeEntry(id: string | undefined, slug: string) {
	return useQuery({
		queryKey: ["project", id, "knowledge", slug],
		queryFn: () => projectSettingsApi.getKnowledgeEntry(id as string, slug),
		enabled: !!id,
		retry: false,
	});
}

export function useMembers(id: string | undefined) {
	return useQuery({
		queryKey: ["project", id, "members"],
		queryFn: () => projectSettingsApi.listMembers(id as string),
		enabled: !!id,
	});
}

export function useInviteMember(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			email,
			role,
		}: { email: string; role: "admin" | "member" | "viewer" }) =>
			projectSettingsApi.inviteMember(id as string, email, role),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "members"] });
			qc.invalidateQueries({ queryKey: ["project", id, "invitations"] });
			toast({ title: "Invitation sent", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't invite member",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Direct-add a same-org user to the project (no email round trip). */
export function useDirectAddMember(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			userId,
			role,
		}: { userId: string; role: "admin" | "member" | "viewer" }) =>
			projectSettingsApi.directAddMember(id as string, userId, role),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "members"] });
			toast({ title: "Member added", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't add member",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** GET pending invitations (owner/admin). */
export function useInvitations(id: string | undefined) {
	return useQuery({
		queryKey: ["project", id, "invitations"],
		queryFn: () => projectSettingsApi.listInvitations(id as string),
		enabled: !!id,
	});
}

/** Revoke a pending invitation by email. */
export function useRevokeInvitation(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (email: string) =>
			projectSettingsApi.revokeInvitation(id as string, email),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "invitations"] });
			toast({ title: "Invitation cancelled", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't cancel invitation",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Change a member's role (owner only). */
export function useUpdateMemberRole(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({
			userId,
			role,
		}: { userId: string; role: "admin" | "member" | "viewer" }) =>
			projectSettingsApi.updateMemberRole(id as string, userId, role),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "members"] });
			toast({ title: "Role updated", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't update role",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useRemoveMember(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (userId: string) =>
			projectSettingsApi.removeMember(id as string, userId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "members"] });
			qc.invalidateQueries({ queryKey: ["project", id] });
			toast({ title: "Member removed", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't remove member",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useLabels(id: string | undefined) {
	return useQuery({
		queryKey: ["project", id, "labels"],
		queryFn: () => projectSettingsApi.listLabels(id as string),
		enabled: !!id,
	});
}

export function useCreateLabel(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (body: LabelCreateInput) =>
			projectSettingsApi.createLabel(id as string, body),
		onSuccess: (_row, body) => {
			qc.invalidateQueries({ queryKey: ["project", id, "labels"] });
			qc.invalidateQueries({ queryKey: ["project", id] });
			toast({
				title: body.kind === "module" ? "Module created" : "Label created",
				tone: "success",
			});
		},
		onError: (err, body) =>
			toast({
				title: body.kind === "module" ? "Couldn't create module" : "Couldn't create label",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

/** Rename / recolour / re-parent / re-describe a label or module (`PATCH /api/labels/:id`). */
export function useUpdateLabel(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (args: { labelId: string; patch: LabelPatchInput }) =>
			projectSettingsApi.updateLabel(args.labelId, args.patch),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "labels"] });
			qc.invalidateQueries({ queryKey: ["project", id] });
			qc.invalidateQueries({ queryKey: ["issues"] });
			toast({ title: "Saved", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't save",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

export function useDeleteLabel(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (labelId: string) => projectSettingsApi.deleteLabel(labelId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["project", id, "labels"] });
			qc.invalidateQueries({ queryKey: ["project", id] });
			qc.invalidateQueries({ queryKey: ["issues"] });
			toast({ title: "Deleted", tone: "success" });
		},
		onError: (err) =>
			toast({
				title: "Couldn't delete",
				description: formatApiError(err),
				tone: "error",
			}),
	});
}

