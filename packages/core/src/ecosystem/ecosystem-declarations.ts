// What each `/api/ecosystems` route declares (REQ-12 BC-20, ISS-824). An ecosystem names no project
// in its path: it is reached by its steward organization or by projects invited to it or active in
// it, so each route is declared by the rule that reads that, the same rules forge_ecosystem's
// actions name. None has a floor.

import { requiresByRule, requiresSelf } from '../permissions/index.js';

const MEMBERSHIP = 'ecosystem/membership-service.ts';
const READER =
  "its steward organization, or a project of the caller's invited to it or active in it";

export const ECOSYSTEMS_MINE = requiresSelf(
  "the caller's own workspace: the ecosystems their organizations steward and their projects belong to or are invited to",
);

export const ECOSYSTEM_CREATE = requiresByRule(
  'ecosystem/ecosystem-service.ts:createEcosystem',
  'org.admin on the steward organization the document names',
);

export const ECOSYSTEM_WRITE = requiresByRule(
  'ecosystem/ecosystem-service.ts:writeEcosystem',
  "org.admin on the ecosystem's steward organization, which a write never changes",
);

export const ECOSYSTEM_READ = requiresByRule(`${MEMBERSHIP}:readableEcosystem`, READER);

export const ECOSYSTEM_MEMBERS = requiresByRule(
  `${MEMBERSHIP}:visibleMemberships`,
  `${READER}; a member sees its own memberships and the active ones it can see`,
);

export const ECOSYSTEM_INVITE = requiresByRule(
  `${MEMBERSHIP}:invite`,
  "org.admin on the ecosystem's steward organization, inviting a project by name",
);

export const ECOSYSTEM_REGISTER = requiresByRule(
  'ecosystem/channel-register.ts:readRegister',
  `${READER}; only the documents one of the caller's projects sent or received`,
);

export const ECOSYSTEM_SUPERSEDE = requiresByRule(
  'ecosystem/builder-supersede.ts:supersedeBuilderRun',
  "the project's own agent, or an org admin of the steward or of the project's org",
);
