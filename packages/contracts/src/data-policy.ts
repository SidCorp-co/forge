// one declaration of a project's data policy (decision Q8, owner ruling 2026-10-03 on HOP): the project
// document, core's single egress guard and the web read the levels here; each level's meaning is its badge tip.
export const SENSITIVE_DATA_LEVELS = ["off", "redact", "no_egress"] as const;
export type SensitiveDataLevel = (typeof SENSITIVE_DATA_LEVELS)[number];

export const SENSITIVE_DATA_BADGES: Record<
	SensitiveDataLevel,
	{ label: string; tone: "neutral" | "attention" | "failure"; tip: string }
> = {
	off: {
		label: "No restriction",
		tone: "neutral",
		tip: "Content may reach an embedding or LLM provider as written",
	},
	redact: {
		label: "Redacted",
		tone: "attention",
		tip: "Content is scrubbed on write; only redacted text reaches a provider",
	},
	no_egress: {
		label: "No egress",
		tone: "failure",
		tip: "Content is scrubbed on write; product content (requirements, designs, issues, onboarding answers) reaches agents scrubbed, and operational content (feedback, attachments, conversations with people) never reaches a provider, which runs outside the data's residency",
	},
};

export const SENSITIVE_DATA_DEFAULT: SensitiveDataLevel = "off";

export const EGRESS_CLASSES = ["product", "operational"] as const;
export type EgressClass = (typeof EGRESS_CLASSES)[number];

export const DATA_EGRESS_REFUSAL_CODES = [
	"CONTENT_EGRESS_FORBIDDEN",
	"EGRESS_SURFACE_UNDECLARED",
] as const;
export type DataEgressRefusalCode = (typeof DATA_EGRESS_REFUSAL_CODES)[number];

export const scrubsOnWrite = (level: SensitiveDataLevel) => level !== "off";
