'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Modal } from '@/components/ui/modal';

interface Props {
  open: boolean;
  plaintext: string | null;
  onClose: () => void;
}

export function PlaintextRevealModal({ open, plaintext, onClose }: Props) {
  return (
    <Modal open={open} onClose={() => undefined}>
      {open && plaintext !== null && (
        <PlaintextRevealBody plaintext={plaintext} onClose={onClose} />
      )}
    </Modal>
  );
}

function PlaintextRevealBody({
  plaintext,
  onClose,
}: {
  plaintext: string;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-surface-container-highest">
          <KeyRound className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-primary">
            Save your token now
          </h2>
          <p className="text-[10px] uppercase tracking-widest text-outline">
            Shown only once
          </p>
        </div>
      </div>
      <p className="mb-4 text-sm text-on-surface-variant">
        This is the only time the full token will be visible. Store it in a
        secure place (a password manager) before closing this dialog.
      </p>

      <div className="mb-4 rounded-sm border border-outline-variant/40 bg-surface-container-lowest p-3 font-mono text-[12px] leading-relaxed text-on-surface break-all">
        {plaintext}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface hover:bg-surface-container-high"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <label className="mb-6 flex items-start gap-2 text-sm text-on-surface">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>I have saved this token in a safe place.</span>
      </label>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={!confirmed}
          className="rounded-sm bg-primary px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Done
        </button>
      </div>
    </div>
  );
}
