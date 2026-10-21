"use client";

import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesApi } from "./api";
import type { SshKeyCreateInput, SshKeyUsedByProject } from "./types";
import { failureToast } from "@/lib/api/failure-toast";

/** 409 payload shape for a safe-delete rejection (`ApiError.details`). */
export interface KeyInUseDetails {
	referencedBy: SshKeyUsedByProject[];
}

/** Read the structured `referencedBy` list off a KEY_IN_USE 409, if present. */
export function keyInUseDetails(err: unknown): KeyInUseDetails | null {
	if (!(err instanceof ApiError) || err.code !== "KEY_IN_USE") return null;
	const details = err.details as Partial<KeyInUseDetails> | undefined;
	return Array.isArray(details?.referencedBy) ? { referencedBy: details.referencedBy } : null;
}

/** The org's Private Keys pool. Keyed `['orgs', orgId, 'ssh-keys']`. */
export function useOrgSshKeys(orgId: string | null) {
	return useQuery({
		queryKey: ["orgs", orgId, "ssh-keys"],
		queryFn: () => resourcesApi.listSshKeys(orgId as string),
		enabled: !!orgId,
	});
}

/** Where the form shows a create refusal: under Private key when about the key, else at its foot. */
export function createKeyRefusal(err: unknown): { field: "privateKey" | "form"; message: string } | null {
	if (!err) return null;
	if (err instanceof ApiError && err.code === "DUPLICATE_FINGERPRINT")
		return { field: "privateKey", message: "This key is already in the pool: one there has the same fingerprint." };
	if (err instanceof ApiError && err.code === "INVALID_PRIVATE_KEY")
		return { field: "privateKey", message: err.message };
	return { field: "form", message: formatApiError(err) };
}

export function useCreateSshKey(orgId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (body: SshKeyCreateInput) => resourcesApi.createSshKey(orgId, body),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["orgs", orgId, "ssh-keys"] });
			toast({ title: "Private key created", tone: "success" });
		},
	});
}

/**
 * Safe-delete a pool key. On a 409 KEY_IN_USE the caller (the confirm dialog)
 * reads `keyInUseDetails(error)` to surface the referencing-project list
 * inline — the toast alone is not enough per the UX contract.
 */
export function useDeleteSshKey(orgId: string) {
	const qc = useQueryClient();
	const { toast } = useToast();
	return useMutation({
		mutationFn: (keyId: string) => resourcesApi.deleteSshKey(orgId, keyId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["orgs", orgId, "ssh-keys"] });
			toast({ title: "Private key deleted", tone: "success" });
		},
		onError: (err) => {
			if (keyInUseDetails(err)) return; // surfaced inline by the confirm dialog, not a toast
			toast(failureToast(err, "The key was not deleted"));
		},
	});
}

/** Probe a pool key's reachability against a caller-supplied repo URL. */
export function useTestSshKey(orgId: string) {
	const { toast } = useToast();
	return useMutation({
		mutationFn: ({ keyId, repoUrl }: { keyId: string; repoUrl: string }) =>
			resourcesApi.testSshKey(orgId, keyId, repoUrl),
		onError: (err) =>
			toast(failureToast(err, "The connection was not tested")),
	});
}
