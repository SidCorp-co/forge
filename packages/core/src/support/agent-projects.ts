// Who may name a channel agent's sibling projects (ISS-874). A binding's `agent.projects` lets the
// home project's bot read each named project's tracker, knowledge and code and file to its master,
// so naming one is an act on that project: each is a project of the home project's organization,
// never the home itself, and one the write adds is named by someone holding `project.admin` on it,
// the permission that writes that project's own bindings. A slug the binding already held is not
// asked for again, so the home's admin can edit the rest of the block; dropping one narrows the
// agent's reach and needs nothing.

import type { AgentProjectsGate } from '../integrations/rocketchat/index.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { orgSiblingProjects } from '../projects/index.js';

export const agentProjectsGate: AgentProjectsGate = {
  async refusals({ projectId, userId, named, held }) {
    const siblings = await orgSiblingProjects(projectId);
    const home = siblings.find((p) => p.id === projectId);
    const out: Awaited<ReturnType<AgentProjectsGate['refusals']>> = [];
    for (const [i, slug] of named.entries()) {
      const path = `/agent/projects/${i}`;
      const project = siblings.find((p) => p.slug === slug);
      if (!project || project.id === home?.id) {
        out.push({
          code: 'SUPPORT_AGENT_PROJECT_UNKNOWN',
          path,
          detail: project
            ? `${slug} is this binding's own project, which its agent always follows; name only the other projects it follows`
            : `${slug} is no project of this project's organization; name one of ${
                siblings
                  .filter((p) => p.id !== home?.id)
                  .map((p) => p.slug)
                  .join(', ') || 'none — the organization holds no other project'
              }`,
        });
        continue;
      }
      if (held.includes(slug)) continue;
      if (!(await can(actorFor(userId), 'project.admin', projectResource(project.id)))) {
        out.push({
          code: 'SUPPORT_AGENT_PROJECT_NOT_ADMIN',
          path,
          detail: `following ${slug} lets this binding's agent read its tracker and code and file to its master, so it is named by an admin of ${slug}, and you are not one; ask an admin of ${slug} to add it`,
        });
      }
    }
    return out;
  },
};
