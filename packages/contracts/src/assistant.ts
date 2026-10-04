// The codes the assistant's chat tools and speaker identity refuse under.

export const ASSISTANT_REFUSAL_CODES = [
	"ASSISTANT_REFUSED",
	"ASSISTANT_WEEKLY_OFF",
] as const;

export type AssistantRefusalCode = (typeof ASSISTANT_REFUSAL_CODES)[number];

export const SPEAKER_REFUSAL_CODES = [
	"SPEAKER_UNLINKED",
	"SPEAKER_SOURCE_UNKNOWN",
	"SPEAKER_DIRECTORY_UNSUPPORTED",
	"SPEAKER_DIRECTORY_UNREACHABLE",
	"SPEAKER_NOT_ON_CHANNEL",
	"SPEAKER_EMAIL_ABSENT",
	"SPEAKER_NOT_THE_TARGET",
	"SPEAKER_ADDRESS_DIFFERS",
	"SPEAKER_ALREADY_LINKED",
] as const;

export type SpeakerRefusalCode = (typeof SPEAKER_REFUSAL_CODES)[number];

/** Why a memory note the assistant drafted was not kept; the model reads these lowercase names. */
export const NOTE_REFUSAL_CODES = [
	"unasked",
	"restates_message",
	"second_note_this_turn",
	"too_short",
	"too_long",
	"duplicate",
	"about_the_conversation",
] as const;

export type NoteRefusalCode = (typeof NOTE_REFUSAL_CODES)[number];

/** The chat tool a room turn calls to hand a question to a runner. */
export const ESCALATE_TOOL_NAME = "escalate";
