import type { SupportApiConnectionConfig, SupportTool } from '@forge/contracts/support';
import { describe, expect, it } from 'vitest';
import type { SupportApi, SupportApis } from './binding.js';
import { callGranted, credentialValuesOf, planCall, planSupportCall } from './call.js';

// REQ-75 BC-12, BC-13, BC-17: the one door a support session's tools reach the product API through.

const config: SupportApiConnectionConfig = {
  baseUrl: 'https://api.shop.test/v1',
  hosts: ['status.shop.test'],
};
const SECRET = 'sk_live_9f8e7d6c5b4a3f2e1d0c';
const headers = { Authorization: `Bearer ${SECRET}` };

const tools: SupportTool[] = [
  {
    name: 'order_status',
    kind: 'diagnose',
    method: 'GET',
    path: '/orders/{orderId}',
    summary: 'read the order',
    params: { orderId: { in: 'path', description: 'the order id', pattern: '[0-9]{4,10}' } },
  },
  {
    name: 'resend_invoice',
    kind: 'fix',
    method: 'POST',
    path: '/orders/{orderId}/invoice',
    summary: 'resend the invoice',
    params: {
      orderId: { in: 'path', description: 'the order id', pattern: '[0-9]{4,10}' },
      email: { in: 'body', description: 'where to', required: true },
    },
  },
];

const plan = (name: string, kind: 'diagnose' | 'fix', args: Record<string, string>) =>
  planCall({ config, tools, name, kind, args });

/** A fetch that answers one canned response and records what it was asked. */
function fakeFetch(answer: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { impl, seen };
}

describe('planCall: a call is planned only as the project declared it (BC-12, BC-13, BC-17)', () => {
  it('builds a granted diagnose call with its path parameter encoded', () => {
    const out = plan('order_status', 'diagnose', { orderId: '1234' });
    expect('plan' in out && out.plan.url.href).toBe('https://api.shop.test/v1/orders/1234');
    expect('plan' in out && out.plan.method).toBe('GET');
  });

  it('refuses a tool the project did not declare, naming the ones it did', () => {
    const out = plan('drop_tables', 'diagnose', {});
    expect('refusal' in out && out.refusal.code).toBe('SUPPORT_TOOL_UNDECLARED');
    expect('refusal' in out && out.refusal.detail).toContain('order_status');
  });

  it('refuses a fix asked through the diagnose door: a fix waits on the asker (BC-13)', () => {
    const out = plan('resend_invoice', 'diagnose', { orderId: '1234', email: 'a@b.test' });
    expect('refusal' in out && out.refusal.code).toBe('SUPPORT_TOOL_KIND');
  });

  it('refuses an argument the tool does not take, and one that fails its pattern', () => {
    const extra = plan('order_status', 'diagnose', { orderId: '1234', host: 'evil.test' });
    expect('refusal' in extra && extra.refusal.code).toBe('SUPPORT_TOOL_ARGS');
    const traversal = plan('order_status', 'diagnose', { orderId: '../../admin' });
    expect('refusal' in traversal && traversal.refusal.code).toBe('SUPPORT_TOOL_ARGS');
    const missing = plan('resend_invoice', 'fix', { orderId: '1234' });
    expect('refusal' in missing && missing.refusal.detail).toContain('email is required');
  });

  it('refuses, at the sending door, a URL on a host the project never granted (BC-17)', async () => {
    const out = plan('order_status', 'diagnose', { orderId: '1234' });
    if (!('plan' in out)) throw new Error('planned');
    const sent = fakeFetch(() => new Response('{}'));
    const moved = { ...out.plan, url: new URL('https://attacker.test/orders/1234') };
    const got = await callGranted({
      plan: moved,
      config,
      headers,
      maxBytes: 1000,
      fetchImpl: sent.impl,
    });
    expect(got).toMatchObject({ refusal: { code: 'SUPPORT_HOST_NOT_GRANTED' } });
    expect(sent.seen).toHaveLength(0);
  });

  it('grants the base URL’s host and the hosts the connection names, nothing else', () => {
    const tool: SupportTool = {
      name: 'health',
      kind: 'diagnose',
      method: 'GET',
      path: '/health',
      summary: 'health',
    };
    const granted = planCall({ config, tools: [tool], name: 'health', kind: 'diagnose', args: {} });
    expect('plan' in granted).toBe(true);
    const elsewhere = planCall({
      config: { baseUrl: 'https://api.shop.test.attacker.test' },
      tools: [tool],
      name: 'health',
      kind: 'diagnose',
      args: {},
    });
    expect('plan' in elsewhere && elsewhere.plan.url.host).toBe('api.shop.test.attacker.test');
  });
});

describe('callGranted: core sends, the credential never comes back (BC-17)', () => {
  it('sends the credential, never follows a redirect, and scrubs it out of the answer', async () => {
    const out = plan('order_status', 'diagnose', { orderId: '1234' });
    if (!('plan' in out)) throw new Error('planned');
    const echo = fakeFetch(
      () =>
        new Response(JSON.stringify({ id: 1234, debug: `token was ${SECRET}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const got = await callGranted({
      plan: out.plan,
      config,
      headers,
      maxBytes: 4000,
      fetchImpl: echo.impl,
    });
    expect(echo.seen[0]?.init.redirect).toBe('manual');
    expect((echo.seen[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    if (!('result' in got)) throw new Error(JSON.stringify(got));
    expect(got.result.status).toBe(200);
    expect(JSON.stringify(got.result.body)).not.toContain(SECRET);
    expect(credentialValuesOf(headers)).toEqual([`Bearer ${SECRET}`, SECRET]);
    expect(JSON.stringify(got.result.body)).toContain('1234');
  });

  it('refuses a 3xx rather than following it to a host nobody granted', async () => {
    const out = plan('order_status', 'diagnose', { orderId: '1234' });
    if (!('plan' in out)) throw new Error('planned');
    const bounce = fakeFetch(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.test/steal' } }),
    );
    const got = await callGranted({
      plan: out.plan,
      config,
      headers,
      maxBytes: 4000,
      fetchImpl: bounce.impl,
    });
    expect(got).toMatchObject({ refusal: { code: 'SUPPORT_HOST_NOT_GRANTED' } });
    expect(bounce.seen).toHaveLength(1);
  });

  it('cuts an answer at the room limit and says so', async () => {
    const out = plan('order_status', 'diagnose', { orderId: '1234' });
    if (!('plan' in out)) throw new Error('planned');
    const big = fakeFetch(() => new Response('x'.repeat(5000)));
    const got = await callGranted({
      plan: out.plan,
      config,
      headers,
      maxBytes: 1000,
      fetchImpl: big.impl,
    });
    if (!('result' in got)) throw new Error('called');
    expect(got.result.truncated).toBe(true);
    expect(String(got.result.body)).toHaveLength(1000);
  });

  it('puts a fix body parameter in the JSON body', async () => {
    const out = plan('resend_invoice', 'fix', { orderId: '1234', email: 'a@b.test' });
    if (!('plan' in out)) throw new Error('planned');
    const ok = fakeFetch(() => new Response('{"sent":true}'));
    await callGranted({ plan: out.plan, config, headers, maxBytes: 1000, fetchImpl: ok.impl });
    expect(ok.seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(ok.seen[0]?.init.body))).toEqual({ email: 'a@b.test' });
  });
});

// ISS-1011: a project binds one support API per credential (one Agenfold workspace each); a tool is
// planned on the binding that grants it, and goes out with that binding's host and headers alone.
describe('planSupportCall: each tool on its own binding (ISS-1011)', () => {
  const moc: SupportApi = {
    bindingId: 'b-moc',
    name: 'moc',
    config: { baseUrl: 'https://moc.agenfold.test/api' },
    tools: [
      {
        name: 'machines_moc',
        kind: 'diagnose',
        method: 'GET',
        path: '/machines',
        summary: 'list the machines of Moc',
      },
    ],
    headers: { 'X-Api-Key': 'key_moc_0123456789' },
  };
  const sidcorp: SupportApi = {
    bindingId: 'b-sidcorp',
    name: 'sidcorp',
    config: { baseUrl: 'https://sidcorp.agenfold.test/api' },
    tools: [
      {
        name: 'machines_sidcorp',
        kind: 'diagnose',
        method: 'GET',
        path: '/machines',
        summary: 'list the machines of SidCorp',
      },
    ],
    headers: { 'X-Api-Key': 'key_sidcorp_9876543210' },
  };
  const apis: SupportApis = {
    bindings: [moc, sidcorp],
    tools: [
      ...moc.tools.map((t) => ({ ...t, binding: moc.name })),
      ...sidcorp.tools.map((t) => ({ ...t, binding: sidcorp.name })),
    ],
  };

  it("plans the second binding's tool on that binding's host, and hands back that binding", () => {
    const out = planSupportCall({ apis, name: 'machines_sidcorp', kind: 'diagnose', args: {} });
    if (!('plan' in out)) throw new Error(JSON.stringify(out));
    expect(out.plan.url.href).toBe('https://sidcorp.agenfold.test/api/machines');
    expect(out.api.bindingId).toBe('b-sidcorp');
    expect(out.api.headers).toEqual({ 'X-Api-Key': 'key_sidcorp_9876543210' });
  });

  it("sends each tool's call with its own binding's credential, never the other's", async () => {
    for (const [tool, key, host] of [
      ['machines_moc', 'key_moc_0123456789', 'moc.agenfold.test'],
      ['machines_sidcorp', 'key_sidcorp_9876543210', 'sidcorp.agenfold.test'],
    ] as const) {
      const out = planSupportCall({ apis, name: tool, kind: 'diagnose', args: {} });
      if (!('plan' in out)) throw new Error(JSON.stringify(out));
      const fetched = fakeFetch(() => new Response('{}', { status: 200 }));
      await callGranted({
        plan: out.plan,
        config: out.api.config,
        headers: out.api.headers,
        maxBytes: 1000,
        fetchImpl: fetched.impl,
      });
      const [sent] = fetched.seen;
      if (!sent) throw new Error(`${tool} sent nothing`);
      expect(new URL(sent.url).host).toBe(host);
      expect((sent.init.headers as Record<string, string>)['X-Api-Key']).toBe(key);
    }
  });

  it('refuses a tool no binding grants, naming the tools of every binding', () => {
    const out = planSupportCall({ apis, name: 'drop_tables', kind: 'diagnose', args: {} });
    expect('refusal' in out && out.refusal.code).toBe('SUPPORT_TOOL_UNDECLARED');
    expect('refusal' in out && out.refusal.detail).toContain('machines_moc, machines_sidcorp');
  });
});
