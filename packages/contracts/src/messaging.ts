// The code a message the screen will not pass is refused under, at every write door.

export const MESSAGE_REFUSAL_CODES = ["MESSAGE_REFUSED"] as const;

export type MessageRefusalCode = (typeof MESSAGE_REFUSAL_CODES)[number];
