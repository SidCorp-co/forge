"use client";

import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { namedRefusals } from "@/lib/api/refusals";
import { useToast } from "@/providers/toast-provider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { resourcesApi } from "./api";
import type { SshKeyCreateInput } from "./types";

/** A safe-delete refused: one KEY_IN_USE refusal per project still holding the key. */
export interface KeyInUseDetails {
	referencedBy: string[];
}

/** The projects a KEY_IN_USE refusal names, one sentence each, if it is one. */
export function keyInUseDetails(err: unknown): KeyInUseDetails | null {
	const rows = namedRefusals(err).filter((r) => r.code === "KEY_IN_USE");
	return rows.length > 0 ? { referencedBy: rows.map((r) => r.detail) } : null;
}

/** The org's Private Keys pool. Keyed `['orgs', orgId, 'ssh-keys']`. */
export function useOrgSshKeys(orgId: string | null) {
	return useQuery({
		queryKey: ["orgs", orgId, "ssh-keys"],
		queryFn: () => resourcesApi.listSshKeys(orgId as string),
		enabled: !!orgId,
	});
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
		onError: (err) => {
			const description =
				err instanceof ApiError && err.code === "DUPLICATE_FINGERPRINT"
					? "This key already exists in the pool (matching fingerprint)."
					: formatApiError(err);
			toast({ title: "Couldn't create key", description, tone: "error" });
		},
	});
}

/**
 * Safe-delete a pool key. On a KEY_IN_USE refusal the caller (the confirm dialog)
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
			toast({ title: "Couldn't delete key", description: formatApiError(err), tone: "error" });
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
			toast({ title: "Couldn't test connection", description: formatApiError(err), tone: "error" }),
	});
}
