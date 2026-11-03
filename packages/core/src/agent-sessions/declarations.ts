// What each agent-session route declares (REQ-12 BC-20, ISS-824). Most are decided by a rule on the
// session's row or the caller's kind (a paired device reaches only the session dispatched to it, a
// person's private chat only its owner or a holder of project.admin), named here, and checked in the
// handler as before; the two whose whole check is a permission on the session's project declare it
// resolved, and session-access.ts checks it with requireDeclaredHeld.

import { requiresByRule, requiresOnResolved } from '../permissions/index.js';

const ACCESS = 'agent-sessions/session-access.ts';
const THE_SESSION = "the session's project";

export const SESSION_READ = requiresOnResolved('project.read', THE_SESSION);
export const SESSION_WRITE = requiresOnResolved('project.write', THE_SESSION);

export const LIST_SCOPE = requiresByRule(
  `${ACCESS}:sessionListScope`,
  "project.read on the project projectId names, else the caller's visible projects; a person's private chat only to its owner or a holder of project.admin",
);

export const OWNER_OR_ADMIN = requiresByRule(
  `${ACCESS}:ensureSessionOwnerOrAdmin`,
  "project.write on the session's project, then its owner or a holder of project.admin (SESSION_OWNER_FORBIDDEN); a conversation turn's session its asker alone",
);

export const TURN_OWNER_OR_ADMIN = requiresByRule(
  `${ACCESS}:assertSessionOwnerOrAdmin`,
  "project.write on the session's project, then its owner or a holder of project.admin (SESSION_OWNER_FORBIDDEN)",
);

export const PATCH_OWNER_OR_ADMIN = requiresByRule(
  `${ACCESS}:assertSessionOwnerOrAdmin`,
  "a paired device only the session dispatched to it; a person project.write on the session's project, then its owner or a holder of project.admin",
);

export const CHAT_READ = requiresByRule(
  `${ACCESS}:assertAgentChatOwner`,
  "a paired device only the session dispatched to it; a person project.read on the session's project, and a person's private chat only its owner or a holder of project.admin (AGENT_CHAT_OWNER_FORBIDDEN)",
);

export const CHAT_WRITE = requiresByRule(
  `${ACCESS}:assertAgentChatOwner`,
  "a paired device only the session dispatched to it; a person project.write on the session's project, and a person's private chat only its owner or a holder of project.admin (AGENT_CHAT_OWNER_FORBIDDEN)",
);

export const DEVICE_OWN = requiresByRule(
  `${ACCESS}:assertDeviceOwnsSession`,
  'a paired device, on the session dispatched to it alone',
);

export const DEVICE_PLACED = requiresByRule(
  'agent-sessions/inbox-routes.ts:assertOwnsSession',
  'a paired device, on the session placed on it alone',
);

export const RUN_SESSION = requiresByRule(
  'agent-sessions/interactive-credential.ts:assertMayRunSession',
  'the project the body names, and whether this kind of caller may run a session there',
);
