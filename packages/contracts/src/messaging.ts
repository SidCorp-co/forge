// The code a message the screen will not pass is refused under, at every write door.

export const MESSAGE_REFUSAL_CODES = ["MESSAGE_REFUSED"] as const;

export type MessageRefusalCode = (typeof MESSAGE_REFUSAL_CODES)[number];

/** Every write door a message reaches the world through. */
export type DoorId =
	| "comment-write"
	| "record-event-write"
	| "question-ask"
	| "question-delivery"
	| "chat-sync"
	| "web-chat-reply"
	| "escalation-synthesis"
	| "agent-chat-completion"
	| "web-agent-completion";

declare const admittedByADoor: unique symbol;

/** A message a door's screen admitted; only core's `messaging/proven.ts` mints one. */
export interface ProvenMessage {
	readonly [admittedByADoor]: true;
	readonly text: string;
	readonly door: DoorId;
}
