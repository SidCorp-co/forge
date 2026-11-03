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

// ---- a project's contracts, links, builder runs and interface, by the rules forge_ecosystem names ----

const CONTRACT = 'ecosystem/contract';
const LINKS = 'ecosystem/link-service.ts';
const OWN_AGENT =
  "the consuming project's own agent writes its record, decided on the input and the row (ECOSYSTEM_REFUSED)";
const COUNTERPARTY =
  'its members every version; an active member of an ecosystem the contract is published to, its approved ones';

export const CONTRACT_VERSIONS_READ = requiresByRule(
  `${CONTRACT}/party-read.ts:contractReader`,
  COUNTERPARTY,
);

export const CONTRACT_PUBLISH = requiresByRule(
  `${CONTRACT}/publish.ts:publishContractVersion`,
  'the provider writer rule of interface_write (contracts.write), on the project that publishes',
);

export const CONTRACT_DECIDE = requiresByRule(
  `${CONTRACT}/decide.ts:decideContractVersion`,
  'a holder of contracts.approve on the publishing project, person or agent',
);

export const CONTRACT_CONSUMED = requiresByRule(
  `${CONTRACT}/party-read.ts:consumedContract`,
  'a role on the consuming project, read only through a live consumption edge the provider publishes to',
);

export const LINK_READ = requiresByRule(
  'ecosystem/link-read.ts:readLinkAs',
  "the link's row decides: its provider or consumer side, or a member of its ecosystem",
);

export const LINK_CREATE = requiresByRule(`${LINKS}:createLink`, OWN_AGENT);
export const LINK_UPDATE = requiresByRule(`${LINKS}:updateLink`, OWN_AGENT);
export const LINK_RETIRE = requiresByRule(`${LINKS}:retireLink`, OWN_AGENT);
export const BUILDER_RUN_CREATE = requiresByRule(`${LINKS}:createBuilderRun`, OWN_AGENT);
export const BUILDER_RUN_UPDATE = requiresByRule(`${LINKS}:updateBuilderRun`, OWN_AGENT);

export const INTERFACE_WRITE = requiresByRule(
  'ecosystem/provider-writer-rules.ts:providerWriterRefusal',
  'a holder of contracts.write, and commitments.write to change windows already set (ECOSYSTEM_REFUSED)',
);

export const INTERFACE_ADOPT = requiresByRule(
  'ecosystem/adopt-service.ts:adoptVersion',
  'project.write on the consuming project, refused by name in the ecosystem envelope (ECOSYSTEM_REFUSED)',
);

export const API_PAGE_READ = requiresByRule(
  'ecosystem/api-page.ts:readApiPage',
  "the project's API page, read by its members and by its counterparties in a shared ecosystem",
);

export const CONTRACT_STANDING_READ = requiresByRule(
  'ecosystem/standing/routes.ts:assertStandingReader',
  'a role on the project, not a permission: an org admin with none is refused',
);
