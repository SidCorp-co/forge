/**
 * The parsed `forge-record` block a comment carries, as it crosses the wire.
 *
 * Core parses it and web-v2 draws it. The parse does NOT happen twice: this is
 * the shape `packages/core/src/messaging/forge-record.ts` produces and the
 * comment node carries, for the same reason `BodyNode` crosses here rather than
 * being re-derived in the browser — the two would drift, and two parsers that
 * can disagree is the defect ISS-1089 exists to replace.
 */

/** Which reading a project's own members are screened and drawn under. */
export type RecordLens = "product" | "technical";

export interface ForgeRecordFieldView {
  readonly key: string;
  readonly value: string;
  /** Characters past the field budget, or 0. A card folds a field past it. */
  readonly over: number;
}

export interface ForgeRecordView {
  /** The kind the tag line names, or null where the block carries no tag. */
  readonly kind: string | null;
  readonly contract: number | null;
  /** Every key in the order written; a key repeated in one block repeats here. */
  readonly fields: readonly ForgeRecordFieldView[];
  /** The record's own one-sentence lead, or null where it carries none. */
  readonly lead: string | null;
  /** Fields ISS-1089 asks for that the record does not carry. */
  readonly absent: readonly string[];
  /** Where the block sits in the body, so the prose around it keeps its place. */
  readonly at: number;
  readonly to: number;
}
