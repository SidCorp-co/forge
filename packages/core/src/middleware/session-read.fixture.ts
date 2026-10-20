/** A mocked `db.select` whose session-door read answers a person; every other read takes the test's chain. */
export const SESSION_ROW = {
  email: 'person@example.test',
  emailVerifiedAt: new Date(0),
  kind: 'human' as const,
};

export function sessionReadOr<T>(chain: () => T) {
  return (cols?: Record<string, unknown>) =>
    cols && Object.keys(cols).sort().join() === 'email,emailVerifiedAt,kind'
      ? { from: () => ({ where: () => ({ limit: async () => [SESSION_ROW] }) }) }
      : chain();
}
