// The one door a support session's tool reaches a product API through (REQ-75 BC-12, BC-13,
// BC-17). The declaration a project writes is policy; this is the kernel: a tool that is not
// declared, a diagnose tool asked to write, an argument the tool does not declare or that fails its
// pattern, a URL on a host the project did not grant, and a redirect are each refused by name, and
// nothing is sent. The credential is added here and nowhere else, and the answer handed back is
// scrubbed with every credential value named, so neither the session nor the room ever holds it.

import type {
  SupportApiConnectionConfig,
  SupportCallRefusalCode,
  SupportTool,
  SupportToolKind,
} from '@forge/contracts/support';
import { scrubLogText, scrubSecretsDeep } from '@forge/observability';

export interface SupportCallRefusal {
  code: SupportCallRefusalCode;
  detail: string;
}

/** What a granted call answered, scrubbed: the status, and the body cut to the room's limit. */
export interface SupportCallResult {
  status: number;
  ok: boolean;
  body: unknown;
  truncated: boolean;
  durationMs: number;
}

export type SupportCallArgs = Record<string, string | number | boolean>;

/** The request a declared tool makes with these arguments, before any byte is sent. */
export interface PlannedCall {
  tool: SupportTool;
  method: SupportTool['method'];
  url: URL;
  body: Record<string, string | number | boolean> | null;
}

/** The hosts a connection grants: its base URL's own and the ones it names. */
export function grantedHosts(config: SupportApiConnectionConfig): Set<string> {
  const hosts = new Set<string>([new URL(config.baseUrl).host.toLowerCase()]);
  for (const h of config.hosts ?? []) hosts.add(h.toLowerCase());
  return hosts;
}

/** Whether a URL lands on a granted host, over http(s). */
export function hostGranted(url: URL, granted: ReadonlySet<string>): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return granted.has(url.host.toLowerCase());
}

const refuse = (code: SupportCallRefusalCode, detail: string): { refusal: SupportCallRefusal } => ({
  refusal: { code, detail },
});

/**
 * Plan one call: the tool by name, its kind checked against the door asking, every argument checked
 * against what the tool declares, the URL built and its host checked against the grant.
 */
export function planCall(input: {
  config: SupportApiConnectionConfig;
  tools: readonly SupportTool[];
  name: string;
  kind: SupportToolKind;
  args: SupportCallArgs;
}): { plan: PlannedCall } | { refusal: SupportCallRefusal } {
  const tool = input.tools.find((t) => t.name === input.name);
  if (!tool) {
    const names = input.tools.filter((t) => t.kind === input.kind).map((t) => t.name);
    return refuse(
      'SUPPORT_TOOL_UNDECLARED',
      `this project grants no tool named "${input.name}"; its ${input.kind} tools are ${names.length ? names.join(', ') : 'none'}`,
    );
  }
  if (tool.kind !== input.kind) {
    return refuse(
      'SUPPORT_TOOL_KIND',
      tool.kind === 'fix'
        ? `${tool.name} is a fix: it runs only after the person who asked confirms it — propose it with propose_fix`
        : `${tool.name} is a diagnose tool: run it with run, it needs no confirm`,
    );
  }
  const declared = tool.params ?? {};
  const faults: string[] = [];
  for (const name of Object.keys(input.args)) {
    if (!(name in declared)) faults.push(`${name} is not a parameter of ${tool.name}`);
  }
  for (const [name, p] of Object.entries(declared)) {
    const value = input.args[name];
    if (value === undefined) {
      if (p.required || p.in === 'path') faults.push(`${name} is required`);
      continue;
    }
    if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(String(value))) {
      faults.push(`${name} does not match the pattern ${p.pattern}`);
    }
  }
  if (faults.length > 0) {
    const shape = Object.entries(declared)
      .map(([n, p]) => `${n}${p.required || p.in === 'path' ? '' : '?'} (${p.in})`)
      .join(', ');
    return refuse(
      'SUPPORT_TOOL_ARGS',
      `${faults.join('; ')}. ${tool.name} takes ${shape || 'no arguments'}. Nothing was sent.`,
    );
  }
  const path = tool.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(String(input.args[name])),
  );
  const base = input.config.baseUrl.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    return refuse('SUPPORT_TOOL_ARGS', `${tool.name} with these arguments is not a URL`);
  }
  if (!hostGranted(url, grantedHosts(input.config))) {
    return refuse(
      'SUPPORT_HOST_NOT_GRANTED',
      `${url.host} is not a host this project granted; nothing was sent`,
    );
  }
  let body: PlannedCall['body'] = null;
  for (const [name, p] of Object.entries(declared)) {
    const value = input.args[name];
    if (value === undefined) continue;
    if (p.in === 'query') url.searchParams.set(name, String(value));
    if (p.in === 'body') body = { ...(body ?? {}), [name]: value };
  }
  return { plan: { tool, method: tool.method, url, body } };
}

const CALL_TIMEOUT_MS = 15_000;

/**
 * Every value a credential header holds that must never come back: the whole value, and each word of
 * it long enough to be a secret, so `Bearer <token>` is scrubbed where the token appears alone.
 */
export function credentialValuesOf(headers: Readonly<Record<string, string>>): string[] {
  const values = new Set<string>();
  for (const value of Object.values(headers)) {
    if (value.length > 0) values.add(value);
    for (const word of value.split(/\s+/)) if (word.length >= 8) values.add(word);
  }
  return [...values];
}

function cut(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

/**
 * Send a planned call with the credential, refusing a redirect rather than following it to a host
 * nobody granted. Every credential value is scrubbed out of what comes back.
 */
export async function callGranted(input: {
  plan: PlannedCall;
  config: SupportApiConnectionConfig;
  headers: Record<string, string>;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<{ result: SupportCallResult } | { refusal: SupportCallRefusal }> {
  const { plan } = input;
  // the plan was checked when it was made; checked again here, because this is the door that sends
  if (!hostGranted(plan.url, grantedHosts(input.config))) {
    return refuse('SUPPORT_HOST_NOT_GRANTED', `${plan.url.host} is not a granted host`);
  }
  const secrets = credentialValuesOf(input.headers);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await (input.fetchImpl ?? fetch)(plan.url, {
      method: plan.method,
      headers: {
        ...input.headers,
        Accept: 'application/json, text/plain;q=0.8',
        ...(plan.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location');
      return refuse(
        'SUPPORT_HOST_NOT_GRANTED',
        `the API answered ${res.status} redirecting to ${to ? scrubLogText(to, secrets) : 'another place'}, and a redirect is never followed; nothing more was sent`,
      );
    }
    const raw = plan.method === 'HEAD' ? '' : await res.text();
    const { text, truncated } = cut(raw, input.maxBytes);
    let body: unknown = text;
    if (!truncated) {
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    }
    const scrubbed =
      typeof body === 'string' ? scrubLogText(body, secrets) : scrubSecretsDeep(body, secrets);
    return {
      result: {
        status: res.status,
        ok: res.ok,
        body: scrubbed,
        truncated,
        durationMs: Date.now() - started,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      result: {
        status: 0,
        ok: false,
        body: scrubLogText(`the call did not complete: ${reason}`, secrets),
        truncated: false,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
