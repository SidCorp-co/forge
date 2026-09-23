"use client";

// The unsaved edits a person holds over a settings document. Every section here seeds a draft
// from the document the tab read, and taking the fresh document whole on a re-read is the answer
// that destroys those edits (ISS-1170 criterion 20). The rule instead: they ARE a patch, replayed
// over the fresh document. `takeStored` is the one exception, reached only by an act saying so.

import {
	canonicalJson,
	parsePath,
	rebaseDocumentDraft,
	type ReplacedEdit,
} from "@forge/contracts/document-patch";
import { useCallback, useState } from "react";

/** Where a draft sits inside the document, so a path the server named can be found in it. */
export interface DraftPlace {
	/** The draft's prefix in the document: `["states", "open"]` for one stage's editor. */
	at?: readonly string[];
	/** Overrides `at` where the draft flattens the document rather than slicing it (the Testing
	 *  tab's form). Null where the draft does not render that path at all. */
	locate?: (path: readonly string[]) => string[] | null;
}

export interface SettingsDraft<T> {
	draft: T;
	setDraft: (next: T | ((current: T) => T)) => void;
	dirty: boolean;
	/** Take the stored values at these document paths on the next read. The edits standing
	 *  there are replaced — and come back in `replaced` — while the rest are kept. */
	takeStored: (paths: readonly string[]) => void;
	replaced: ReplacedEdit[];
	dismissReplaced: () => void;
}

/** Whether either path is the other's prefix — a yielded path meeting an edit made above it. */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let at = 0; at < shared; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

function under(at: readonly string[]) {
	return (path: readonly string[]): string[] | null => {
		for (let i = 0; i < at.length; i += 1) if (path[i] !== at[i]) return null;
		return path.slice(at.length);
	};
}

/** One path asked to take the stored value: where it lives here, and what the document calls
 *  it, so a replaced edit is reported under the name the screen uses. */
interface Yielded {
	inside: string[];
	document: string;
}

interface DraftState<T> {
	seed: T;
	seedJson: string;
	held: T;
	yielding: Yielded[];
	replaced: ReplacedEdit[];
}

/** A draft over `read`, carried across every re-read. The seed is compared by value, so a
 *  refetch bringing the same document back is not a re-seed and nothing moves. */
export function useSettingsDraft<T extends object>(
	read: T,
	place: DraftPlace = {},
): SettingsDraft<T> {
	const locate = place.locate ?? under(place.at ?? []);
	const [state, setState] = useState<DraftState<T>>(() => ({
		seed: read,
		seedJson: canonicalJson(read),
		held: read,
		yielding: [],
		replaced: [],
	}));

	const seedJson = canonicalJson(read);
	if (seedJson !== state.seedJson) {
		const { draft, replaced } = rebaseDocumentDraft({
			read: state.seed,
			held: state.held,
			fresh: read,
			yielding: state.yielding.map((one) => one.inside),
		});
		setState({
			seed: read,
			seedJson,
			held: draft as T,
			yielding: [],
			replaced: replaced.map((edit) => ({
				...edit,
				path:
					state.yielding.find((one) => overlaps(one.inside, parsePath(edit.path)))
						?.document ?? edit.path,
			})),
		});
	}

	const setDraft = useCallback((next: T | ((current: T) => T)) => {
		setState((current) => ({
			...current,
			held: typeof next === "function" ? (next as (c: T) => T)(current.held) : next,
			// Someone who has typed again is no longer waiting on the re-read they asked for.
			yielding: [],
			replaced: [],
		}));
	}, []);

	const takeStored = useCallback(
		(paths: readonly string[]) => {
			const yielding: Yielded[] = [];
			for (const document of paths) {
				const inside = locate(parsePath(document));
				if (inside) yielding.push({ inside, document });
			}
			setState((current) => ({ ...current, yielding, replaced: [] }));
		},
		[locate],
	);

	const dismissReplaced = useCallback(
		() => setState((current) => ({ ...current, replaced: [] })),
		[],
	);

	return {
		draft: state.held,
		setDraft,
		dirty: canonicalJson(state.held) !== state.seedJson,
		takeStored,
		replaced: state.replaced,
		dismissReplaced,
	};
}
