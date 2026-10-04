type OutboxPermission = 'project.read' | 'outbox.replay';

/** Refuses an actor that does not hold `permission` on the project, by name; resolves otherwise. */
type OutboxGate = (
  userId: string | null | undefined,
  permission: OutboxPermission,
  projectId: string,
  act?: string,
) => Promise<void>;

let gate: OutboxGate | null = null;

/** The permissions kernel sits above the outbox, so the process entry hands its check over at boot. */
export function provideOutboxGate(check: OutboxGate): void {
  gate = check;
}

export function requireOutboxAccess(
  userId: string | null | undefined,
  permission: OutboxPermission,
  projectId: string,
  act?: string,
): Promise<void> {
  if (!gate) {
    throw new Error(
      'outbox: no permission gate was provided, so a project-scoped read or replay cannot be checked; the process entry calls provideOutboxGate before it serves',
    );
  }
  return gate(userId, permission, projectId, act);
}
