'use client';

import { useState } from 'react';
import { Label, Select } from '@/components/ui';

interface WidgetSnippetSectionProps {
  apiKey?: string | null;
  apiUrl?: string;
  projectName?: string;
  projectSlug?: string;
  previewMode?: boolean;
}

const POSITIONS = [
  { value: 'bottom-right', label: 'Bottom Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
];

const THEMES = [
  { value: 'var(--color-info)', label: 'Blue' },
  { value: 'var(--color-tertiary-container)', label: 'Purple' },
  { value: 'var(--color-success)', label: 'Green' },
  { value: 'var(--color-danger)', label: 'Red' },
  { value: 'var(--color-warning-dim)', label: 'Orange' },
];

export function WidgetSnippetSection({
  apiKey = null,
  apiUrl = '',
  projectName = '',
  projectSlug = '',
  previewMode = false,
}: WidgetSnippetSectionProps) {
  const [position, setPosition] = useState('bottom-right');
  const [themeColor, setThemeColor] = useState('var(--color-info)');
  const [copied, setCopied] = useState(false);

  const snippet = generateSnippet({ apiKey: apiKey || 'YOUR_API_KEY', apiUrl, position, themeColor, projectName, projectSlug });

  const handleCopy = () => {
    if (previewMode) return;
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">Widget Snippet</h2>
        <span className="text-[9px] font-mono text-outline">INT_WGT</span>
      </div>
      {previewMode && (
        <div className="rounded-sm border border-warning/30 bg-warning-dim/10 p-3 text-[10px] font-bold uppercase tracking-widest text-warning">
          Coming v0.1.x — preview only
        </div>
      )}
      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">

      {!apiKey && (
        <p className="mb-3 rounded border border-warning/30 bg-warning-dim/10 px-3 py-2 text-xs text-warning">
          No API key found. Save the project first to generate one, or set it manually in the project schema.
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <Label>Position</Label>
          <Select value={position} onChange={(e) => setPosition(e.target.value)} className="w-full" disabled={previewMode}>
            {POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Theme Color</Label>
          <div className="flex items-center gap-2">
            <Select value={themeColor} onChange={(e) => setThemeColor(e.target.value)} className="flex-1" disabled={previewMode}>
              {THEMES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
            <div className="h-8 w-8 rounded border" style={{ backgroundColor: themeColor }} />
          </div>
        </div>
      </div>

      <div className="relative">
        <Label>Snippet</Label>
        <pre className="mt-1 overflow-x-auto rounded-sm border bg-surface p-4 text-xs text-on-surface">
          <code>{snippet}</code>
        </pre>
        <button
          onClick={handleCopy}
          className="absolute right-2 top-8 rounded bg-surface-container-high px-2 py-1 text-xs text-on-surface hover:bg-surface-container-high"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <p className="mt-2 text-[10px] text-outline">
        Paste this snippet before the closing <code>&lt;/body&gt;</code> tag on any page to embed the chat widget.
      </p>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-primary-fixed">Per-user permissions (JWT)</summary>
        <pre className="mt-2 overflow-x-auto rounded-sm border bg-surface p-3 text-xs text-on-surface">
          <code>{`// After the script loads, set the user's JWT for MCP permissions:
ForgeWidget.setToken(getCurrentUserJWT());

// Or re-init with hubToken + page context:
ForgeWidget.init({
  ...ForgeWidget.getConfig(),
  hubToken: jwt,
  hubContext: { projectId: 42, page: 'dashboard' }
});`}</code>
        </pre>
      </details>
      </div>
    </section>
  );
}

export function generateSnippet({ apiKey, apiUrl, position, themeColor, projectSlug }: {
  apiKey: string;
  apiUrl: string;
  position: string;
  themeColor: string;
  projectName: string;
  projectSlug: string;
}) {
  const config = btoa(JSON.stringify({ k: apiKey, p: position, c: themeColor }));
  return `<script src="${apiUrl}/widget/${projectSlug}/forge-widget.js" data-config="${config}" async></script>`;
}
