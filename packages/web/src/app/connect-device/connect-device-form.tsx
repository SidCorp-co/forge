'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { approveDevice, type ApproveDeviceResult } from './actions';

const CROCKFORD_RX = /[^0-9A-HJKMNPQRSTVWXYZ]/g;

/**
 * Format keystrokes to the canonical `XXX-XXXX` shape. Strips disallowed
 * Crockford glyphs, upper-cases, and inserts the dash after position 3.
 */
function formatInput(raw: string): string {
  const stripped = raw.toUpperCase().replace(CROCKFORD_RX, '').slice(0, 7);
  if (stripped.length <= 3) return stripped;
  return `${stripped.slice(0, 3)}-${stripped.slice(3)}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  PAIRING_CODE_NOT_FOUND:
    "That code isn't valid or has already been used. Generate a fresh one in the desktop app.",
  INVALID_PAIRING_CODE: 'Pairing codes are 7 characters from the Crockford alphabet.',
  RATE_LIMITED: 'Too many attempts. Wait an hour and try again.',
  UNAUTHENTICATED: 'You need to be signed in to approve a device.',
  API_UNREACHABLE: 'Could not reach the Forge API. Check your connection and try again.',
};

export interface ConnectDeviceFormProps {
  initialCode: string;
}

export function ConnectDeviceForm({ initialCode }: ConnectDeviceFormProps) {
  const [code, setCode] = useState<string>(formatInput(initialCode));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ApproveDeviceResult | null>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setCode(formatInput(e.target.value));
    if (result && !result.ok) setResult(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await approveDevice(code);
      setResult(res);
    } finally {
      setSubmitting(false);
    }
  }

  if (result?.ok) {
    const d = result.device;
    return (
      <div className="w-full max-w-md border-l-2 border-l-success bg-surface px-8 py-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-success">
          Approved ✓
        </p>
        <h1 className="mt-2 font-mono text-xl font-semibold text-on-surface">
          Forge Desktop is signed in
        </h1>
        <p className="mt-4 text-sm text-on-surface-variant">
          You approved <span className="font-mono">{d.label}</span> ({d.platform}
          {d.hostname ? ` / ${d.hostname}` : ''}). Return to the desktop app — it should sign you
          in within a few seconds.
        </p>
        <dl className="mt-6 grid grid-cols-1 gap-2 font-mono text-[11px] text-on-surface-variant">
          <div>
            <dt className="uppercase tracking-[0.16em]">Approved at</dt>
            <dd>{new Date().toLocaleString()}</dd>
          </div>
          {d.created_ip && (
            <div>
              <dt className="uppercase tracking-[0.16em]">From IP</dt>
              <dd>{d.created_ip}</dd>
            </div>
          )}
          {d.created_user_agent && (
            <div>
              <dt className="uppercase tracking-[0.16em]">User-Agent</dt>
              <dd className="break-all">{d.created_user_agent}</dd>
            </div>
          )}
        </dl>
        <p className="mt-8 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface-variant">
          You can close this tab.
        </p>
      </div>
    );
  }

  const errorMessage =
    result && !result.ok ? (ERROR_MESSAGES[result.code] ?? result.message) : null;

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-md border-l-2 border-l-warning bg-surface px-8 py-10"
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-warning">
        Connect Device
      </p>
      <h1 className="mt-2 font-mono text-xl font-semibold text-on-surface">
        Approve a Forge desktop sign-in
      </h1>
      <p className="mt-4 text-sm text-on-surface-variant">
        Type the pairing code shown on the desktop app. It expires after 10 minutes.
      </p>
      <label className="mt-8 block font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface-variant">
        Pairing code
      </label>
      <input
        type="text"
        value={code}
        onChange={handleChange}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        placeholder="XXX-XXXX"
        className="mt-2 w-full border-b border-outline-variant bg-transparent py-3 font-mono text-2xl tracking-[0.4em] text-on-surface focus:outline-none focus:border-warning"
        aria-invalid={errorMessage ? 'true' : 'false'}
      />
      {errorMessage && (
        <p className="mt-3 font-mono text-[12px] text-warning" role="alert">
          {errorMessage}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || code.replace('-', '').length !== 7}
        className="mt-8 w-full border-l-2 border-l-warning bg-warning/10 px-4 py-3 text-center font-mono text-[12px] uppercase tracking-[0.16em] text-on-surface hover:bg-warning/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? 'Approving…' : 'Approve'}
      </button>
    </form>
  );
}
