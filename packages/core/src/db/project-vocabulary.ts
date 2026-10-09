export const projectKinds = ['standard', 'website'] as const;
export type ProjectKind = (typeof projectKinds)[number];

export const projectMemberRoles = ['admin', 'member', 'viewer'] as const;
export type ProjectMemberRole = (typeof projectMemberRoles)[number];
