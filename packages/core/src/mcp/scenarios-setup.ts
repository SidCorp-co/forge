// The scenarios of the REST doors a master or a run sets up, journals and hands over through: the
// monitoring connection and its tokens (`integration-door/cards.ts`, `monitoring/cards.ts`), a drive
// run's phase journal and handoff (`pipeline/cards.ts`), schedules, archives, release approvals,
// contract waits and requests, memory checks, comment attachments and a room agent's ask. Forge
// recorded one call of these in the 90 days to 2026-11-17 (GET /api/projects/forge/metrics/doors):
// a run's handoff, refused BAD_REQUEST. So the rest are the situation the record that built the door
// names, with the good use its card teaches; a bad use is carried only where one was recorded.

import type { CardScenario } from '../lessons/index.js';

const NONE = 'forge door use, 2026-08-19..11-17: no call';
const WATCH = 'buy-before-build ruling, ISS-1225 (projects built their own watch scripts)';

export const SETUP_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a screenshot inlined as base64 in a comment body, where the upload takes the file',
    card: 'POST /api/comments/:commentId/attachments',
    source: `the file-upload guide (guides/registry.ts), written because agents inlined base64 screenshots; ${NONE}`,
    situation: 'A run’s comment reports a screen it judged and needs the screenshot beside it',
    bad: 'the screenshot’s bytes went into the comment body as base64',
    good: 'post the comment, then upload the file in the multipart `file` field',
    teaches: [/upload the file in the multipart `file` field/i, /never inline base64/i],
  },
  {
    name: 'a project’s production watched through a Prometheus connection Forge holds',
    card: 'POST /api/integration-connections',
    source: `${WATCH}; ${NONE}`,
    situation: 'A project needs production monitoring and no Prometheus connection exists',
    good: 'create one with provider prometheus, its URL, its user and its password',
    teaches: [/create one with provider prometheus/i, /MONITORING_SERVER_UNAUTHENTICATED/],
  },
  {
    name: 'a monitoring server’s readiness read before a project is bound to it',
    card: 'POST /api/integration-connections/:id/monitoring/readiness',
    source: `${WATCH}; the monitoring guide's readiness step; ${NONE}`,
    situation: 'A master followed a connection’s setup list and is about to bind a project',
    good: 'read readiness and fix each step that reads false; null is unread, never done',
    teaches: [/null means unread, never done/i],
  },
  {
    name: 'a monitoring token minted into the server’s file, never a comment',
    card: 'POST /api/integration-connections/:id/monitoring/tokens/:kind',
    source: `${WATCH}; the monitoring guide's token step; ${NONE}`,
    situation: 'The connection’s setup list reads a token file not yet filled',
    good: 'mint sd for the server and alerts for the Alertmanager, each into its file',
    teaches: [/mint sd for the server and alerts for the Alertmanager/i],
  },
  {
    name: 'a project host’s agent token kept in a file only the agent reads',
    card: 'POST /api/projects/:id/monitoring/agent-token',
    source: `${WATCH}; the monitoring guide's host-agent step; ${NONE}`,
    situation: 'A port the monitoring server cannot reach must be watched on the project’s host',
    good: 'mint the token as a project admin and keep it in a file only the agent reads',
    teaches: [/readable by the agent only/i, /never in the repo/i],
  },
  {
    name: 'a drive step’s handoff refused BAD_REQUEST on forge',
    card: 'POST /api/issue-step-contexts',
    source:
      'forge door use, 2026-08-19..11-17: its one call, from a checkout on 2026-11-17, refused BAD_REQUEST',
    situation: 'A drive run’s step is ending and the next step builds on what it learned',
    bad: 'the handoff went in a shape its step does not take, and was refused',
    good: 'read the prior steps’ handoffs, then write this step’s in its own payload shape',
    teaches: [/in its step.s payload shape/i, /read the prior steps.? first/i],
  },
  {
    name: 'a drive run’s phase declared on its running pipeline run',
    card: 'POST /api/pipeline-runs/:id/phases',
    source: `the drive rules (prompt/facts/drive-rules.ts): a phase never declared reads as no work done; ${NONE}`,
    situation: 'A drive run moves from building into checking',
    good: 'declare the phase on the running pipeline run of the issue',
    teaches: [/pipeline-runs\?issueId=<id>&status=running/],
  },
  {
    name: 'a failed phase ended as failed, never ok',
    card: 'POST /api/pipeline-runs/:id/phases/end',
    source: `the drive rules (prompt/facts/drive-rules.ts); ${NONE}`,
    situation: 'A run’s checking phase found a red it could not fix',
    good: 'end it failed with a note, naming the attempt the declare answered',
    teaches: [/end it with ok, failed or abandoned/i, /Ending a failed phase as ok/i],
  },
  {
    name: 'a project archived only on its owner’s decision',
    card: 'POST /api/projects/:id/archive',
    source: `the forge CLI's archive route and its org.admin floor; ${NONE}`,
    situation: 'A person retires a project the organization no longer works',
    good: 'archive it as an org admin; its records stay readable',
    teaches: [/archiving is an owner.s decision/i],
  },
  {
    name: 'an archived project brought back on its owner’s word',
    card: 'POST /api/projects/:id/unarchive',
    source: `the forge CLI's unarchive route and its org.admin floor; ${NONE}`,
    situation: 'A person resumes work on a project that was archived',
    good: 'unarchive it as an org admin, never to file work on it unasked',
    teaches: [/without the owner.s word/i],
  },
  {
    name: 'a schedule paused with enabled false, its state kept',
    card: 'PUT /api/schedules/:id',
    source: `the script-schedules guide; the schedules masters ran on forge; ${NONE}`,
    situation: 'A schedule’s check should stop for now and resume later',
    good: 'put it with enabled false, never delete it to pause',
    teaches: [/enabled false to stop it without losing its state/i],
  },
  {
    name: 'a production release’s approval opened with what was read on its environment',
    card: 'POST /api/projects/:projectId/release-batches/:runId/approvals',
    source: `the release runs on forge’s issues (release-batch/cards.ts); ${NONE}`,
    situation: 'A release run on a project that requires approval waits on its request',
    good: 'open it with the commit staged and what was read there; the decision is theirs',
    teaches: [/with the commit staged and what you read there/i],
  },
  {
    name: 'a hung Coolify deploy cancelled after reading the deployment',
    card: 'POST /api/projects/:projectId/integrations/coolify/cancel',
    source: `the deploy-safety guide; ${NONE}`,
    situation: 'A deploy a run started is building the wrong commit',
    good: 'read the deployment, cancel it by name, then deploy the right one or abort',
    teaches: [/Read the deployment first/i, /cancel it naming the deployment/i],
  },
  {
    name: 'an issue’s wait on a contract version it no longer needs, retracted with why',
    card: 'POST /api/issues/:id/contract-waits/:waitId/retract',
    source: `the contract waits on forge’s ecosystem issues (ISS-246, ISS-248, ISS-61); ${NONE}`,
    situation: 'An issue waits on a provider’s version but was rebuilt without it',
    good: 'retract that wait with the reason, so the issue is admitted again',
    teaches: [/retract that wait with the reason/i, /while it still needs that version/i],
  },
  {
    name: 'a contract change asked from the consumer’s project',
    card: 'POST /api/projects/:id/contract-requests',
    source: `the requirements guide's contract-request step; ${NONE}`,
    situation: 'This project needs a field added to a contract another project publishes',
    good: 'file the request from this project naming provider/contract, why and criteria',
    teaches: [/naming provider\/contract, why and the criteria/i, /it is sent from the consumer/i],
  },
  {
    name: 'memories read against the code before they are stamped verified',
    card: 'POST /api/memory/verify',
    source: `REQ-89 BC-5 (a memory re-checked against the code it describes); ${NONE}`,
    situation: 'A master went through the memories that read needs-checking',
    good: 'verify those it found still true in one call, by id; rewrite the rest',
    teaches: [/Stamping memories verified without reading the code/i, /MEMORY_NOT_FOUND/],
  },
  {
    name: 'a room agent’s ask answered first while a person waits in its thread',
    card: 'POST /api/projects/:id/support/master-asks/:askId/answer',
    source: `the dispatch guide’s ask_master answer step; ${NONE}`,
    situation: 'A master’s pass names an ask a room agent is waiting on',
    good: 'answer it before any other work; the agent tells the person, never a post beside it',
    teaches: [/answer it before any other work/i, /never post beside it/i],
  },
];
