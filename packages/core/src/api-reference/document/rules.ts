/** Every way the reference can fall short of the routes, by the name a finding carries. */
export const RULES = [
  'unread-chain',
  'no-access',
  'unrepresentable',
  'unreadable-hook',
  'undeclared-input',
  'param-not-in-path',
  'no-response',
  'raw-json',
  'more-than-one-descriptor',
  'schema-name-clash',
  'operation-id-clash',
  'path-collision',
  'omitted',
  'undeclared-error',
  'typo-code',
  'dangling-ref',
] as const;

export type Rule = (typeof RULES)[number];
