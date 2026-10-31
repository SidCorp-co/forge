// The permission kernel's ports, filled at boot from the modules above it (`permissions/ports.ts`):
// where a project sits (projects), which accounts are agents (auth), and a project's gate profile
// (project-config), which says what its master holds beyond its role (`permissions/master-acts.ts`).

import { agentAccountsAmong } from './auth/index.js';
import { providePermissionsPorts } from './permissions/index.js';
import { readGateProfile } from './project-config/index.js';
import { findProjectOrgIds, projectOrgIdSql } from './projects/index.js';

export function providePermissionPorts(): void {
  providePermissionsPorts({
    projectOrgIdSql,
    projectOrgIds: findProjectOrgIds,
    agentAccountsAmong,
    gateProfileOf: readGateProfile,
  });
}
