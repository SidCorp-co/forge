'use client';

import { Input, Label } from '@/components/ui';

interface ProvidersToolsSectionProps {
  chatProviderId: string;
  setChatProviderId: (v: string) => void;
  chatModel: string;
  setChatModel: (v: string) => void;
}

export function ProvidersToolsSection({
  chatProviderId,
  setChatProviderId,
  chatModel,
  setChatModel,
}: ProvidersToolsSectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          04. Chat Provider
        </h2>
        <span className="text-[9px] font-mono text-outline">PRV_CFG_01</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <Label>Provider ID</Label>
            <Input
              type="text"
              value={chatProviderId}
              onChange={(e) => setChatProviderId(e.target.value)}
              placeholder="anthropic"
              className="font-mono"
            />
            <p className="mt-2 text-[10px] text-outline">
              Provider key registered in <code className="font-mono">forge/core</code> chat
              registry. Empty value falls back to platform default.
            </p>
          </div>
          <div>
            <Label>Model ID</Label>
            <Input
              type="text"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              placeholder="claude-opus-4-7"
              className="font-mono"
            />
            <p className="mt-2 text-[10px] text-outline">
              Model identifier for the selected provider.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
