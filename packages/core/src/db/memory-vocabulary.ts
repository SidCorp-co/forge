export const memorySources = [
  'issue',
  'comment',
  'job',
  'note',
  'knowledge',
  'decision',
  'policy',
] as const;
export type MemorySource = (typeof memorySources)[number];
