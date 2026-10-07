"use client";

// Every mutation invalidates the SHARED keys `['project', id]` and `['projects']` rather than a key
// of its own: those are what the dashboard, the console and the WS reconnect-replay read, and a
// private key updates none.

import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@/features/projects/types";
import { projectSettingsApi } from "./api";
import { releaseReadinessKey, useToastedMutation } from "@/features/project-config/hooks";
import { useCopy } from "@/lib/i18n/interface-language";
import type { LabelCreateInput, LabelPatchInput, PluginDesignation, ProjectRole, ProjectUpdateInput } from "./types";

const project = (id: string | undefined) => ["project", id];
const members = (id: string | undefined) => ["project", id, "members"];
const invitations = (id: string | undefined) => ["project", id, "invitations"];
const labels = (id: string | undefined) => ["project", id, "labels"];

function useProjectQuery<T>(key: readonly unknown[], id: string | undefined, read: (id: string) => Promise<T>) {
	return useQuery({ queryKey: key, queryFn: () => read(id as string), enabled: Boolean(id) });
}

/** PATCH the project row (its org). Invalidates the detail + console list. */
export function useUpdateProject(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (patch: ProjectUpdateInput) => projectSettingsApi.update(id as string, patch),
		invalidates: [project(id), ["projects"]],
		saved: t("settings.project.toast.projectSaved"),
		failed: t("settings.project.toast.projectFailed"),
	});
}

/** Soft archive (owner only): the archived project drops out of the default list (ISS-353). */
export function useArchiveProject(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation<void, ProjectDetail>({
		mutationFn: () => projectSettingsApi.archive(id as string),
		invalidates: [project(id), ["projects"]],
		saved: t("settings.project.toast.archived"),
		failed: t("settings.project.toast.archiveFailed"),
	});
}

export function useUnarchiveProject(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation<void, ProjectDetail>({
		mutationFn: () => projectSettingsApi.unarchive(id as string),
		invalidates: [project(id), ["projects"]],
		saved: t("settings.project.toast.unarchived"),
		failed: t("settings.project.toast.unarchiveFailed"),
	});
}

export function useUpdatePlugins(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (plugins: PluginDesignation[]) => projectSettingsApi.updatePlugins(id as string, plugins),
		invalidates: [project(id)],
		saved: t("settings.project.toast.pluginsSaved"),
		failed: t("settings.project.toast.pluginsFailed"),
	});
}

/** What this project still owes before its first issue runs. */
export const useReleaseReadiness = (id: string | undefined) =>
	useProjectQuery(releaseReadinessKey(id), id, projectSettingsApi.getReleaseReadiness);

export const useMembers = (id: string | undefined) => useProjectQuery(members(id), id, projectSettingsApi.listMembers);

export function useInviteMember(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: ({ email, role }: { email: string; role: ProjectRole }) =>
			projectSettingsApi.inviteMember(id as string, email, role),
		invalidates: [members(id), invitations(id)],
		saved: t("settings.project.toast.invited"),
		failed: t("settings.project.toast.inviteFailed"),
	});
}

/** Direct-add a same-org user to the project (no email round trip). */
export function useDirectAddMember(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
			projectSettingsApi.directAddMember(id as string, userId, role),
		invalidates: [members(id)],
		saved: t("settings.project.toast.memberAdded"),
		failed: t("settings.project.toast.memberAddFailed"),
	});
}

export const useInvitations = (id: string | undefined) =>
	useProjectQuery(invitations(id), id, projectSettingsApi.listInvitations);

export function useRevokeInvitation(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (email: string) => projectSettingsApi.revokeInvitation(id as string, email),
		invalidates: [invitations(id)],
		saved: t("settings.project.toast.invitationCancelled"),
		failed: t("settings.project.toast.invitationCancelFailed"),
	});
}

export function useUpdateMemberRole(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
			projectSettingsApi.updateMemberRole(id as string, userId, role),
		invalidates: [members(id)],
		saved: t("settings.project.toast.roleUpdated"),
		failed: t("settings.project.toast.roleFailed"),
	});
}

export function useRemoveMember(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (userId: string) => projectSettingsApi.removeMember(id as string, userId),
		invalidates: [members(id), project(id)],
		saved: t("settings.project.toast.memberRemoved"),
		failed: t("settings.project.toast.memberRemoveFailed"),
	});
}

export const useLabels = (id: string | undefined) => useProjectQuery(labels(id), id, projectSettingsApi.listLabels);

export function useCreateLabel(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (body: LabelCreateInput) => projectSettingsApi.createLabel(id as string, body),
		invalidates: [labels(id), project(id)],
		saved: (_row, body) => t(body.kind === "module" ? "settings.project.toast.moduleCreated" : "settings.project.toast.labelCreated"),
		failed: (body) => t(body.kind === "module" ? "settings.project.toast.moduleFailed" : "settings.project.toast.labelFailed"),
	});
}

/** Rename / recolour / re-parent / re-describe a label or module (`PATCH /api/labels/:id`). */
export function useUpdateLabel(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (args: { labelId: string; patch: LabelPatchInput }) =>
			projectSettingsApi.updateLabel(args.labelId, args.patch),
		invalidates: [labels(id), project(id), ["issues"]],
		saved: t("settings.project.toast.saved"),
		failed: t("settings.project.toast.saveFailed"),
	});
}

export function useDeleteLabel(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: projectSettingsApi.deleteLabel,
		invalidates: [labels(id), project(id), ["issues"]],
		saved: t("settings.project.toast.deleted"),
		failed: t("settings.project.toast.deleteFailed"),
	});
}

/** A knowledge entry a release gap names, written by a person; the readiness read is what it changes. */
export function useWriteKnowledge(id: string | undefined) {
	const t = useCopy();
	return useToastedMutation({
		mutationFn: (entry: { slug: string; title: string; body: string }) =>
			projectSettingsApi.putKnowledgeEntry(id as string, entry.slug, { title: entry.title, body: entry.body }),
		invalidates: [releaseReadinessKey(id)],
		saved: (_row, entry) => t("settings.project.toast.knowledgeSaved", { name: entry.title }),
	});
}
