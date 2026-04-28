// Row types derived from Drizzle `$inferSelect` on the canonical DB schema.
// These are the shapes clients receive from `packages/core` REST responses.
//
// Using `$inferSelect` directly (rather than `InferSelectModel<typeof T>`)
// sidesteps cross-package variance on drizzle-orm's protected `Column.config`
// field, which surfaces as a TS2344 constraint violation when the consumer
// resolves a different drizzle-orm copy than `@forge/core`.

import type { schema } from '@forge/core/public';

export type User = Pick<
  typeof schema.users.$inferSelect,
  'id' | 'email' | 'emailVerifiedAt' | 'isCeo' | 'createdAt'
>;

export type Project = typeof schema.projects.$inferSelect;

export type ProjectMember = typeof schema.projectMembers.$inferSelect;

export type Label = typeof schema.labels.$inferSelect;

// Core serializes issues with a `displayId: "ISS-N"` added on top of the
// stored row (see `packages/core/src/issues/routes.ts:serializeIssue`).
export type Issue = typeof schema.issues.$inferSelect & {
  displayId: string;
};

export type Comment = typeof schema.comments.$inferSelect;

export type Job = typeof schema.jobs.$inferSelect;

export type JobEvent = typeof schema.jobEvents.$inferSelect;

export type Device = typeof schema.devices.$inferSelect;

export type ActivityLog = typeof schema.activityLog.$inferSelect;
