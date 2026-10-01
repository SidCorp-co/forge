import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import {
  type Doc,
  type EcosystemWorld,
  formEcosystem,
  openWorld,
  writeInterfaces,
} from './ecosystem-world.js';
import { createTestProjectMember, createTestUser } from './factories.js';

export type Speaker =
  | 'platform'
  | 'plugin'
  | 'store'
  | 'viewer'
  | 'masterForge'
  | 'masterPlugin'
  | 'platformCli'
  | 'platformTurn'
  | 'forgeMember';

export interface ChannelWorld extends EcosystemWorld {
  tokens: Record<Speaker, string>;
  agent: { forge: string; plugin: string };
  forgeMember: string;
}

export type Reply = { status: number; json: Doc };

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
export const inDays = day;

export async function openChannelWorld(): Promise<ChannelWorld> {
  const w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  await w.harness.db.execute(sql`
    INSERT INTO contract_versions (provider_project_id, contract_slug, version)
    VALUES (${w.project.forge}, 'forge-api', '2026-10-01')
  `);
  const { mintPat } = await import('../../src/auth/pat.js');
  const agentOn = async (projectId: string) => {
    const agent = (await createTestUser(w.harness.db, { kind: 'agent' })).id;
    await createTestProjectMember(w.harness.db, { userId: agent, projectId, role: 'member' });
    const token = (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] }))
      .plaintext;
    return { agent, token };
  };
  const forge = await agentOn(w.project.forge);
  const plugin = await agentOn(w.project.plugin);
  const cli = await mintPat({ userId: w.user.platform, name: 'laptop' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const forgeMember = (await createTestUser(w.harness.db, { emailVerifiedAt: new Date() })).id;
  await createTestProjectMember(w.harness.db, {
    userId: forgeMember,
    projectId: w.project.forge,
    role: 'member',
  });
  const turn = await mintPat({
    userId: w.user.platform,
    name: 'turn:session-1',
    projectIds: [w.project.forge],
    boundProjectId: w.project.forge,
  });
  return {
    ...w,
    agent: { forge: forge.agent, plugin: plugin.agent },
    forgeMember,
    tokens: {
      ...w.token,
      masterForge: forge.token,
      masterPlugin: plugin.token,
      platformCli: cli.plaintext,
      platformTurn: turn.plaintext,
      forgeMember: await signUserToken(forgeMember),
    },
  };
}

export function speaker(w: ChannelWorld) {
  return async (who: Speaker, method: string, path: string, body?: unknown): Promise<Reply> => {
    const res = await w.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${w.tokens[who]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

export const ok = (r: Reply): Doc => {
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};

export const refusal = (r: Reply): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

export function changeNotice(w: ChannelWorld): Doc {
  return {
    ecosystem: w.eco,
    type: 'change-notice',
    to: [w.project.plugin],
    subject: 'forge-api 2026-10-01: opening a run session now requires the policy version',
    dueBy: day(7),
    body: {
      contract: 'forge/forge-api',
      contractVersion: '2026-10-01',
      classification: 'breaking',
      binding: true,
      effectiveOn: day(8),
      summary:
        'Opening a run session must now say which version of the dispatch policy decided to take the work.',
      changes: [
        {
          element: 'POST /api/devices/me/run-sessions',
          kind: 'changed',
          text: 'The request body gains a required field, policyVersion.',
        },
      ],
      migration: 'Send policyVersion on every run-session open.',
    },
  };
}

export function acknowledgement(w: ChannelWorld, inReplyTo: string): Doc {
  return {
    ecosystem: w.eco,
    type: 'acknowledgement',
    to: [w.project.forge],
    subject: `${inReplyTo}: the CLI will send policyVersion in time`,
    inReplyTo,
    body: { disposition: 'will-adapt', adaptBy: day(6) },
  };
}

export function changeRequest(w: ChannelWorld): Doc {
  return {
    ecosystem: w.eco,
    type: 'change-request',
    to: [w.project.forge],
    subject: 'Let the CLI read an issue with its change scope in one call',
    body: {
      contract: 'forge/forge-api',
      need: 'A way to read an issue and the projects its change may affect in one request.',
      rationale: 'The pre-merge summary makes one call per project and is slow.',
      impactIfDeclined: 'The summary stays, but takes several seconds on wide changes.',
      urgency: 'normal',
    },
  };
}

export function decision(w: ChannelWorld, inReplyTo: string): Doc {
  return {
    ecosystem: w.eco,
    type: 'decision',
    to: [w.project.plugin],
    subject: `${inReplyTo} accepted: one call returns the change scope`,
    inReplyTo,
    body: { disposition: 'accepted', reason: 'Useful to both sides.', plannedOn: day(9) },
  };
}

export function rfi(w: ChannelWorld): Doc {
  return {
    ecosystem: w.eco,
    type: 'rfi',
    to: [w.project.plugin],
    subject: 'Does the driver skill read the phase field it is sent?',
    body: {
      question: 'When a drive job reports a phase, does the skill read the field back?',
      references: [{ contract: 'forge-plugin/driver-skill', element: 'phase' }],
      reason: 'We are deciding whether the field can become optional.',
    },
  };
}
