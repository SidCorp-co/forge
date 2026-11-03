// What each `/api/integration-connections` route declares (REQ-12 BC-20, ISS-824). A connection is
// owned by a person, an organization or the instance, and who may read or change it follows its
// owner row, so the routes are declared by the rule that reads that row. None has a floor: the
// connection's not-found and the operator's named refusal answer first.

import { requiresByRule } from '../permissions/index.js';

const ROUTES = 'integration-door/connection-routes.ts';

export const CONNECTIONS_LISTED = requiresByRule(
  'integrations/store.ts:listConnectionsForPrincipalUser',
  "the caller's own connections, those of every organization they belong to, and the instance's",
);

export const CONNECTION_CREATE = requiresByRule(
  `${ROUTES}:assertMayOwnConnection`,
  "a personal connection is the caller's own; an organization's, named by orgId, takes org.admin there",
);

export const CONNECTION_READ = requiresByRule(
  `${ROUTES}:loadConnection`,
  "its owner, a member of its organization, or anyone for the instance's own (a connection not theirs is not found)",
);

export const CONNECTION_BIND = requiresByRule(
  `${ROUTES}:loadConnection`,
  'a reader of the connection, bound only into projects the caller administers (each refused by name)',
);

export const CONNECTION_MANAGE = requiresByRule(
  `${ROUTES}:loadConnection`,
  "its owner, org.admin on its organization, or a Forge operator for the instance's own (GITHUB_APP_OPERATOR_ONLY)",
);

export const GITHUB_CONNECT = requiresByRule(
  'integration-door/github-app-routes.ts:beginConnect',
  "org.admin on the organization the body names; making the instance's App, a Forge operator",
);

export const GITHUB_APP_COMPLETE = requiresByRule(
  'integration-door/github-app-routes.ts:assertGithubAppOperator',
  "a Forge operator alone completes the instance's GitHub App (GITHUB_APP_OPERATOR_ONLY)",
);
