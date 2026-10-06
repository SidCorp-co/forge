import { devices } from '../db/schema.js';

/** The row shape every device list answers with, owner-scoped and org-scoped
 *  alike: one screen reads both, so neither list owns it (ISS-1162). */
export const DEVICE_LIST_COLUMNS = {
  id: devices.id,
  name: devices.name,
  platform: devices.platform,
  agentVersion: devices.agentVersion,
  agentCommit: devices.agentCommit,
  status: devices.status,
  disabledAt: devices.disabledAt,
  lastSeenAt: devices.lastSeenAt,
  pairedAt: devices.pairedAt,
  capabilities: devices.capabilities,
  gateReport: devices.gateReport,
  binaryReport: devices.binaryReport,
  createdAt: devices.createdAt,
};
