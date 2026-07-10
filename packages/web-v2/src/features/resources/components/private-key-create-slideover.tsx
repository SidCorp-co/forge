"use client";

// Shared "create a private key" flow — used by both the workspace Resources
// area and the project Git-access picker's inline "Create new key" shortcut
// (single dedup/validation path per the locked design; ISS-628 plan §6/§7).
// Wraps SlideOver, which already provides the focus trap + Esc-to-close the
// UX contract requires for a new modal.
import { Button, Field, Input, SegmentedControl, SlideOver, Textarea } from "@/design";
import { useState } from "react";
import { useCreateSshKey } from "../hooks";
import type { WorkspaceSshKeyView } from "../types";

export interface PrivateKeyCreateSlideOverProps {
	open: boolean;
	onClose: () => void;
	orgId: string;
	/** Called after a successful create — the picker auto-selects the new key. */
	onCreated?: (key: WorkspaceSshKeyView) => void;
}

export function PrivateKeyCreateSlideOver({
	open,
	onClose,
	orgId,
	onCreated,
}: PrivateKeyCreateSlideOverProps) {
	const create = useCreateSshKey(orgId);
	const [mode, setMode] = useState<"generate" | "provide">("generate");
	const [name, setName] = useState("");
	const [note, setNote] = useState("");
	const [privateKey, setPrivateKey] = useState("");

	function reset() {
		setMode("generate");
		setName("");
		setNote("");
		setPrivateKey("");
	}

	function handleClose() {
		reset();
		onClose();
	}

	function submit() {
		const body =
			mode === "generate"
				? { mode: "generate" as const, name: name.trim(), note: note.trim() || null }
				: {
						mode: "provide" as const,
						name: name.trim(),
						note: note.trim() || null,
						privateKey,
					};
		create.mutate(body, {
			onSuccess: (key) => {
				onCreated?.(key);
				handleClose();
			},
		});
	}

	const canSubmit = name.trim().length > 0 && (mode === "generate" || privateKey.trim().length > 0);

	return (
		<SlideOver open={open} onClose={handleClose} title="Create private key" width={460}>
			<div className="flex h-full flex-col gap-4">
				<Field label="Name">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. deploy-key-prod"
						maxLength={200}
						autoFocus
					/>
				</Field>
				<Field label="Note" hint="Optional — helps you recognize this key later.">
					<Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
				</Field>
				<div className="flex flex-col gap-2">
					<span className="fg-label">Source</span>
					<SegmentedControl
						options={[
							{ value: "generate", label: "Generate new" },
							{ value: "provide", label: "Paste existing" },
						]}
						value={mode}
						onChange={setMode}
					/>
				</div>
				{mode === "provide" && (
					<Field label="Private key" hint="OpenSSH format. Passphrase-protected keys are rejected.">
						<Textarea
							value={privateKey}
							onChange={(e) => setPrivateKey(e.target.value)}
							placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
							spellCheck={false}
							rows={6}
							className="font-mono text-[12px]"
						/>
					</Field>
				)}
				<div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
					<Button type="button" variant="ghost" onClick={handleClose} disabled={create.isPending}>
						Cancel
					</Button>
					<Button
						type="button"
						variant="primary"
						loading={create.isPending}
						disabled={!canSubmit}
						onClick={submit}
					>
						Create key
					</Button>
				</div>
			</div>
		</SlideOver>
	);
}
