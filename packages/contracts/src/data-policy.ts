// cm:why one declaration of a project's data policy (decision Q8, owner ruling 2026-10-03 on HOP):
// the project document, core's single egress guard and the web read the levels from here.

/**
 * off: content may reach an embedding or LLM provider as written. redact: it is scrubbed on write,
 * and only redacted text leaves. no_egress: it is scrubbed on write, and no content leaves at all,
 * redacted or not, because the providers run outside the data's residency.
 */
export const SENSITIVE_DATA_LEVELS = ["off", "redact", "no_egress"] as const;
export type SensitiveDataLevel = (typeof SENSITIVE_DATA_LEVELS)[number];

/** A level absent from the project document reads as this. */
export const SENSITIVE_DATA_DEFAULT: SensitiveDataLevel = "off";

/** What a provider-bound read of withheld content is refused with; the caller gets metadata only. */
export const DATA_EGRESS_REFUSAL_CODES = ["CONTENT_EGRESS_FORBIDDEN"] as const;
export type DataEgressRefusalCode = (typeof DATA_EGRESS_REFUSAL_CODES)[number];

/** True when content is scrubbed before it is stored. */
export const scrubsOnWrite = (level: SensitiveDataLevel) => level !== "off";
