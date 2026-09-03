"use client";

import { Button, Input, MonoTag } from "@/design";
import { useState } from "react";
import { useSetRunnerLabels } from "../hooks";

export function parseLabels(raw: string): string[] {
	const seen = new Set<string>();
	for (const part of raw.split(/[,\s]+/)) {
		const label = part.trim();
		if (label) seen.add(label);
	}
	return [...seen];
}

/** Pool labels on one runner. A production binding's `releaseRunnerLabel` names one of these. */
export function RunnerLabels({
	projectId,
	runnerId,
	labels,
	canEdit,
}: {
	projectId: string;
	runnerId: string;
	labels: string[];
	canEdit: boolean;
}) {
	const save = useSetRunnerLabels(projectId);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(labels.join(", "));

	if (editing) {
		return (
			<form
				className="flex items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					save.mutate(
						{ runnerId, labels: parseLabels(draft) },
						{ onSuccess: () => setEditing(false) },
					);
				}}
			>
				<Input
					aria-label="Runner labels"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="release, gpu"
					className="h-7 w-56 text-[12px]"
				/>
				<Button type="submit" size="sm" variant="secondary" loading={save.isPending}>
					Save labels
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={() => {
						setDraft(labels.join(", "));
						setEditing(false);
					}}
				>
					Cancel
				</Button>
			</form>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{labels.length === 0 ? (
				<span className="fg-caption text-subtle">no labels</span>
			) : (
				labels.map((label) => <MonoTag key={label}>{label}</MonoTag>)
			)}
			{canEdit && (
				<Button size="sm" variant="ghost" icon="settings" onClick={() => setEditing(true)}>
					{labels.length === 0 ? "Add labels" : "Edit labels"}
				</Button>
			)}
		</div>
	);
}
