'use client';

import { useState } from 'react';
import { Check, Copy, Download, AlertTriangle } from 'lucide-react';
import type { Snippet } from '../lib/snippet-generators';
import { PLACEHOLDER_NOTE } from '../lib/snippet-generators';

interface Props {
  snippet: Snippet;
}

export function SnippetCard({ snippet }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const blob = new Blob([snippet.content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = snippet.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-sm border border-outline-variant/40 bg-surface-container-lowest">
      <div className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-4 py-2.5">
        <code className="font-mono text-[12px] text-on-surface-variant">
          {snippet.filePath}
        </code>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface hover:bg-surface-container-high"
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1.5 rounded-sm border border-outline-variant/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface hover:bg-surface-container-high"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
        </div>
      </div>
      {snippet.placeholderToken && (
        <div className="flex items-start gap-2 border-b border-outline-variant/30 bg-surface-container-low px-4 py-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <p className="text-[12px] leading-relaxed text-on-surface-variant">
            {PLACEHOLDER_NOTE}
          </p>
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-on-surface">
        <code>{snippet.content}</code>
      </pre>
    </div>
  );
}
