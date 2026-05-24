'use server';

import { cookies } from 'next/headers';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

export type ApproveDeviceResult =
  | {
      ok: true;
      device: {
        label: string;
        platform: string;
        hostname: string | null;
        created_ip: string | null;
        created_user_agent: string | null;
        created_at: string;
        expires_at: string;
      };
    }
  | { ok: false; code: string; message: string };

interface ApiOk {
  approved: true;
  device: NonNullable<Extract<ApproveDeviceResult, { ok: true }>['device']>;
}

interface ApiError {
  code?: string;
  message?: string;
}

export async function approveDevice(rawCode: string): Promise<ApproveDeviceResult> {
  const jar = await cookies();
  const jwt = jar.get('forge_auth')?.value;
  if (!jwt) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      message: 'You need to be signed in to approve a device.',
    };
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}/auth/desktop/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ pairing_code: rawCode }),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      code: 'API_UNREACHABLE',
      message: 'Could not reach the Forge API. Check your connection and try again.',
    };
  }

  if (!res.ok) {
    let body: ApiError = {};
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // non-JSON body
    }
    return {
      ok: false,
      code: body.code ?? `HTTP_${res.status}`,
      message: body.message ?? 'Could not approve the pairing code.',
    };
  }

  const data = (await res.json()) as ApiOk;
  return { ok: true, device: data.device };
}
