import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  emailVerificationTokens,
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
  | typeof refreshTokens;

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
  it('has the five documented columns', () => {
    const names = getTableConfig(users).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['created_at', 'email', 'email_verified_at', 'id', 'password_hash'].sort(),
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

  it('password_hash is notNull', () => {
    expect(columnByName(users, 'password_hash').notNull).toBe(true);
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
  it('has the seven documented columns', () => {
    const names = getTableConfig(projects).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['agent_config', 'created_at', 'id', 'name', 'owner_id', 'slug', 'webhook_secret'].sort(),
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
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('owner_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
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
