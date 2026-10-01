// A Coolify that answers an application's deployment list over HTTP, the record an environment's
// state is read from (`integrations/coolify/deployment-records.ts`).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll } from 'vitest';

export interface CoolifyTarget {
  id: string;
  label: string;
  resourceUuid: string;
}

export interface CoolifyDeploymentRow {
  deployment_uuid: string;
  status: string;
  created_at: string;
  commit: string;
}

export interface FakeCoolify {
  url(): string;
  /** Per application uuid: the deployments Coolify lists for it, or an HTTP status to fail with. */
  readonly applications: Map<string, CoolifyDeploymentRow[] | number>;
  /** Adds one deployment of `application` to what Coolify lists. */
  deployed(application: string, uuid: string, commit: string, at: string, status?: string): void;
}

const LIST = '/api/v1/deployments/applications/';

export function fakeCoolify(): FakeCoolify {
  const applications = new Map<string, CoolifyDeploymentRow[] | number>();
  let server: Server | null = null;
  let base = '';

  beforeAll(async () => {
    const s = createServer((req, res) => {
      const path = String(req.url).split('?')[0] ?? '';
      const answer = path.startsWith(LIST)
        ? applications.get(decodeURIComponent(path.slice(LIST.length)))
        : undefined;
      if (typeof answer === 'number') {
        res.statusCode = answer;
        res.end('{"message":"no"}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      const deployments = answer ?? [];
      res.end(JSON.stringify({ count: deployments.length, deployments }));
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
    server = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  return {
    url: () => base,
    applications,
    deployed(application, uuid, commit, at, status = 'finished') {
      const listed = applications.get(application);
      const rows = Array.isArray(listed) ? listed : [];
      applications.set(application, [
        ...rows,
        { deployment_uuid: uuid, status, created_at: at, commit },
      ]);
    },
  };
}
