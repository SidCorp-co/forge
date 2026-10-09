// A world for previews no issue's run holds (REQ-41): the REQ-39 preview world with its box bound
// to the project, online and confining a chat session, a project setting with demo data, and the
// project's app as a dev server under its own strict CSP (`script-src 'self'`).

import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { bindTestRunner } from './factories.js';
import { PREVIEW_ENVIRONMENTS, PreviewWorld } from './preview-world.js';
import { seedProjectDocument } from './release-world.js';

export const SHIPPED = 'a'.repeat(40);
export const LATER = 'b'.repeat(40);

/** The preview world's environments and a demo one, which a reproduce's demo setting names. */
export const SUBJECT_ENVIRONMENTS = {
  ...PREVIEW_ENVIRONMENTS,
  demo: {
    tier: 'staging' as const,
    deployment: { mode: 'external' as const },
    url: 'https://demo.shop.example.test',
  },
};

export class SubjectsWorld extends PreviewWorld {
  app!: Server;
  appPort = 0;
  readonly appSeen: { url: string; headers: IncomingHttpHeaders }[] = [];

  override async start(): Promise<void> {
    await super.start();
    await seedProjectDocument(this.projectId, this.ownerId, {
      environments: SUBJECT_ENVIRONMENTS,
      extra: {
        preview: {
          command: 'npm run dev -- --port {port}',
          demo: { environment: 'demo', seed: 'npm run seed:demo' },
        },
      },
    });
    // the box, bound to the project, online, and confining a chat session (a sketch run is one)
    await bindTestRunner(this.projectId, this.box.deviceId);
    await db.execute(
      sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${this.box.deviceId}`,
    );
    await db.execute(
      sql`UPDATE devices SET capabilities = '{"followUpCredential": true, "turnCredential": true, "confinedChatNetwork": true}'::jsonb WHERE id = ${this.box.deviceId}`,
    );
    this.app = createServer((req, res) => {
      this.appSeen.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "script-src 'self'",
      });
      res.end(
        '<!doctype html><html><head><title>shop</title></head><body><button>Save order</button></body></html>',
      );
    });
    await new Promise<void>((r) => this.app.listen(0, '127.0.0.1', () => r()));
    this.appPort = (this.app.address() as AddressInfo).port;
  }

  override async stop(): Promise<void> {
    this.app?.closeAllConnections();
    await new Promise<void>((r) => (this.app ? this.app.close(() => r()) : r()));
    await super.stop();
  }

  /** The box answers a start with the app, live. */
  serveApp(): void {
    this.box.devPort = this.appPort;
    this.box.onStart = (frame) =>
      frame.settings === null ? null : { kind: 'live', port: this.appPort };
  }

  /** A release run that shipped `commit` as `version` at `at`, as the release batch records one. */
  async shipRelease(version: string, commit: string, at: Date): Promise<void> {
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
      VALUES (${randomUUID()}, ${this.projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()}, ${version},
              ${at.toISOString()}, ${JSON.stringify({ source: 'release-batch', finish: { state: 'finished', commit } })}::jsonb)
    `);
  }

  async backdateFeedback(key: string, at: Date): Promise<void> {
    await db.execute(
      sql`UPDATE feedback SET created_at = ${at.toISOString()} WHERE project_id = ${this.projectId} AND fb_seq = ${Number(key.slice(3))}`,
    );
  }

  /** A request to a preview host with a body, as the recorder's fetch sends one. */
  postAtPreview(
    previewUrl: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.core.port,
          method: 'POST',
          path,
          headers: {
            host: new URL(previewUrl).host,
            'content-type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            text += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
}
