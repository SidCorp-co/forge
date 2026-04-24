import type { ActivityLog, Device, Project, User } from '@forge/contracts';

export type AdminUserRow = User;

export interface AdminProjectRow extends Project {
  ownerEmail: string | null;
  memberCount: number;
}

export type AdminDeviceRow = Device;

export type AdminAuditRow = ActivityLog;

export interface AdminWhoami {
  isAdmin: boolean;
  email: string;
}
