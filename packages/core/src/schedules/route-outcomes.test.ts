import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEDULE_RUN_SKIP_REASONS } from '@forge/contracts/schedules';
import { describe, expect, it } from 'vitest';
import { sessionRoleRefusal } from '../agent-sessions/interactive-credential.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => readFileSync(join(here, f), 'utf8'))
  .join('\n');

describe('automation route: every fire outcome has a writer', () => {
  it.each(SCHEDULE_RUN_SKIP_REASONS)('a router settles a fire skipped with reason %s', (reason) => {
    const writers = routerSource.match(
      new RegExp(`reason: '${reason}'|skip\\('${reason}'\\)`, 'g'),
    );
    expect(
      writers?.length ?? 0,
      `no router in schedules/ settles a fire with reason ${reason}`,
    ).toBeGreaterThan(0);
  });
});

describe('automation route: the run-as identity is refused by name', () => {
  const projectId = '00000000-0000-4000-8000-000000000001';

  it('an owner with no role on the project is SESSION_NO_ROLE', () => {
    expect(sessionRoleRefusal({ projectId, role: null, grants: [] })?.code).toBe('SESSION_NO_ROLE');
  });

  it('a viewer owner, who lacks project.write, is PERMISSION_FORBIDDEN naming the permission', () => {
    const refusal = sessionRoleRefusal({ projectId, role: 'viewer', grants: [] });
    expect(refusal?.code).toBe('PERMISSION_FORBIDDEN');
    expect(refusal?.message).toContain('project.write');
  });

  it('a viewer whose membership grant names project.write runs: the gate is the permission, not the role', () => {
    expect(sessionRoleRefusal({ projectId, role: 'viewer', grants: ['project.write'] })).toBeNull();
  });

  it('a member runs', () => {
    expect(sessionRoleRefusal({ projectId, role: 'member', grants: [] })).toBeNull();
  });
});
