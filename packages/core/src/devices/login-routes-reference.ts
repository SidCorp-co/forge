import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';

// Crockford base32 with the easy-to-confuse glyphs removed.
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LEN = 7;
export const MAX_LABEL_LEN = 100;
export const MAX_HOSTNAME_LEN = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CODE_MESSAGE = 'invalid pairing_code';
const LABEL_MESSAGE = 'device_label is required (1..100 chars)';
const PLATFORM_MESSAGE = 'device_platform must be one of windows|macos|linux';
const HOSTNAME_MESSAGE = 'device_hostname too long';
const AGENT_MESSAGE = 'agent_id must be a uuid';

/** The code as stored and compared: separators dropped, upper-cased. */
export function canonicalPairingCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function isPairingCode(input: string): boolean {
  const canonical = canonicalPairingCode(input);
  return (
    canonical.length === CODE_LEN && [...canonical].every((ch) => CROCKFORD_ALPHABET.includes(ch))
  );
}

/** A code as a person types it: seven Crockford characters, with or without the dash and in any case. */
export const pairingCodeSchema = z
  .string({ error: CODE_MESSAGE })
  .refine(isPairingCode, { error: CODE_MESSAGE })
  .describe('The code `login/init` returned, e.g. `ABC-DEF2`');

export const loginInitBodySchema = z.object({
  device_label: z
    .string({ error: LABEL_MESSAGE })
    .trim()
    .min(1, { error: LABEL_MESSAGE })
    .max(MAX_LABEL_LEN, { error: LABEL_MESSAGE }),
  device_platform: z
    .string({ error: PLATFORM_MESSAGE })
    .trim()
    .toLowerCase()
    .regex(/^(windows|macos|linux)$/, { error: PLATFORM_MESSAGE }),
  device_hostname: z.string().trim().max(MAX_HOSTNAME_LEN, { error: HOSTNAME_MESSAGE }).optional(),
  machine_id: z.string().trim().optional(),
});

export const loginApproveBodySchema = z.object({
  pairing_code: pairingCodeSchema,
  agent_id: z
    .string({ error: AGENT_MESSAGE })
    .regex(UUID_PATTERN, { error: AGENT_MESSAGE })
    .nullish()
    .describe(
      "An agent in the approver's organization to pair the box as; the approver's own account when absent",
    ),
});

export const loginPollQuerySchema = z.object({ pairing_code: pairingCodeSchema });

function asObject(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

const stringOr = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * The init body as the schema reads it. A field of the wrong type counts as absent, which is how
 * this endpoint has always read a body: a required one then fails by its own message.
 */
export function parseLoginInit(raw: unknown) {
  const body = asObject(raw);
  const parsed = loginInitBodySchema.safeParse({
    device_label: stringOr(body.device_label),
    device_platform: stringOr(body.device_platform),
    device_hostname: stringOr(body.device_hostname),
    machine_id: stringOr(body.machine_id),
  });
  if (parsed.success) return parsed.data;
  throw new HTTPException(400, {
    message: parsed.error.issues[0]?.message ?? LABEL_MESSAGE,
    cause: { code: 'INVALID_BODY' },
  });
}

/** The pairing code and the optional agent of an approval, refused by the name each field has always had. */
export function parseLoginApprove(raw: unknown) {
  const parsed = loginApproveBodySchema.safeParse(asObject(raw));
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  if (first?.path[0] === 'agent_id') {
    throw new HTTPException(400, { message: AGENT_MESSAGE, cause: { code: 'INVALID_BODY' } });
  }
  throw invalidPairingCode();
}

export function parsePollCode(raw: string | undefined): string {
  const parsed = loginPollQuerySchema.safeParse({ pairing_code: raw });
  if (!parsed.success) throw invalidPairingCode();
  return parsed.data.pairing_code;
}

function invalidPairingCode() {
  return new HTTPException(400, {
    message: CODE_MESSAGE,
    cause: { code: 'INVALID_PAIRING_CODE' },
  });
}

export const loginInitResponseSchema = z.object({
  pairing_code: z.string(),
  verify_url: z.string(),
  expires_at: z.string(),
});

export const loginApproveResponseSchema = z.object({
  approved: z.literal(true),
  device: z.object({
    label: z.string(),
    platform: z.string(),
    hostname: z.string().nullable(),
    created_ip: z.string().nullable(),
    created_user_agent: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string(),
  }),
});

export const loginPollResponseSchema = z.object({
  device_token: z.string(),
  device_id: z.string(),
  git_credential: z
    .object({
      transport: z.literal('https'),
      host: z.string(),
      username: z.string(),
      password: z.string(),
      instructions: z.string(),
    })
    .optional(),
});

const BAD_BODY = 'the body is not JSON, or a field is missing or too long';

export const initDeviceLogin = describeOperation({
  summary: 'Start a browser-approved device login and get the short code to approve',
  description:
    'Public. Takes `device_label`, `device_platform` and optionally `device_hostname` and `machine_id`; the code lives ten minutes.',
  responses: {
    200: json(
      loginInitResponseSchema,
      'The code and the page where a signed-in person approves it',
    ),
    400: fail({ INVALID_BODY: BAD_BODY }),
    500: fail('CODE_GENERATION_FAILED', 'five codes in a row collided with an existing one'),
  },
});

export const approveDeviceLogin = describeOperation({
  summary: 'Approve a pending device login as the signed-in person, or as one of their agents',
  description: 'The poll answers the box once this has been called with the code it is waiting on.',
  responses: {
    200: json(loginApproveResponseSchema, 'The box that was approved'),
    400: fail({
      INVALID_BODY: 'the body is not JSON, or `agent_id` is not a uuid',
      INVALID_PAIRING_CODE: '`pairing_code` is not seven Crockford characters',
    }),
    403: fail({
      PAT_MINT_NEEDS_FULL_GRANT: 'the caller is a token granted less than `*`',
      FORBIDDEN: 'the agent belongs to an organization where the caller is not an admin',
    }),
    404: fail({
      PAIRING_CODE_NOT_FOUND: 'the code is unknown, already approved, consumed or expired',
      AGENT_NOT_FOUND: '`agent_id` is not an agent user',
      NOT_FOUND: "the agent's organization does not exist",
    }),
  },
});

export const pollDeviceLogin = describeOperation({
  summary: 'Poll a device login: 204 while pending, the device token once approved, once only',
  description:
    'The field is named `device_token`, the name three `forge-runner` versions read. A code is consumed by the answer that carries the token.',
  responses: {
    200: json(loginPollResponseSchema, 'The device and its token'),
    204: empty('Still waiting for approval'),
    400: fail({ INVALID_PAIRING_CODE: '`pairing_code` is not seven Crockford characters' }),
    410: fail({
      PAIRING_CODE_GONE: 'no such code',
      PAIRING_CODE_CONSUMED: 'the token was already handed out',
      PAIRING_CODE_EXPIRED: 'the ten minutes ran out',
    }),
    500: fail({
      PAIRING_NO_USER: 'the approved row names no person',
      PAIRING_USER_MISSING: 'the approving person no longer exists',
    }),
  },
});
