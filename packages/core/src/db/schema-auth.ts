import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const userKinds = ['human', 'agent'] as const;

export type UserKind = (typeof userKinds)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  kind: text('kind', { enum: userKinds }).notNull().default('human'),
  /**
   * The label a person reads, and NOTHING else (ISS-1003).
   *
   * Free text, accented, changeable, not unique — a person sets their own and
   * an org admin sets an agent's. An agent account is minted carrying its
   * handle here; a person's is null until they type one, which is what every
   * renderer's "or the email address" branch is for.
   */
  displayName: text('display_name'),
  /**
   * Nullable since 0037: OAuth-only users have no local password. `/auth/local`
   * rejects a null hash, so a password-less account cannot be brute-forced
   * through the email/password endpoint.
   */
  passwordHash: text('password_hash'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /**
   * Last `POST /api/auth/reauth`. Drives `requireFreshAuth()`; null for a user
   * who never re-authed, which reads as stale and forces a prompt (0065).
   */
  lastFreshAuthAt: timestamp('last_fresh_auth_at', { withTimezone: true }),
  /**
   * Set at logout, to the whole second (0399): a session JWT issued before it is refused, so a
   * logout ends every session token already handed out, not only the refresh tokens.
   */
  tokensValidAfter: timestamp('tokens_valid_after', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerAccountUq: uniqueIndex('oauth_accounts_provider_account_uniq').on(
      t.provider,
      t.providerAccountId,
    ),
    userIdIdx: index('oauth_accounts_user_id_idx').on(t.userId),
  }),
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('email_verification_tokens_user_id_idx').on(t.userId),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdUsedAtIdx: index('refresh_tokens_user_id_used_at_idx').on(t.userId, t.usedAt),
    tokenPrefixIdx: index('refresh_tokens_token_prefix_idx').on(t.tokenPrefix),
  }),
);
