export type RecordLens = 'product' | 'technical';

export interface ForgeRecordFieldView {
  readonly key: string;
  readonly value: string;
  readonly over: number;
}

export interface ForgeRecordView {
  readonly kind: string | null;
  readonly contract: number | null;
  readonly fields: readonly ForgeRecordFieldView[];
  readonly lead: string | null;
  /** Fields ISS-1089 asks for that the record does not carry. */
  readonly absent: readonly string[];
  /** Where the block sits in the body, so the prose around it keeps its place. */
  readonly at: number;
  readonly to: number;
}
