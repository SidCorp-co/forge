import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  activityLog,
  actorTypes,
  comments,
  devicePlatforms,
  deviceStatuses,
  devices,
  emailVerificationTokens,
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  jobEventKinds,
  jobEvents,
  jobStatuses,
  jobTypes,
  jobs,
  labels,
  modelTiers,
  pairingCodes,
  projectInvitations,
  projectIssCounters,
  projectMemberRoles,
  projectMembers,
  projects,
  projectsRelations,
  refreshTokens,
  users,
} from './schema.js';

type AnyTable =
  | typeof users
  | typeof emailVerificationTokens
  | typeof projects
  | typeof projectMembers
  | typeof refreshTokens
  | typeof devices
  | typeof pairingCodes
  | typeof jobs
  | typeof jobEvents
  | typeof issues
  | typeof comments
  | typeof labels
  | typeof issueLabels
  | typeof activityLog
  | typeof projectIssCounters
  | typeof projectInvitations;

function columnByName(table: AnyTable, name: string) {
  const cfg = getTableConfig(table);
  const col = cfg.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column ${name} not found`);
  return col;
}

function withTimezone(col: unknown): boolean | undefined {
  return (col as { config?: { withTimezone?: boolean } }).config?.withTimezone;
}

describe('db/schema — users', () => {
  it('has the documented columns', () => {
    const names = getTableConfig(users).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['created_at', 'email', 'email_verified_at', 'id', 'is_ceo', 'password_hash'].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(users, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('email is notNull and unique', () => {
    const email = columnByName(users, 'email');
    expect(email.notNull).toBe(true);
    expect(email.isUnique).toBe(true);
  });

  it('password_hash is nullable (OAuth-only users have no local password)', () => {
    // Made nullable in 0037 so OAuth-only users can be created without a
    // local password. The /auth/local handler refuses login for null hashes.
    expect(columnByName(users, 'password_hash').notNull).toBe(false);
  });

  it('email_verified_at is nullable timestamptz with no default', () => {
    const c = columnByName(users, 'email_verified_at');
    expect(c.notNull).toBe(false);
    expect(c.hasDefault).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(users, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });
});

describe('db/schema — email_verification_tokens', () => {
  it('has the four documented columns', () => {
    const names = getTableConfig(emailVerificationTokens).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['created_at', 'expires_at', 'token', 'user_id'].sort());
  });

  it('token is the primary key', () => {
    expect(columnByName(emailVerificationTokens, 'token').primary).toBe(true);
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(emailVerificationTokens);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('has an index on user_id', () => {
    const cfg = getTableConfig(emailVerificationTokens);
    expect(cfg.indexes.some((i) => i.config.name === 'email_verification_tokens_user_id_idx')).toBe(
      true,
    );
  });

  it('expires_at and created_at are timestamptz', () => {
    for (const name of ['expires_at', 'created_at']) {
      const c = columnByName(emailVerificationTokens, name);
      expect(c.notNull).toBe(true);
      expect(withTimezone(c)).toBe(true);
    }
  });
});

describe('db/schema — projects', () => {
  it('has the documented columns', () => {
    const names = getTableConfig(projects).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'agent_config',
        'api_key',
        'base_branch',
        'created_at',
        'default_device_id',
        'description',
        'id',
        'name',
        'owner_id',
        'production_branch',
        'repo_path',
        'slug',
        'webhook_secret',
      ].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(projects, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('slug is notNull and unique', () => {
    const slug = columnByName(projects, 'slug');
    expect(slug.notNull).toBe(true);
    expect(slug.isUnique).toBe(true);
  });

  it('name is notNull', () => {
    expect(columnByName(projects, 'name').notNull).toBe(true);
  });

  it('agent_config is nullable jsonb', () => {
    const c = columnByName(projects, 'agent_config');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgJsonb');
  });

  it('webhook_secret is nullable text', () => {
    const c = columnByName(projects, 'webhook_secret');
    expect(c.notNull).toBe(false);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(projects, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('owner_id references users.id with onDelete restrict', () => {
    const cfg = getTableConfig(projects);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'owner_id');
    if (!fk) throw new Error('expected owner_id FK');
    const ref = fk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('default_device_id references devices.id with onDelete set null', () => {
    const cfg = getTableConfig(projects);
    const fk = cfg.foreignKeys.find(
      (f) => f.reference().columns[0]?.name === 'default_device_id',
    );
    if (!fk) throw new Error('expected default_device_id FK');
    const ref = fk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('set null');
  });

  it('description, repo_path, base_branch, production_branch are nullable text', () => {
    for (const name of ['description', 'repo_path', 'base_branch', 'production_branch']) {
      const c = columnByName(projects, name);
      expect(c.notNull).toBe(false);
      expect(c.columnType).toBe('PgText');
    }
  });

  it('has a named index on default_device_id', () => {
    const cfg = getTableConfig(projects);
    expect(cfg.indexes.some((i) => i.config.name === 'projects_default_device_id_idx')).toBe(true);
  });

  it('has a named index on owner_id', () => {
    const cfg = getTableConfig(projects);
    expect(cfg.indexes.some((i) => i.config.name === 'projects_owner_id_idx')).toBe(true);
  });

  it('projectsRelations targets the projects table', () => {
    expect(projectsRelations.table).toBe(projects);
  });
});

describe('db/schema — project_members', () => {
  it('has the four documented columns', () => {
    const names = getTableConfig(projectMembers).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['created_at', 'project_id', 'role', 'user_id'].sort());
  });

  it('has composite primary key over [user_id, project_id]', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.primaryKeys).toHaveLength(1);
    const pk = cfg.primaryKeys[0];
    if (!pk) throw new Error('expected composite PK');
    const pkCols = pk.columns.map((c) => c.name);
    expect(pkCols).toEqual(['user_id', 'project_id']);
  });

  it('user_id FK cascades, project_id FK cascades', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) {
      expect(fk.onDelete).toBe('cascade');
    }
  });

  it('role defaults to member and enum matches projectMemberRoles', () => {
    const role = columnByName(projectMembers, 'role');
    expect(role.notNull).toBe(true);
    expect(role.hasDefault).toBe(true);
    expect(role.default).toBe('member');
    expect(role.enumValues).toEqual([...projectMemberRoles]);
  });

  it('projectMemberRoles exports the expected values', () => {
    expect(projectMemberRoles).toEqual(['owner', 'admin', 'member']);
  });

  it('has a named index on project_id', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.indexes.some((i) => i.config.name === 'project_members_project_id_idx')).toBe(true);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(projectMembers, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });
});

describe('db/schema — refresh_tokens', () => {
  it('has the seven documented columns', () => {
    const names = getTableConfig(refreshTokens).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'token_hash', 'token_prefix', 'used_at', 'user_id'].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(refreshTokens, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(refreshTokens);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('token_prefix and token_hash are notNull text', () => {
    for (const name of ['token_prefix', 'token_hash']) {
      expect(columnByName(refreshTokens, name).notNull).toBe(true);
    }
  });

  it('expires_at is notNull timestamptz', () => {
    const c = columnByName(refreshTokens, 'expires_at');
    expect(c.notNull).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('used_at is nullable timestamptz', () => {
    const c = columnByName(refreshTokens, 'used_at');
    expect(c.notNull).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('has composite index on (user_id, used_at) and index on token_prefix', () => {
    const cfg = getTableConfig(refreshTokens);
    expect(cfg.indexes.some((i) => i.config.name === 'refresh_tokens_user_id_used_at_idx')).toBe(
      true,
    );
    expect(cfg.indexes.some((i) => i.config.name === 'refresh_tokens_token_prefix_idx')).toBe(true);
  });
});

describe('db/schema — devices', () => {
  it('exports the platform and status enum values', () => {
    expect(devicePlatforms).toEqual(['macos', 'linux', 'windows']);
    expect(deviceStatuses).toEqual(['online', 'offline', 'revoked']);
  });

  it('has the twelve documented columns', () => {
    const names = getTableConfig(devices).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'agent_version',
        'capabilities',
        'created_at',
        'id',
        'last_seen_at',
        'name',
        'owner_id',
        'paired_at',
        'platform',
        'status',
        'token_hash',
        'token_prefix',
      ].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(devices, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('owner_id references users.id with onDelete restrict', () => {
    const cfg = getTableConfig(devices);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('owner_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('token_prefix is notNull varchar(8)', () => {
    const c = columnByName(devices, 'token_prefix');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgVarchar');
    expect((c as unknown as { length?: number }).length).toBe(8);
  });

  it('status defaults to offline and enum matches deviceStatuses', () => {
    const s = columnByName(devices, 'status');
    expect(s.notNull).toBe(true);
    expect(s.hasDefault).toBe(true);
    expect(s.default).toBe('offline');
    expect(s.enumValues).toEqual([...deviceStatuses]);
  });

  it('platform enum matches devicePlatforms', () => {
    const p = columnByName(devices, 'platform');
    expect(p.notNull).toBe(true);
    expect(p.enumValues).toEqual([...devicePlatforms]);
  });

  it('last_seen_at is nullable timestamptz', () => {
    const c = columnByName(devices, 'last_seen_at');
    expect(c.notNull).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('paired_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(devices, 'paired_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('capabilities is nullable jsonb', () => {
    const c = columnByName(devices, 'capabilities');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgJsonb');
  });

  it('has named indexes on owner_id and token_prefix', () => {
    const cfg = getTableConfig(devices);
    expect(cfg.indexes.some((i) => i.config.name === 'devices_owner_id_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'devices_token_prefix_idx')).toBe(true);
  });
});

describe('db/schema — pairing_codes', () => {
  it('has the six documented columns', () => {
    const names = getTableConfig(pairingCodes).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['code', 'created_at', 'expires_at', 'project_id', 'used_at', 'user_id'].sort(),
    );
  });

  it('code is the primary key', () => {
    expect(columnByName(pairingCodes, 'code').primary).toBe(true);
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(pairingCodes);
    const userFk = cfg.foreignKeys.find((fk) => fk.reference().columns[0]?.name === 'user_id');
    if (!userFk) throw new Error('expected user_id FK');
    const ref = userFk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(userFk.onDelete).toBe('cascade');
  });

  it('project_id is nullable and references projects.id with onDelete cascade', () => {
    const cfg = getTableConfig(pairingCodes);
    const pid = columnByName(pairingCodes, 'project_id');
    expect(pid.notNull).toBe(false);
    const projFk = cfg.foreignKeys.find((fk) => fk.reference().columns[0]?.name === 'project_id');
    if (!projFk) throw new Error('expected project_id FK');
    const ref = projFk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(projFk.onDelete).toBe('cascade');
  });

  it('expires_at is notNull timestamptz, used_at is nullable', () => {
    const exp = columnByName(pairingCodes, 'expires_at');
    expect(exp.notNull).toBe(true);
    expect(withTimezone(exp)).toBe(true);
    const used = columnByName(pairingCodes, 'used_at');
    expect(used.notNull).toBe(false);
    expect(withTimezone(used)).toBe(true);
  });

  it('has named indexes on user_id, project_id, and expires_at', () => {
    const cfg = getTableConfig(pairingCodes);
    expect(cfg.indexes.some((i) => i.config.name === 'pairing_codes_user_id_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'pairing_codes_project_id_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'pairing_codes_expires_at_idx')).toBe(true);
  });
});

describe('db/schema — jobs', () => {
  it('exports the status, type, and model tier enum values', () => {
    expect(jobStatuses).toEqual(['queued', 'dispatched', 'running', 'done', 'failed', 'cancelled']);
    expect(jobTypes).toEqual([
      'triage',
      'clarify',
      'plan',
      'code',
      'review',
      'test',
      'release',
      'fix',
      'custom',
    ]);
    expect(modelTiers).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('has the documented columns', () => {
    const names = getTableConfig(jobs).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'attempts',
        'cancellation_requested',
        'classifier_version',
        'created_at',
        'created_by',
        'device_id',
        'dispatched_at',
        'error',
        'exit_code',
        'failure_kind',
        'failure_meta',
        'failure_reason',
        'finished_at',
        'id',
        'issue_id',
        'max_attempts',
        'model_tier',
        'payload',
        'project_id',
        'queued_at',
        'retry_of',
        'runner_id',
        'started_at',
        'status',
        'type',
      ].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(jobs, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('project_id cascades, device_id/issue_id/retry_of/runner_id set null, created_by restricts', () => {
    const cfg = getTableConfig(jobs);
    expect(cfg.foreignKeys).toHaveLength(6);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('device_id')?.onDelete).toBe('set null');
    expect(byCol.get('created_by')?.onDelete).toBe('restrict');
    expect(byCol.get('issue_id')?.onDelete).toBe('set null');
    expect(byCol.get('retry_of')?.onDelete).toBe('set null');
    expect(byCol.get('runner_id')?.onDelete).toBe('set null');
  });

  it('issue_id is nullable uuid referencing issues.id', () => {
    const c = columnByName(jobs, 'issue_id');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgUUID');
  });

  it('status defaults to queued and enum matches jobStatuses', () => {
    const s = columnByName(jobs, 'status');
    expect(s.notNull).toBe(true);
    expect(s.hasDefault).toBe(true);
    expect(s.default).toBe('queued');
    expect(s.enumValues).toEqual([...jobStatuses]);
  });

  it('type enum matches jobTypes', () => {
    const t = columnByName(jobs, 'type');
    expect(t.notNull).toBe(true);
    expect(t.enumValues).toEqual([...jobTypes]);
  });

  it('model_tier is nullable with modelTiers enum', () => {
    const m = columnByName(jobs, 'model_tier');
    expect(m.notNull).toBe(false);
    expect(m.enumValues).toEqual([...modelTiers]);
  });

  it('payload is notNull jsonb with default', () => {
    const c = columnByName(jobs, 'payload');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgJsonb');
    expect(c.hasDefault).toBe(true);
  });

  it('exit_code is nullable integer', () => {
    const c = columnByName(jobs, 'exit_code');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgInteger');
  });

  it('lifecycle timestamps: queued_at notNull+default, others nullable', () => {
    const q = columnByName(jobs, 'queued_at');
    expect(q.notNull).toBe(true);
    expect(q.hasDefault).toBe(true);
    expect(withTimezone(q)).toBe(true);
    for (const name of ['dispatched_at', 'started_at', 'finished_at']) {
      const c = columnByName(jobs, name);
      expect(c.notNull).toBe(false);
      expect(withTimezone(c)).toBe(true);
    }
  });

  it('has named indexes on project_id, device_id, issue_id, status', () => {
    const cfg = getTableConfig(jobs);
    for (const name of [
      'jobs_project_id_idx',
      'jobs_device_id_idx',
      'jobs_issue_id_idx',
      'jobs_status_idx',
    ]) {
      expect(cfg.indexes.some((i) => i.config.name === name)).toBe(true);
    }
  });
});

describe('db/schema — job_events', () => {
  it('exports the kind enum values', () => {
    expect(jobEventKinds).toEqual([
      'stdout',
      'stderr',
      'tool_call',
      'tool_result',
      'progress',
      'result',
    ]);
  });

  it('has the six documented columns', () => {
    const names = getTableConfig(jobEvents).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['data', 'id', 'job_id', 'kind', 'seq', 'ts'].sort());
  });

  it('job_id references jobs.id with onDelete cascade', () => {
    const cfg = getTableConfig(jobEvents);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('job_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('kind enum matches jobEventKinds', () => {
    const k = columnByName(jobEvents, 'kind');
    expect(k.notNull).toBe(true);
    expect(k.enumValues).toEqual([...jobEventKinds]);
  });

  it('seq is notNull integer', () => {
    const s = columnByName(jobEvents, 'seq');
    expect(s.notNull).toBe(true);
    expect(s.columnType).toBe('PgInteger');
  });

  it('ts is notNull timestamptz with defaultNow', () => {
    const c = columnByName(jobEvents, 'ts');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('data is notNull jsonb with default', () => {
    const c = columnByName(jobEvents, 'data');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgJsonb');
    expect(c.hasDefault).toBe(true);
  });

  it('has unique composite index on (job_id, seq) for monotonic ordering', () => {
    const cfg = getTableConfig(jobEvents);
    const idx = cfg.indexes.find((i) => i.config.name === 'job_events_job_id_seq_idx');
    if (!idx) throw new Error('expected job_events_job_id_seq_idx');
    expect(idx.config.unique).toBe(true);
    expect(idx.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['job_id', 'seq']);
  });

  it('has index on ts for retention sweeper', () => {
    const cfg = getTableConfig(jobEvents);
    expect(cfg.indexes.some((i) => i.config.name === 'job_events_ts_idx')).toBe(true);
  });
});

describe('db/schema — issues', () => {
  it('exports the status and priority enum values', () => {
    expect(issueStatuses).toEqual([
      'open',
      'confirmed',
      'waiting',
      'approved',
      'in_progress',
      'developed',
      'deploying',
      'testing',
      'tested',
      'pass',
      'staging',
      'released',
      'closed',
      'reopen',
      'on_hold',
      'needs_info',
      'pipeline_failed',
    ]);
    expect(issuePriorities).toEqual(['critical', 'high', 'medium', 'low', 'none']);
  });

  it('has the documented columns', () => {
    const names = getTableConfig(issues).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'acceptance_criteria',
        'assignee_id',
        'category',
        'created_at',
        'created_by_id',
        'description',
        'external_id',
        'id',
        'iss_seq',
        'last_recovery_at',
        'parent_issue_id',
        'plan',
        'priority',
        'project_id',
        'recovery_attempts',
        'recovery_window_started_at',
        'reopen_count',
        'session_context',
        'source',
        'status',
        'suggested_solution',
        'title',
        'updated_at',
      ].sort(),
    );
  });

  it('reopen_count is notNull integer with default 0 (F4 reopen-cap tracking)', () => {
    const c = columnByName(issues, 'reopen_count');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgInteger');
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe(0);
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(issues, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('iss_seq is notNull integer with default 0 (trigger overwrites)', () => {
    const c = columnByName(issues, 'iss_seq');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgInteger');
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe(0);
  });

  it('status defaults to open and enum matches issueStatuses', () => {
    const s = columnByName(issues, 'status');
    expect(s.notNull).toBe(true);
    expect(s.default).toBe('open');
    expect(s.enumValues).toEqual([...issueStatuses]);
  });

  it('priority defaults to medium and enum matches issuePriorities', () => {
    const p = columnByName(issues, 'priority');
    expect(p.notNull).toBe(true);
    expect(p.default).toBe('medium');
    expect(p.enumValues).toEqual([...issuePriorities]);
  });

  it('description, category, assignee_id, parent_issue_id are nullable', () => {
    for (const name of ['description', 'category', 'assignee_id', 'parent_issue_id']) {
      expect(columnByName(issues, name).notNull).toBe(false);
    }
  });

  it('FKs: project cascade, assignee set null, created_by restrict, parent self set null', () => {
    const cfg = getTableConfig(issues);
    expect(cfg.foreignKeys).toHaveLength(4);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('assignee_id')?.onDelete).toBe('set null');
    expect(byCol.get('created_by_id')?.onDelete).toBe('restrict');
    expect(byCol.get('parent_issue_id')?.onDelete).toBe('set null');
    expect(byCol.get('parent_issue_id')?.reference().foreignTable).toBe(issues);
  });

  it('has unique index on (project_id, iss_seq) and named indexes', () => {
    const cfg = getTableConfig(issues);
    const uq = cfg.indexes.find((i) => i.config.name === 'issues_project_iss_seq_uq');
    if (!uq) throw new Error('expected issues_project_iss_seq_uq');
    expect(uq.config.unique).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'issues_project_status_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'issues_assignee_idx')).toBe(true);
  });
});

describe('db/schema — project_iss_counters', () => {
  it('has project_id PK and next_seq integer default 1', () => {
    const names = getTableConfig(projectIssCounters).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['next_seq', 'project_id'].sort());
    expect(columnByName(projectIssCounters, 'project_id').primary).toBe(true);
    const seq = columnByName(projectIssCounters, 'next_seq');
    expect(seq.notNull).toBe(true);
    expect(seq.default).toBe(1);
  });

  it('project_id cascades on project delete', () => {
    const cfg = getTableConfig(projectIssCounters);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });
});

describe('db/schema — comments', () => {
  it('has the seven documented columns', () => {
    const names = getTableConfig(comments).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['author_id', 'body', 'created_at', 'id', 'issue_id', 'parent_id', 'updated_at'].sort(),
    );
  });

  it('issue_id cascades, author_id restricts, parent_id cascades', () => {
    const cfg = getTableConfig(comments);
    expect(cfg.foreignKeys).toHaveLength(3);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('issue_id')?.onDelete).toBe('cascade');
    expect(byCol.get('author_id')?.onDelete).toBe('restrict');
    expect(byCol.get('parent_id')?.onDelete).toBe('cascade');
  });

  it('body is notNull text', () => {
    expect(columnByName(comments, 'body').notNull).toBe(true);
  });

  it('parent_id is nullable uuid', () => {
    const col = columnByName(comments, 'parent_id');
    expect(col.notNull).toBe(false);
    expect(col.dataType).toBe('string');
  });

  it('has indexes on issue_id and parent_id', () => {
    const cfg = getTableConfig(comments);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain('comments_issue_id_idx');
    expect(names).toContain('comments_parent_id_idx');
  });
});

describe('db/schema — labels', () => {
  it('has the five documented columns', () => {
    const names = getTableConfig(labels).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['color', 'created_at', 'id', 'name', 'project_id'].sort());
  });

  it('project_id cascades', () => {
    const cfg = getTableConfig(labels);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('has unique composite index on (project_id, name)', () => {
    const cfg = getTableConfig(labels);
    const idx = cfg.indexes.find((i) => i.config.name === 'labels_project_id_name_uq');
    if (!idx) throw new Error('expected labels_project_id_name_uq');
    expect(idx.config.unique).toBe(true);
  });
});

describe('db/schema — issue_labels', () => {
  it('has composite primary key over (issue_id, label_id)', () => {
    const cfg = getTableConfig(issueLabels);
    expect(cfg.primaryKeys).toHaveLength(1);
    const pk = cfg.primaryKeys[0];
    if (!pk) throw new Error('expected composite PK');
    expect(pk.columns.map((c) => c.name)).toEqual(['issue_id', 'label_id']);
  });

  it('both FKs cascade', () => {
    const cfg = getTableConfig(issueLabels);
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) expect(fk.onDelete).toBe('cascade');
  });
});

describe('db/schema — project_invitations', () => {
  it('has the eight documented columns', () => {
    const names = getTableConfig(projectInvitations).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'accepted_at',
        'created_at',
        'email',
        'expires_at',
        'inviter_id',
        'project_id',
        'role',
        'token',
      ].sort(),
    );
  });

  it('token is the primary key', () => {
    expect(columnByName(projectInvitations, 'token').primary).toBe(true);
  });

  it('FKs: project cascades, inviter cascades', () => {
    const cfg = getTableConfig(projectInvitations);
    expect(cfg.foreignKeys).toHaveLength(2);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('inviter_id')?.onDelete).toBe('cascade');
  });

  it('role enum matches projectMemberRoles', () => {
    const r = columnByName(projectInvitations, 'role');
    expect(r.notNull).toBe(true);
    expect(r.enumValues).toEqual([...projectMemberRoles]);
  });

  it('expires_at notNull timestamptz, accepted_at nullable timestamptz', () => {
    const exp = columnByName(projectInvitations, 'expires_at');
    expect(exp.notNull).toBe(true);
    expect(withTimezone(exp)).toBe(true);
    const acc = columnByName(projectInvitations, 'accepted_at');
    expect(acc.notNull).toBe(false);
    expect(withTimezone(acc)).toBe(true);
  });

  it('has index on (project_id, email) and partial-unique on same with accepted_at IS NULL', () => {
    const cfg = getTableConfig(projectInvitations);
    expect(cfg.indexes.some((i) => i.config.name === 'project_invitations_project_email_idx')).toBe(
      true,
    );
    const uq = cfg.indexes.find(
      (i) => i.config.name === 'project_invitations_project_email_pending_uq',
    );
    if (!uq) throw new Error('expected partial-unique index');
    expect(uq.config.unique).toBe(true);
  });
});

describe('db/schema — activity_log', () => {
  it('exports the actor type enum', () => {
    expect(actorTypes).toEqual(['user', 'device']);
  });

  it('has the seven documented columns', () => {
    const names = getTableConfig(activityLog).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['action', 'actor_id', 'actor_type', 'created_at', 'id', 'issue_id', 'payload'].sort(),
    );
  });

  it('actor_id is notNull uuid with no FK (polymorphic to user/device)', () => {
    const cfg = getTableConfig(activityLog);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.reference().columns[0]?.name).toBe('issue_id');
    const c = columnByName(activityLog, 'actor_id');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgUUID');
  });

  it('actor_type enum matches actorTypes', () => {
    const t = columnByName(activityLog, 'actor_type');
    expect(t.enumValues).toEqual([...actorTypes]);
  });

  it('payload is notNull jsonb with default', () => {
    const c = columnByName(activityLog, 'payload');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgJsonb');
    expect(c.hasDefault).toBe(true);
  });

  it('has composite index on (issue_id, created_at)', () => {
    const cfg = getTableConfig(activityLog);
    expect(cfg.indexes.some((i) => i.config.name === 'activity_log_issue_created_idx')).toBe(true);
  });
});
