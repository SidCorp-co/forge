'use client';

import { useState } from 'react';
import { Copy, Check, KeyRound } from 'lucide-react';

interface TestCredential {
  label: string;
  username: string;
  password: string;
}

interface TestCredentialsPanelProps {
  credentials: TestCredential[];
}

function CopyBtn({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      className="ml-1 inline-flex items-center rounded-sm p-0.5 text-outline-variant hover:text-tertiary transition-colors"
      title="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function TestCredentialsPanel({ credentials }: TestCredentialsPanelProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!credentials.length) return null;

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div className="space-y-2 mt-2">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-outline">
        <KeyRound className="h-3 w-3" />
        Test Accounts
      </div>
      {credentials.map((c, i) => (
        <div key={i} className="rounded-sm border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-xs">
          <div className="font-bold uppercase tracking-widest text-on-surface-variant text-[10px] mb-1">{c.label}</div>
          <div className="flex items-center text-outline">
            <span className="font-mono">{c.username}</span>
            <CopyBtn copied={copiedKey === `u-${i}`} onCopy={() => copy(c.username, `u-${i}`)} />
          </div>
          <div className="flex items-center text-outline">
            <span className="font-mono">{c.password}</span>
            <CopyBtn copied={copiedKey === `p-${i}`} onCopy={() => copy(c.password, `p-${i}`)} />
          </div>
        </div>
      ))}
    </div>
  );
}
