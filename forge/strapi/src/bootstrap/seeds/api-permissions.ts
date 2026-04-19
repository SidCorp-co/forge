/**
 * API permissions seed for the Authenticated and Public roles.
 * Grants CRUD on all Forge content types to authenticated users,
 * and read-only access to skills for the Public role (used by pull scripts).
 *
 * When adding a new controller action:
 * 1. Create the route in routes/
 * 2. Create the handler in controllers/
 * 3. Add the action here
 */

/** Public role permissions — read-only access to non-sensitive endpoints. */
export const publicPermissions = [
  { controller: 'skill', actions: ['find', 'findOne', 'pushAntigravity', 'pushClaude'] },
  { controller: 'claude-proxy', actions: ['run', 'status', 'resume'] },
  { controller: 'app-release', actions: ['check', 'download', 'latest'] },
];

/** Plugin permissions for the Authenticated role (e.g. file uploads). */
export const pluginPermissions = [
  'plugin::upload.content-api.upload',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
  'plugin::upload.content-api.destroy',
  'plugin::users-permissions.user.find',
  'plugin::users-permissions.user.findOne',
];

export const apiPermissions = [
  { controller: 'project', actions: ['find', 'findOne', 'create', 'update', 'delete', 'health'] },
  { controller: 'issue', actions: ['find', 'findOne', 'create', 'update', 'delete', 'backfillSessionContext'] },
  { controller: 'task', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'comment', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'chat-session', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'chat', actions: ['send'] },
  { controller: 'knowledge-edge', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'agent', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'agent-definition', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'notification', actions: ['find', 'findOne', 'update', 'delete', 'markAllRead', 'unreadCount'] },
  { controller: 'skill', actions: ['find', 'findOne', 'create', 'update', 'delete', 'pushAntigravity', 'pushClaude'] },
  { controller: 'device', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'app-config', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'domain-template', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
  { controller: 'audit-log', actions: ['find', 'findOne'] },
  { controller: 'chat-log', actions: ['find', 'findOne', 'update', 'delete', 'flagged'] },
  { controller: 'eval-run', actions: ['find', 'findOne', 'create'] },
  { controller: 'user-preference', actions: ['find', 'findOne', 'create', 'update'] },
  { controller: 'antigravity', actions: ['listProjects', 'createProject', 'deleteProject', 'testConnection', 'syncSkills', 'initProject', 'initStatus'] },
  { controller: 'claude-proxy', actions: ['run', 'status', 'resume'] },
  { controller: 'agent-session', actions: ['find', 'findOne', 'update', 'delete'] },
  { controller: 'app-release', actions: ['find', 'findOne', 'create', 'update', 'delete', 'check', 'download', 'latest'] },
  { controller: 'memory', actions: ['list', 'remove', 'search', 'dream'] },
  { controller: 'skill-eval', actions: ['find', 'findOne', 'scorecard'] },
  { controller: 'schedule', actions: ['find', 'findOne', 'create', 'update', 'delete', 'run'] },
  { controller: 'heartbeat', actions: ['status', 'tick', 'history'] },
  { controller: 'retrieval-analytic', actions: ['find', 'findOne', 'create'] },
  { controller: 'cloudflare-account', actions: ['find', 'findOne', 'create', 'update', 'delete'] },
];

export async function seedApiPermissions(strapi) {
  const authenticatedRole = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'authenticated' } });

  if (!authenticatedRole) {
    strapi.log.warn('Authenticated role not found, skipping permission seed');
    return;
  }

  let seeded = 0;

  for (const { controller, actions } of apiPermissions) {
    for (const action of actions) {
      const actionId = `api::${controller}.${controller}.${action}`;

      const existing = await strapi.db
        .query('plugin::users-permissions.permission')
        .findOne({
          where: {
            action: actionId,
            role: authenticatedRole.id,
          },
        });

      if (!existing) {
        await strapi.db.query('plugin::users-permissions.permission').create({
          data: {
            action: actionId,
            role: authenticatedRole.id,
            enabled: true,
          },
        });
        seeded++;
      }
    }
  }

  // Seed plugin permissions (uploads, etc.)
  for (const action of pluginPermissions) {
    const existing = await strapi.db
      .query('plugin::users-permissions.permission')
      .findOne({
        where: {
          action,
          role: authenticatedRole.id,
        },
      });

    if (!existing) {
      await strapi.db.query('plugin::users-permissions.permission').create({
        data: {
          action,
          role: authenticatedRole.id,
          enabled: true,
        },
      });
      seeded++;
    }
  }

  // Seed Public role permissions (e.g. skills read-only for pull scripts)
  const publicRole = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (publicRole) {
    for (const { controller, actions } of publicPermissions) {
      for (const action of actions) {
        const actionId = `api::${controller}.${controller}.${action}`;
        const existing = await strapi.db
          .query('plugin::users-permissions.permission')
          .findOne({ where: { action: actionId, role: publicRole.id } });

        if (!existing) {
          await strapi.db.query('plugin::users-permissions.permission').create({
            data: { action: actionId, role: publicRole.id, enabled: true },
          });
          seeded++;
        }
      }
    }
  }

  if (seeded > 0) {
    strapi.log.info(`Seeded ${seeded} API permissions for Authenticated/Public roles`);
  }
}
