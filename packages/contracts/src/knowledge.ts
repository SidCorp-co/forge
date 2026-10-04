// The codes a knowledge entry write refuses under.

export const KNOWLEDGE_REFUSAL_CODES = ["KNOWLEDGE_REFUSED", "KNOWLEDGE_READ_WHEN_SHAPE"] as const;

export type KnowledgeRefusalCode = (typeof KNOWLEDGE_REFUSAL_CODES)[number];
