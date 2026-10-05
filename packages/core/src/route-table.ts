import { enterHermeticEnv } from './api-contract/hermetic-env.js';

enterHermeticEnv();
const { app } = await import('./index.js');
const permissions = await import('./credentials/pat-permissions.js');
const { registrationServes } = await import('./middleware/pat-rest-surface.js');

const table = {
  routes: app.routes.map((r) => ({
    method: r.method,
    path: r.path,
    serves: registrationServes(r),
  })),
  resources: permissions.PAT_PERMISSION_RESOURCES,
  levels: permissions.PAT_PERMISSION_LEVELS,
  ungrantable: permissions.PAT_UNGRANTABLE,
};
process.stdout.write(JSON.stringify(table));
process.exit(0);
