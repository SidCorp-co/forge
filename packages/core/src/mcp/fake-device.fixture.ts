/**
 * The `Device` principal every MCP tool suite needs to call a handler.
 *
 * Thirty suites each carried their own byte-identical literal, so a new
 * `devices` column meant thirty edits and pushed two files past their frozen
 * size budget. Excluded from the build by `tsconfig.build.json`.
 */

import type { Device } from '../auth/deviceToken.js';

// cm:guard return a FRESH object per call. A shared instance is a mutable principal handed to every test in the file, so one handler that writes to it silently changes the identity the next case authenticates with.
export function makeFakeDevice(id: string, ownerId: string, name = 'fake'): Device {
  return {
    id,
    ownerId,
    name,
    platform: 'linux',
    agentVersion: null,
    machineId: null,
    gitCredentialRef: null,
    maxConcurrent: 1,
    tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
    tokenPrefix: 'fake0001',
    disabledAt: null,
    status: 'online',
    lastSeenAt: null,
    pairedAt: new Date('2026-01-01T00:00:00Z'),
    capabilities: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}
