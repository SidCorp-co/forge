// What runs on a project now (REQ-15 BC-10, ISS-856): the bar on every project page reads the run
// standing with its master (`run-standing.ts`) and each support room's turn, served here by
// `GET /api/projects/:id/support/turns`, and reads them again on the project room's frames. Where
// no frame said a thing moved (a run declared, a master's pass opened or closed, a room's message
// recorded or its turn handed on or ended), core tells the project room `project.now.changed`.

import type { SupportRoomKind } from "./support-operations.js";

/**
 * Which read a `project.now.changed` frame says moved: the runs and their master, the rooms, or an
 * in-progress issue's work step (ISS-951), which the runs read and the workspace's Activity show.
 */
export const PROJECT_NOW_SOURCES = ["runs", "master", "rooms", "step"] as const;
export type ProjectNowSource = (typeof PROJECT_NOW_SOURCES)[number];

export interface ProjectNowFrame {
	projectId: string;
	source: ProjectNowSource;
}

/**
 * A support room's turn: `answering` while its session's turn runs; `waiting` while a member's
 * message no turn took yet stands and no turn runs; `quiet` otherwise. A room with no session and
 * a message waiting reads `waiting`: nobody answers it.
 */
export const SUPPORT_TURN_STATES = ["answering", "waiting", "quiet"] as const;
export type SupportTurnState = (typeof SUPPORT_TURN_STATES)[number];

export interface SupportRoomTurn {
	roomId: string;
	/** The Rocket.Chat group the room is, which its channel page is addressed by. */
	rid: string;
	kind: SupportRoomKind;
	state: SupportTurnState;
	/** Members' messages no turn took yet. */
	waiting: number;
	/** When the oldest of them was recorded; null when none waits. */
	waitingSince: string | null;
	/** The newest act in the room, anyone's; null for a room nothing happened in. */
	lastActivityAt: string | null;
}

export interface SupportTurnsView {
	generatedAt: string;
	projectId: string;
	rooms: SupportRoomTurn[];
}
