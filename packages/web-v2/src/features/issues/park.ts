"use client";

// The status control at a park: the decision the person has, then the transitions map behind one
// more click (ISS-1310). The park view is read once and every surface below takes it from here.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { IssueMove } from "@forge/contracts/issue-machine";
import type { MenuItem } from "@/design";
import type { Copy } from "@/lib/i18n/product-copy";
import { issueKeySegment, type ParkReading } from "./derive";
import { issueDetailApi } from "./detail-api";
import type { IssuePark, IssueStatus } from "./types";

/**
 * Keyed under the issue's comments, so a park record posted after the move is read when the thread
 * refreshes. It is read with the page's first reads, before the issue's status is known; a later
 * move of the status reads it again, so a move reads the park it lands in.
 */
const parkQueryKey = (issueId: string | undefined, projectId: string | undefined) =>
	["comments", issueKeySegment(issueId, projectId), "park"] as const;

/** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
export function useIssuePark(
	issueId: string | undefined,
	status: IssueStatus | undefined,
	projectId?: string,
): ParkReading {
	const qc = useQueryClient();
	const key = useMemo(() => parkQueryKey(issueId, projectId), [issueId, projectId]);
	const q = useQuery({
		queryKey: key,
		queryFn: () => issueDetailApi.getPark(issueId as string, projectId),
		enabled: Boolean(issueId),
	});
	const readAt = useRef<{ key: readonly unknown[]; status: IssueStatus | undefined }>({ key, status });
	useEffect(() => {
		const prior = readAt.current;
		readAt.current = { key, status };
		if (prior.key === key && prior.status !== undefined && status !== undefined && prior.status !== status) {
			void qc.invalidateQueries({ queryKey: key, exact: true });
		}
	}, [key, status, qc]);
	if (q.isError) return { state: "error" };
	if (q.isPending || !q.data) return { state: "loading" };
	return { state: "ready", park: q.data.park };
}

/** The words the park menu is drawn in: the chrome reader and the issue status's own label. */
export interface ParkWords {
	t: Copy;
	status: (s: IssueStatus) => string;
}

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
	/** Core's moves from this status, the park's return first. */
	moves: readonly IssueMove[];
	reading: ParkReading;
	ordinary: MenuItem[];
	actions: ParkMenuActions;
	words: ParkWords;
}): MenuItem[] | null {
	const { status, moves, reading, ordinary, actions, words } = args;
	const { t } = words;
	const parked = PARKED.has(status);
	const map = moves.map((m) => m.to);
	const anyway: MenuItem[] = [
		{
			label: t("issues.park.moveAnyway"),
			separatorBefore: true,
			disabled: map.length === 0,
			onSelect: () => actions.moveAnyway(map),
		},
	];
	if (reading.state !== "ready") {
		if (!parked) return null;
		const said = reading.state === "loading" ? t("issues.park.loading") : t("issues.park.error");
		return [{ label: said, disabled: true }, ...anyway];
	}
	const park = reading.park;
	if (!park) return null;
	const asks = park.asks;
	const answer: MenuItem[] = asks ? [{ label: t("issues.park.answer"), onSelect: actions.answer }] : [];
	if (park.shape === "question") {
		const below = ordinary.map((item, i) => (i === 0 ? { ...item, separatorBefore: true } : item));
		return [...answer, ...below];
	}
	return [...answer, ...resumeItems(park, asks, actions, words), ...setDownItems(map, actions, words), ...anyway];
}

function resumeItems(park: IssuePark, asks: boolean, actions: ParkMenuActions, { t, status }: ParkWords): MenuItem[] {
	const at = park.resume.at;
	if (!at) return [{ label: t("issues.park.noRung"), disabled: true }];
	const resume: MenuItem = { label: t("issues.park.resumeAt", { status: status(at) }), onSelect: () => actions.move(at) };
	if (!asks) return [resume];
	return [resume, { label: t("issues.park.notNeeded"), onSelect: () => actions.notNeeded(at) }];
}

function setDownItems(map: IssueStatus[], actions: ParkMenuActions, { status }: ParkWords): MenuItem[] {
	return SET_DOWN.filter((to) => map.includes(to)).map((to, i) => ({
		label: status(to),
		danger: to === "dropped",
		separatorBefore: i === 0,
		onSelect: () => actions.move(to),
	}));
}
