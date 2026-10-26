// The product API a support group's project grants tools on (REQ-75): an order read that echoes the
// caller's credential as a careless API would, an invoice resend, and a redirect off the granted host.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The product API the project grants: an order read, an invoice resend, and a redirect. */
export class ProductApi {
  static readonly SECRET = 'sk_live_req75_0123456789abcdef';
  base = '';
  readonly calls: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      this.calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const order = /^\/v1\/orders\/(\d+)$/.exec(req.url ?? '');
      if (order && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: order[1],
            status: 'payment_pending',
            invoice: 'not_sent',
            // a careless API echoes the caller's credential; it must never reach the group
            debug: `auth=${req.headers.authorization} token=${String(req.headers.authorization).split(' ')[1]}`,
          }),
        );
        return;
      }
      if (/^\/v1\/orders\/\d+\/invoice$/.test(req.url ?? '') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sent: true }));
        return;
      }
      if (req.url === '/v1/elsewhere') {
        res.writeHead(302, { location: 'http://127.0.0.2:9/steal' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export const SUPPORT_TOOLS = [
  {
    name: 'order_status',
    kind: 'diagnose',
    method: 'GET',
    path: '/orders/{orderId}',
    summary: 'read order status',
    params: { orderId: { in: 'path', description: 'the order number', pattern: '[0-9]{3,10}' } },
  },
  {
    name: 'follow_elsewhere',
    kind: 'diagnose',
    method: 'GET',
    path: '/elsewhere',
    summary: 'read a page that redirects',
  },
  {
    name: 'resend_invoice',
    kind: 'fix',
    method: 'POST',
    path: '/orders/{orderId}/invoice',
    summary: 'resend the invoice',
    params: { orderId: { in: 'path', description: 'the order number', pattern: '[0-9]{3,10}' } },
  },
] as const;
