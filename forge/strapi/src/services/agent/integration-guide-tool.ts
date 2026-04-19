import type { ForgeTool } from './tools';

const GUIDE = `# Forge Runner Proxy — Integration Guide

External projects integrate with Forge's agent runners via REST API. All endpoints use \`X-Forge-API-Key\` header for authentication.

## Authentication

| Method | Header | Description |
|--------|--------|-------------|
| Project API key | \`X-Forge-API-Key: fk_...\` | Per-project key (found in project settings) |
| Global API key | \`X-Forge-API-Key: <key>\` | Instance-wide key (FORGE_GLOBAL_API_KEY env) |
| JWT | \`Authorization: Bearer <token>\` | User JWT token |

---

## 1. Run Agents

### POST /api/claude-proxy/run

Start a new agent session on desktop (Claude CLI) or Antigravity (server-side).

**Request:**
\`\`\`json
{
  "prompt": "List all open issues and summarize them",
  "runner": "antigravity",
  "repoPath": "/path/to/project"
}
\`\`\`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| prompt | string | yes | The prompt to send to the agent |
| runner | string | no | "desktop", "antigravity", or omit for auto (desktop first, antigravity fallback) |
| repoPath | string | no | Working directory on desktop device (auto-resolved from project config if omitted) |

**Response:** \`{ "data": { "sessionId": "abc123", "status": "running", "runner": "antigravity" } }\`

### GET /api/claude-proxy/status/:sessionId

Poll a running session for results.

**Response (running):**
\`\`\`json
{ "data": { "sessionId": "abc123", "status": "running", "runner": "antigravity", "antigravityStatus": "Running" } }
\`\`\`

**Response (completed):**
\`\`\`json
{
  "data": {
    "sessionId": "abc123",
    "status": "completed",
    "runner": "antigravity",
    "messages": [
      { "role": "user", "content": "...", "timestamp": 1710000000000 },
      { "role": "assistant", "content": "...", "timestamp": 1710000030000 }
    ]
  }
}
\`\`\`

### POST /api/claude-proxy/resume

Continue an existing desktop session with a new prompt (Antigravity sessions cannot be resumed).

**Request:**
\`\`\`json
{
  "sessionId": "abc123",
  "prompt": "Now fix the bug you found"
}
\`\`\`

**Response:** \`{ "data": { "sessionId": "abc123", "status": "running", "runner": "desktop" } }\`

### Workflow

\`\`\`
1. POST /api/claude-proxy/run       → { sessionId, status: "running" }
2. GET  /api/claude-proxy/status/abc → { status: "running" }       (poll)
3. GET  /api/claude-proxy/status/abc → { status: "completed", messages: [...] }
4. POST /api/claude-proxy/resume     → { status: "running" }       (optional)
\`\`\`

---

## 2. Push Skills

Push skill definitions directly to runners. Forge relays them — your project owns the skills.

### POST /api/skills/push-antigravity

Packages skills into a ZIP and uploads to the Antigravity agent.

**Request:**
\`\`\`json
{
  "projectId": "antigravity-project-id",
  "skills": [
    {
      "name": "my-skill",
      "skillMd": "# My Skill\\n\\nInstructions for the agent...",
      "files": [
        { "path": "references/guide.md", "content": "# Reference\\n...", "encoding": "utf8" }
      ]
    }
  ]
}
\`\`\`

**Response:** \`{ "data": { "ok": true, "skillCount": 1, "projectId": "..." } }\`

- \`projectId\` is optional if API key maps to a project with Antigravity configured.
- Uploading replaces the skills directory — send the complete set.

### POST /api/skills/push-claude

Sends skills to a connected Claude desktop device via WebSocket.

**Request:**
\`\`\`json
{
  "deviceId": "device-document-id",
  "skills": [
    {
      "name": "my-skill",
      "skillMd": "# My Skill\\n\\nInstructions...",
      "description": "Brief description",
      "version": "1.0.0",
      "files": [
        { "path": "references/guide.md", "content": "...", "encoding": "utf8" }
      ]
    }
  ]
}
\`\`\`

**Response:** \`{ "data": { "ok": true, "skillCount": 1, "deviceId": "..." } }\`

- \`deviceId\` is optional — uses project's default device if omitted.
- Returns 503 if device is not connected.

---

## Skill Format

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Identifier (no \`/\`, \`\\\`, or \`..\`) |
| skillMd | string | yes | Main content in markdown |
| description | string | no | Brief description |
| version | string | no | Semver (default "1.0.0") |
| files | array | no | Reference files |
| files[].path | string | yes | Relative path (no \`..\`) |
| files[].content | string | yes | Content (plain text or base64) |
| files[].encoding | string | yes | "utf8" or "base64" |

## 3. Cross-Project Escalation & Signals

Project agents can communicate cross-project by writing to the **CEO project** (\`targetProjectSlug: "ceo"\`). Two tiers:

### Tier 1: Escalation (Issue-based)

Create a structured escalation issue when hitting a cross-project blocker that needs CEO/human decision.

\`\`\`json
{
  "action": "create",
  "targetProjectSlug": "ceo",
  "data": {
    "title": "[ESCALATION] <your-project-slug>: <short description>",
    "category": "escalation",
    "priority": "high",
    "description": "## What's Blocked\\n<describe the blocker>\\n\\n## Projects Involved\\n- <project-1>\\n- <project-2>\\n\\n## Decision Needed\\n<what needs to be decided>\\n\\n## Impact\\n<what happens if not resolved>",
    "relations": [
      { "type": "blocked_by", "targetDocumentId": "<source-issue-documentId>" }
    ]
  }
}
\`\`\`

### Tier 2: Signal (Agent Comms channel)

Post a comment on the standing **Agent Comms** issue in the CEO project for lightweight FYI/status updates.

1. Find the Agent Comms issue: \`forge_issues list\` with \`targetProjectSlug: "ceo"\` and \`filters: { search: "Agent Comms" }\`
2. Post a comment: \`forge_comments create\` with \`targetProjectSlug: "ceo"\`

**Comment format:** \`[<your-project-slug>] <message>\`

**Examples:**
- \`[forge-agents] Pipeline upgrade deployed — all projects now support auto-clarify\`
- \`[sid-desk] Switching to PostgreSQL next week — expect migration downtime\`

**Rule:** If a signal becomes a blocker, escalate to Tier 1 instead.

---

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Validation error |
| 401 | Missing or invalid authentication |
| 404 | Session not found |
| 502 | Antigravity server unreachable |
| 503 | Desktop device not connected / no runner available |

## Quick Start

\`\`\`bash
API="https://forge-api.example.com"
KEY="fk_your_project_key"

# Run an agent
curl -X POST $API/api/claude-proxy/run \\
  -H "X-Forge-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"List open issues","runner":"antigravity"}'
# → {"data":{"sessionId":"abc","status":"running","runner":"antigravity"}}

# Poll for results
curl "$API/api/claude-proxy/status/abc" -H "X-Forge-API-Key: $KEY"
# → {"data":{"sessionId":"abc","status":"completed","messages":[...]}}

# Push skills
curl -X POST $API/api/skills/push-antigravity \\
  -H "X-Forge-API-Key: $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"skills":[{"name":"my-skill","skillMd":"# My Skill\\nDo X when Y."}]}'
\`\`\`
`;

export const forgeIntegrationGuide: ForgeTool = {
  name: 'forge_integration_guide',
  description: 'Returns the REST API integration guide for external projects (claude-proxy + skills push endpoints).',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_input, _ctx) {
    return GUIDE;
  },
};
