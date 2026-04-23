import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { emailVerificationTokens, users } from './schema.js';

function columnByName(table: typeof users | typeof emailVerificationTokens, name: string) {
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
