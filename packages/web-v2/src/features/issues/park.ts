"use client";

// The status control at a park: the decision the person has, then the transitions map behind one
// more click (ISS-1310). The park view is read once and every surface below takes it from here.

import { useQuery } from "@tanstack/react-query";
import type { MenuItem } from "@/design";
import {
	allowedTransitions,
	type ParkReading,
	parkAsksAQuestion,
	statusLabel,
} from "./derive";
import { issueDetailApi } from "./detail-api";
import type { IssuePark, IssueStatus } from "./types";

/**
 * Keyed under the issue's comments, so a park record posted after the move is read when the thread
 * refreshes, and on the status, so a move reads the park it lands in.
 */
export const parkQueryKey = (issueId: string | undefined, status: IssueStatus | undefined) =>
	["comments", issueId, "park", status] as const;

export function useIssuePark(
	issueId: string | undefined,
	status: IssueStatus | undefined,
): ParkReading {
	const q = useQuery({
		queryKey: parkQueryKey(issueId, status),
		queryFn: () => issueDetailApi.getPark(issueId as string),
		enabled: Boolean(issueId && status),
	});
	if (q.isError) return { state: "error" };
	if (q.isPending || !q.data) return { state: "loading" };
	return { state: "ready", park: q.data.park };
}

export const ANSWER_LABEL = "Answer the question";
export const NOT_NEEDED_LABEL = "The question is not needed any more…";
export const MOVE_ANYWAY_LABEL = "Move anyway…";
export const NO_RUNG_LABEL = "Nothing says where this issue picks up again";
export const PARK_LOADING_LABEL = "Reading what this issue is waiting on…";
export const PARK_ERROR_LABEL = "Couldn't read what this issue is waiting on, so no resume is offered";

export interface ParkMenuActions {
	answer: () => void;
	/** A move straight from the menu: the status the park left, `on_hold`, `dropped`. */
	move: (to: IssueStatus) => void;
	notNeeded: (resumeAt: IssueStatus) => void;
	/** Every target the map holds, behind one reason. */
	moveAnyway: (targets: IssueStatus[]) => void;
}

/* Core's AWAITING_INPUT_STATUSES: the park view reads a record and a question only here; `on_hold`
   owes nothing, so its own exits are its whole menu. */
const PARKED: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["needs_info"]);
const SET_DOWN: IssueStatus[] = ["on_hold", "dropped"];

/**
 * The menu for an issue a person owes something, or `null` where the ordinary map is the whole
 * answer. At a park: answer, resume at the status it left, not needed, set down, then the map.
 * At a working status holding a question: answer, above that status's own moves.
 */
export function parkMenuItems(args: {
	status: IssueStatus;
	/** The status the park left (`workState.leftStatus`): what the map returns it to. */
	leftStatus?: IssueStatus | null;
	reading: ParkReading;
	ordinary: MenuItem[];
	actions: ParkMenuActions;
}): MenuItem[] | null {
	const { status, leftStatus = null, reading, ordinary, actions } = args;
	const parked = PARKED.has(status);
	const map = allowedTransitions(status, leftStatus);
	const anyway: MenuItem[] = [
		{
			label: MOVE_ANYWAY_LABEL,
			separatorBefore: true,
			disabled: map.length === 0,
			onSelect: () => actions.moveAnyway(map),
		},
	];
	if (reading.state !== "ready") {
		if (!parked) return null;
		const said = reading.state === "loading" ? PARK_LOADING_LABEL : PARK_ERROR_LABEL;
		return [{ label: said, disabled: true }, ...anyway];
	}
	const park = reading.park;
	if (!park) return null;
	const asks = parkAsksAQuestion(park);
	const answer: MenuItem[] = asks ? [{ label: ANSWER_LABEL, onSelect: actions.answer }] : [];
	if (park.shape === "question") {
		const below = ordinary.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item));
		return [...answer, ...below];
	}
	return [...answer, ...resumeItems(park, asks, actions), ...setDownItems(map, actions), ...anyway];
}

function resumeItems(park: IssuePark, asks: boolean, actions: ParkMenuActions): MenuItem[] {
	const at = park.resume.at;
	if (!at) return [{ label: NO_RUNG_LABEL, disabled: true }];
	const resume: MenuItem = { label: `Resume at ${statusLabel(at)}`, onSelect: () => actions.move(at) };
	if (!asks) return [resume];
	return [resume, { label: NOT_NEEDED_LABEL, onSelect: () => actions.notNeeded(at) }];
}

function setDownItems(map: IssueStatus[], actions: ParkMenuActions): MenuItem[] {
	return SET_DOWN.filter((to) => map.includes(to)).map((to, i) => ({
		label: statusLabel(to),
		danger: to === "dropped",
		separatorBefore: i === 0,
		onSelect: () => actions.move(to),
	}));
}
