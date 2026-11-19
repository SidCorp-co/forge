// The Secrets page's reads and writes (ISS-1348): the page whole, a request's one-time write URL, and
// a slot's value written through the slot's own door, which judges it (a variable, a project secret,
// a connection's credential). No value is ever read back.
import type { SecretForm, SecretSlotDoor, SecretSlotsRead, SecretWriteMinted } from "@forge/contracts/secret-slots";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const key = (id: string) => ["project", id, "secret-slots"] as const;

export const secretSlotsApi = {
	read: (id: string) => apiClient<SecretSlotsRead>(`/projects/${id}/support/secrets`),
	mint: (id: string, ask: string) =>
		apiClient<SecretWriteMinted>(`/projects/${id}/support/secrets/requests/${ask}/write-url`, { method: "POST" }),
	/** The value written at the door the slot names; a variable not held yet is added a secret (a file where its form is one). */
	write: (id: string, door: SecretSlotDoor, value: string, form: SecretForm, tier: string | null) => {
		if (door.kind === "variable") {
			return door.variable
				? apiClient(`/projects/${id}/variables/${door.variable.id}`, {
						method: "PUT",
						body: JSON.stringify({ baseVersion: door.variable.version, value }),
					})
				: apiClient(`/projects/${id}/variables`, {
						method: "POST",
						body: JSON.stringify({
							key: door.key,
							environment: door.environment,
							value,
							type: form.kind === "file" ? "file" : "secret",
							// a production value an agent asked for reaches production alone (REQ-80 BC-2)
							protected: tier === "production",
						}),
					});
		}
		if (door.kind === "secret") {
			return apiClient(`/projects/${id}/secrets/${encodeURIComponent(door.scope)}/${encodeURIComponent(door.name)}`, {
				method: "PUT",
				body: JSON.stringify({ value }),
			});
		}
		return apiClient(`/integration-connections/${door.connection}`, {
			method: "PATCH",
			body: JSON.stringify({ secrets: { [door.field]: value } }),
		});
	},
};

export const useSecretSlots = (id: string) => useQuery({ queryKey: key(id), queryFn: () => secretSlotsApi.read(id) });

/** A slot's value saved; the page reads itself again, and the receipt reaches the asking thread from core. */
export function useFillSlot(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (w: { door: SecretSlotDoor; value: string; form: SecretForm; tier: string | null }) =>
			secretSlotsApi.write(id, w.door, w.value, w.form, w.tier),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: key(id) });
			void qc.invalidateQueries({ queryKey: ["project", id, "variables"] });
			void qc.invalidateQueries({ queryKey: ["integration-connections"] });
		},
	});
}

export const useMintWriteUrl = (id: string) => useMutation({ mutationFn: (ask: string) => secretSlotsApi.mint(id, ask) });
