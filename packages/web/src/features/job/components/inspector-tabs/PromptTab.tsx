'use client';

import type { PromptEnvelope } from '../../types-prompt';

interface PromptTabProps {
  envelope: PromptEnvelope;
}

export function PromptTab({ envelope }: PromptTabProps) {
  const blocks = envelope.blocks ?? [];
  const totalTokens = blocks.reduce((sum, b) => sum + (b.estTokens ?? 0), 0);
  const totalChars = blocks.reduce((sum, b) => sum + (b.chars ?? 0), 0);
  const hasExtras =
    envelope.payloadExtras && Object.keys(envelope.payloadExtras).length > 0;

  return (
    <div className="space-y-3 px-4 py-3 text-xs">
      <details open className="rounded-sm border border-outline-variant/20 bg-surface-container-low">
        <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          System
        </summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant/20 px-3 py-2 font-mono text-[11px] text-on-surface">
          {envelope.systemPrompt ?? '(empty)'}
        </pre>
      </details>

      <details open className="rounded-sm border border-outline-variant/20 bg-surface-container-low">
        <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          User
        </summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant/20 px-3 py-2 font-mono text-[11px] text-on-surface">
          {envelope.userPrompt ?? '(empty)'}
        </pre>
      </details>

      {hasExtras && (
        <details className="rounded-sm border border-outline-variant/20 bg-surface-container-low">
          <summary className="cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
            Payload extras
          </summary>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant/20 px-3 py-2 font-mono text-[11px] text-on-surface">
            {JSON.stringify(envelope.payloadExtras, null, 2)}
          </pre>
        </details>
      )}

      <section>
        <h4 className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Block breakdown
        </h4>
        {blocks.length === 0 ? (
          <p className="text-xs text-outline">No blocks recorded.</p>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-outline-variant/20 text-left text-on-surface-variant">
                <th className="py-1 pr-2 font-medium">id</th>
                <th className="py-1 pr-2 font-medium">kind</th>
                <th className="py-1 pr-2 text-right font-medium">chars</th>
                <th className="py-1 pr-2 text-right font-medium">est tokens</th>
                <th className="py-1 text-right font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => {
                const pct = totalTokens > 0 ? (b.estTokens / totalTokens) * 100 : 0;
                return (
                  <tr key={b.id} className="border-b border-outline-variant/10">
                    <td className="py-1 pr-2 font-mono text-on-surface">{b.id}</td>
                    <td className="py-1 pr-2 text-on-surface-variant">{b.kind}</td>
                    <td className="py-1 pr-2 text-right font-mono text-on-surface">{b.chars}</td>
                    <td className="py-1 pr-2 text-right font-mono text-on-surface">{b.estTokens}</td>
                    <td className="py-1 text-right font-mono text-on-surface-variant">
                      {pct.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-outline-variant/30 font-semibold">
                <td className="py-1 pr-2 text-on-surface-variant">total</td>
                <td className="py-1 pr-2" />
                <td className="py-1 pr-2 text-right font-mono text-on-surface">{totalChars}</td>
                <td className="py-1 pr-2 text-right font-mono text-on-surface">{totalTokens}</td>
                <td className="py-1 text-right font-mono text-on-surface-variant">100.0%</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
