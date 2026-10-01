"use client";

import { useToast } from "@/providers/toast-provider";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configApi } from "./config-api";
import type { V1Write, V1Written } from "./config-types";

export const releaseReadinessKey = (id: string | undefined) =>
	["project", id, "release-readiness"] as const;

const keys = {
	project: (id: string | undefined) => ["project", id, "config"] as const,
	policy: (id: string | undefined) => ["project", id, "policy"] as const,
	profiles: (id: string | undefined) => ["project", id, "testing-profiles"] as const,
	bindings: (id: string | undefined) => ["project", id, "bindings"] as const,
	secrets: (id: string | undefined) => ["project", id, "secrets"] as const,
	effective: (id: string | undefined) => ["project", id, "config-effective"] as const,
	environments: (id: string | undefined) => ["project", id, "environment-state"] as const,
	readiness: (id: string | undefined) => releaseReadinessKey(id),
};

/** Every read a written document changes: its own list, and the reads composed from it. */
function documentWrittenKeys(id: string | undefined, owner: readonly unknown[]) {
	return [owner, keys.effective(id), keys.environments(id), keys.readiness(id)];
}

/** Refresh every panel that reads a binding, whichever surface wrote it. */
export function invalidateBindingChange(qc: QueryClient, id: string | undefined): void {
	for (const key of documentWrittenKeys(id, keys.bindings(id))) qc.invalidateQueries({ queryKey: key });
}

function useRead<T>(key: readonly unknown[], id: string | undefined, read: (id: string) => Promise<T>) {
	return useQuery({
		queryKey: key,
		queryFn: () => read(id as string),
		enabled: Boolean(id),
		retry: false,
	});
}

export const useProjectDocument = (id: string | undefined) =>
	useRead(keys.project(id), id, configApi.getProjectDocument);

export const usePolicyDocument = (id: string | undefined) =>
	useRead(keys.policy(id), id, configApi.getPolicy);

export const useTestingProfiles = (id: string | undefined) =>
	useRead(keys.profiles(id), id, configApi.listTestingProfiles);

export const useBindingDocuments = (id: string | undefined) =>
	useRead(keys.bindings(id), id, configApi.listBindings);

export const useSecretNames = (id: string | undefined) =>
	useRead(keys.secrets(id), id, configApi.listSecretNames);

export function useWriteSecret(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (write: { scope: string; name: string; value: string }) =>
			configApi.putSecret(id as string, write.scope, write.name, write.value),
		onSuccess: (saved) => {
			qc.invalidateQueries({ queryKey: keys.secrets(id) });
			toast({ title: `A value is stored for ${saved.ref}`, tone: "success" });
		},
	});
}

export const useEffectiveConfig = (id: string | undefined) =>
	useRead(keys.effective(id), id, configApi.getEffective);

export const useEnvironmentState = (id: string | undefined) =>
	useRead(keys.environments(id), id, configApi.getEnvironmentState);

function useDocumentWrite(
	id: string | undefined,
	owner: readonly unknown[],
	what: string,
	send: (id: string, write: V1Write) => Promise<V1Written>,
) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (write: V1Write) => send(id as string, write),
		onSuccess: (saved) => {
			for (const key of documentWrittenKeys(id, owner)) qc.invalidateQueries({ queryKey: key });
			toast({ title: `${what} saved at revision ${saved.revision}`, tone: "success" });
		},
	});
}

export const useWriteProjectDocument = (id: string | undefined) =>
	useDocumentWrite(id, keys.project(id), "Project document", configApi.putProjectDocument);

export const useWritePolicy = (id: string | undefined) =>
	useDocumentWrite(id, keys.policy(id), "Policy", configApi.putPolicy);

export const useWriteTestingProfile = (id: string | undefined, profileId: string) =>
	useDocumentWrite(id, keys.profiles(id), `Testing profile ${profileId}`, (project, write) =>
		configApi.putTestingProfile(project, profileId, write),
	);

export const useWriteBinding = (id: string | undefined, bindingId: string) =>
	useDocumentWrite(id, keys.bindings(id), "Binding", (project, write) =>
		configApi.putBinding(project, bindingId, write),
	);

export function useDeleteTestingProfile(id: string | undefined) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (profileId: string) => configApi.deleteTestingProfile(id as string, profileId),
		onSuccess: (out) => {
			qc.invalidateQueries({ queryKey: keys.profiles(id) });
			qc.invalidateQueries({ queryKey: keys.effective(id) });
			toast({ title: `Testing profile ${out.profileId} deleted`, tone: "success" });
		},
	});
}
