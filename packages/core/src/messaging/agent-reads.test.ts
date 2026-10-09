// An Agent session reads the project through `forge-runner api`, and each call to a read's route is
// the read the Assistant's tool of that name makes (REQ-30 BC-1, BC-2; chat-turn design, step `repo`).

import { describe, expect, it } from 'vitest';
import { AGENT_READS, agentReadsOf, readsInCommand } from './agent-reads.js';
import { GROUNDING_TOOLS, MEMORY_TOOL } from './status-claims-rule.js';

const P = 'projects/d1bb4907-74d9-4228-85ff-76121523af7d';

describe('a forge-runner api call is the read its route names', () => {
  it.each([
    [`forge-runner api ${P}/status`, 'forge_project_status'],
    [`forge-runner api /api/${P}/status?days=7`, 'forge_project_status'],
    [`/opt/bin/forge-runner api "${P}/requirements"`, 'forge_requirements'],
    [`forge-runner api ${P}/requirements/REQ-30`, 'forge_requirement'],
    [`forge-runner api ${P}/requirements/REQ-30/decisions`, 'forge_decisions'],
    [`forge-runner api '${P}/issues/ISS-4/comments?intent=decision'`, 'forge_decisions'],
    [`forge-runner api ${P}/needs-you/decisions`, 'forge_needs_you'],
    [`forge-runner api ${P}/releases`, 'forge_releases'],
    [`forge-runner api ${P}/releases/0.4.0`, 'forge_release'],
    [`forge-runner api ${P}/metrics/timeseries`, 'forge_metrics_project_timeseries'],
    [`forge-runner api ${P}/report-queries/release-readiness/runs -X POST`, 'forge_report'],
    [`forge-runner api ${P}/report-templates/t-1/runs -d '{}'`, 'forge_template'],
    [`forge-runner api ${P}/executions -X POST -d '{}'`, 'forge_compute'],
    [`forge-runner api memory/search -d '{"projectId":"p","query":"x"}'`, MEMORY_TOOL],
  ])('%s', (command, read) => {
    expect(readsInCommand(command)).toEqual([read]);
  });

  it('names each read of a chained command, in order', () => {
    expect(
      readsInCommand(`forge-runner api ${P}/status && forge-runner api ${P}/releases | head`),
    ).toEqual(['forge_project_status', 'forge_releases']);
  });

  it.each([
    [`forge-runner api ${P}/status -X POST`, 'a write to a read route'],
    [`forge-runner api ${P}/requirements -d '{"title":"x"}'`, 'a body sent to a read route'],
    [`forge-runner api ${P}/report-queries/q/runs`, 'a run route read with GET'],
    [`forge-runner api ${P}/issues/ISS-4/comments`, 'a thread, not its decisions'],
    [`forge-runner api ${P}/feedback`, 'a route that is no declared read'],
    [`curl https://forge/api/${P}/status`, 'a call that is not forge-runner api'],
    ['cat packages/core/src/messaging/status-claims-rule.ts', 'a repository read'],
  ])('%s is no read (%s)', (command) => {
    expect(readsInCommand(command)).toEqual([]);
  });

  it('offers every read a status claim or a figure rests on', () => {
    for (const tool of Object.values(GROUNDING_TOOLS)) expect(AGENT_READS).toContain(tool);
    expect(AGENT_READS).toContain(MEMORY_TOOL);
  });
});

describe('the reads of a session', () => {
  it('carry what the call returned and whether it failed, and read no other tool', () => {
    const reads = agentReadsOf([
      { name: 'Bash', input: { command: `forge-runner api ${P}/status` }, output: '{"a":1}' },
      {
        name: 'Bash',
        input: { command: `forge-runner api ${P}/releases` },
        output: 'refused',
        isError: true,
      },
      { name: 'Read', input: { file_path: `${P}/status` }, output: 'x' },
    ]);
    expect(reads).toEqual([
      {
        name: 'forge_project_status',
        arguments: `forge-runner api ${P}/status`,
        text: '{"a":1}',
        isError: false,
      },
      {
        name: 'forge_releases',
        arguments: `forge-runner api ${P}/releases`,
        text: 'refused',
        isError: true,
      },
    ]);
  });
});
