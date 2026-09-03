/**
 * The closed set of body formats, in one place.
 *
 * Kept in its own leaf module because `db/schema.ts` needs it for the column
 * enum and `body/prepare.ts` needs it for the validator: a second copy in
 * either would let a row be written that the other cannot render. Same shape
 * as `pipeline/failure-causes.ts`, which schema.ts already imports for the
 * same reason.
 */

// cm:guard adding a format means teaching `prepareBody` a branch AND giving web a renderer for it in the same change — a value the column accepts and no reader knows produces a row that renders as nothing
export const BODY_FORMATS = ['markdown', 'html'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];
