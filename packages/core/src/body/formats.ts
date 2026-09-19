export const BODY_FORMATS = ['markdown', 'html'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];
