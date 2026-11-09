// The guide a product owner, BA or project manager reads first, person or agent, from an MCP client
// or the web (ISS-1183, REQ-78 BC-8 and BC-9): what the Product side works in, the reads that say how
// a project stands, and why an issue is Delivery's, read for progress and never the place to start.

import type { CoreGuide } from './types.js';

export const PRODUCT_ROLE_GUIDE: CoreGuide = {
  slug: 'product-role',
  audience: 'agent',
  title: "Working a project's Product: owner, BA, project manager",
  summary:
    'For a product owner, BA or project manager, person or agent, on MCP or the web: what the Product side works in, the reads that say how a project stands and what waits on you, and why issues are Delivery’s to file and build.',
  version: 1,
  body: `## Working a project's Product

Forge runs one loop: **Product → Delivery → Release → Audit → Product**. The Product leads:
requirements, workflow designs and feedback say what is worth building, and Delivery builds to them.
You work the Product. The project's master and its runs work Delivery, from a checkout.

### What you work in
| You want | On MCP (\`forge_call\`) | Guide |
|---|---|---|
| How the project stands: stuck work, what shipped, what is in flight, the next release | \`project.status\` | |
| What waits on you, with the recommended answer | \`project.needs_you\` | |
| What was decided, by whom and why | \`project.decisions\` | |
| What is wanted: a requirement drafted, revised, proposed; a question on one answered | \`requirements.*\` | \`requirement-lifecycle\` |
| How it should flow: a workflow design, a mockup to try, a suggestion | \`design.*\` | \`workflow-design\`, \`mockups\`, \`suggestions\` |
| What a user or owner reported | \`project_feedback.*\` | \`feedback-triage\` |
| What shipped, and a release waiting on approval | \`releases.*\` | |
| A question waiting on a person | \`questions.*\` | |

On the web the same reads are the project home, Needs you, Requirements, Feedback and Releases.
Read \`project.status\` first: it is the read the dashboard draws, so what you say and what the page
shows cannot disagree. Say a figure with the read it came from, and a forecast as the range it is.

### Where what you hear goes
- **A problem a user or owner reports** → Feedback, kind \`bug\`, naming the requirement it touches.
- **A wish for new or different behaviour** → a draft Requirement, or a draft revision of the one that
  already covers it. A revision writes the WHOLE criteria list; a criterion left out is retired.
- **A question about how things stand** → answered from the reads above, never counted by hand.
- **A note or a learning** → project memory. A rule in force → project knowledge, kind \`rule\`.

### Issues are Delivery's
An issue is one verifiable outcome a builder delivers. Feedback triage and a requirement's breakdown
file them, and the master admits and dispatches them. You read issues for progress
(\`issues.list\`, \`issues.get\`, each with its \`progress\`). You file one directly only for delivery
work an agreed requirement or a triaged item already covers: choose the lane yourself and say why in
what you file. Building, landing, deploying and judging are never a Product role's acts.

### Deciding
Agents decide and record; a person is asked only for what is irreversible, real money, credentials or
a new product direction. Record each decision on the item it shapes — the requirement, the design,
the feedback item — with the choice, the options and why. How much a person must approve is the
project's gate profile (\`GET /api/projects/:id/gates\`): under \`standard\` agreeing, accepting and
triaging are the master's; under \`strict\` they are a person's, on the item's page.`,
};
