// A Coolify that answers deployment records over HTTP, and the delivery rows `confirm.ts` writes.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import type { TestDatabase } from './index.js';

export interface CoolifyTarget {
  id: string;
  label: string;
  resourceUuid: string;
}

export interface FakeCoolify {
  url(): string;
  /** Per deployment uuid: the commit it built, or an HTTP status to fail with. */
  readonly deployments: Map<string, string | number>;
}

export function fakeCoolify(): FakeCoolify {
  const deployments = new Map<string, string | number>();
  let server: Server | null = null;
  let base = '';

  beforeAll(async () => {
    const s = createServer((req, res) => {
      const uuid = decodeURIComponent(String(req.url).replace('/api/v1/deployments/', ''));
      const answer = deployments.get(uuid);
      if (answer === undefined || typeof answer === 'number') {
        res.statusCode = typeof answer === 'number' ? answer : 404;
        res.end('{"message":"no"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ deployment_uuid: uuid, status: 'finished', commit: answer }));
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    server = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  return { url: () => base, deployments };
}

/** The outbound request at `at`; the inbound `deploy.succeeded`'s `created_at`, two minutes on, is
 *  the finish time the serving reading names. */
export async function recordForgeDeployment(
  harness: TestDatabase,
  bindingId: string,
  target: CoolifyTarget,
  uuid: string,
  at: string,
  sent = 'release.requested',
): Promise<void> {
  // A rollback's confirmation carries the label the control gives it, as `controls.ts` writes it.
  const finishedAs =
    sent === 'deploy.rollback.requested' ? `${target.label} rollback` : target.label;
  const request = {
    targetId: target.id,
    targetLabel: target.label,
    resourceUuid: target.resourceUuid,
  };
  await harness.db.execute(sql`
    INSERT INTO integration_deliveries (binding_id, direction, event_name, request_id, status,
                                        payload, response, created_at)
    VALUES (${bindingId}, 'outbound', ${sent}, ${`out:${uuid}`}, 'ok', ${JSON.stringify(request)}::jsonb,
            ${JSON.stringify({ deployment_uuid: uuid, targetId: target.id })}::jsonb, ${at}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_deliveries (binding_id, direction, event_name, request_id, status,
                                        payload, created_at)
    VALUES (${bindingId}, 'inbound', 'deploy.succeeded', ${uuid}, 'ok',
            ${JSON.stringify({ source: 'poll', deployment_uuid: uuid, status: 'succeeded', targetLabel: finishedAs })}::jsonb,
            ${at}::timestamptz + interval '2 minutes')
  `);
}
