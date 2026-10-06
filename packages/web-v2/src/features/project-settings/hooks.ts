"use client";

// Every mutation invalidates the SHARED keys `['project', id]` and `['projects']` rather than a key
// of its own: those are what the dashboard, the console and the WS reconnect-replay read, and a
// private key updates none.

import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@/features/projects/types";
import { projectSettingsApi } from "./api";
import { releaseReadinessKey, useToastedMutation } from "@/features/project-config/hooks";
import type { LabelCreateInput, LabelPatchInput, PluginDesignation, ProjectRole, ProjectUpdateInput } from "./types";

const project = (id: string | undefined) => ["project", id];
const members = (id: string | undefined) => ["project", id, "members"];
const invitations = (id: string | undefined) => ["project", id, "invitations"];
const labels = (id: string | undefined) => ["project", id, "labels"];

function useProjectQuery<T>(key: readonly unknown[], id: string | undefined, read: (id: string) => Promise<T>) {
	return useQuery({ queryKey: key, queryFn: () => read(id as string), enabled: Boolean(id) });
}

/** PATCH the project row (its org). Invalidates the detail + console list. */
export const useUpdateProject = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (patch: ProjectUpdateInput) => projectSettingsApi.update(id as string, patch),
		invalidates: [project(id), ["projects"]],
		saved: "Project saved",
		failed: "Couldn't save project",
	});

/** Soft archive (owner only): the archived project drops out of the default list (ISS-353). */
export const useArchiveProject = (id: string | undefined) =>
	useToastedMutation<void, ProjectDetail>({
		mutationFn: () => projectSettingsApi.archive(id as string),
		invalidates: [project(id), ["projects"]],
		saved: "Project archived",
		failed: "Couldn't archive project",
	});

export const useUnarchiveProject = (id: string | undefined) =>
	useToastedMutation<void, ProjectDetail>({
		mutationFn: () => projectSettingsApi.unarchive(id as string),
		invalidates: [project(id), ["projects"]],
		saved: "Project unarchived",
		failed: "Couldn't unarchive project",
	});

export const useUpdatePlugins = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (plugins: PluginDesignation[]) => projectSettingsApi.updatePlugins(id as string, plugins),
		invalidates: [project(id)],
		saved: "Plugins saved",
		failed: "Couldn't save plugins",
	});

/** What this project still owes before its first issue runs. */
export const useReleaseReadiness = (id: string | undefined) =>
	useProjectQuery(releaseReadinessKey(id), id, projectSettingsApi.getReleaseReadiness);

export const useMembers = (id: string | undefined) => useProjectQuery(members(id), id, projectSettingsApi.listMembers);

export const useInviteMember = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: ({ email, role }: { email: string; role: ProjectRole }) =>
			projectSettingsApi.inviteMember(id as string, email, role),
		invalidates: [members(id), invitations(id)],
		saved: "Invitation sent",
		failed: "Couldn't invite member",
	});

/** Direct-add a same-org user to the project (no email round trip). */
export const useDirectAddMember = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
			projectSettingsApi.directAddMember(id as string, userId, role),
		invalidates: [members(id)],
		saved: "Member added",
		failed: "Couldn't add member",
	});

export const useInvitations = (id: string | undefined) =>
	useProjectQuery(invitations(id), id, projectSettingsApi.listInvitations);

export const useRevokeInvitation = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (email: string) => projectSettingsApi.revokeInvitation(id as string, email),
		invalidates: [invitations(id)],
		saved: "Invitation cancelled",
		failed: "Couldn't cancel invitation",
	});

export const useUpdateMemberRole = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
			projectSettingsApi.updateMemberRole(id as string, userId, role),
		invalidates: [members(id)],
		saved: "Role updated",
		failed: "Couldn't update role",
	});

export const useRemoveMember = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (userId: string) => projectSettingsApi.removeMember(id as string, userId),
		invalidates: [members(id), project(id)],
		saved: "Member removed",
		failed: "Couldn't remove member",
	});

export const useLabels = (id: string | undefined) => useProjectQuery(labels(id), id, projectSettingsApi.listLabels);

export const useCreateLabel = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (body: LabelCreateInput) => projectSettingsApi.createLabel(id as string, body),
		invalidates: [labels(id), project(id)],
		saved: (_row, body) => (body.kind === "module" ? "Module created" : "Label created"),
		failed: (body) => (body.kind === "module" ? "Couldn't create module" : "Couldn't create label"),
	});

/** Rename / recolour / re-parent / re-describe a label or module (`PATCH /api/labels/:id`). */
export const useUpdateLabel = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: (args: { labelId: string; patch: LabelPatchInput }) =>
			projectSettingsApi.updateLabel(args.labelId, args.patch),
		invalidates: [labels(id), project(id), ["issues"]],
		saved: "Saved",
		failed: "Couldn't save",
	});

export const useDeleteLabel = (id: string | undefined) =>
	useToastedMutation({
		mutationFn: projectSettingsApi.deleteLabel,
		invalidates: [labels(id), project(id), ["issues"]],
		saved: "Deleted",
		failed: "Couldn't delete",
	});
