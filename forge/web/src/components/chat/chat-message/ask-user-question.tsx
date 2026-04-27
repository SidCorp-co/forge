'use client';

import { useState } from 'react';
import { useChatSend } from './chat-send-context';
import type { ToolCallData } from './chat-message-types';

interface Question {
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export function AskUserQuestionBody({ tc }: { tc: ToolCallData }) {
  const send = useChatSend();
  const questions: Question[] = (tc.input?.questions as Question[]) ?? [];
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [freeText, setFreeText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const answered = tc.result !== undefined && !tc.isError;

  if (answered) {
    return (
      <div className="ml-4 mt-1 mb-1 rounded border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface-variant">
        <pre className="whitespace-pre-wrap">{typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}</pre>
      </div>
    );
  }

  if (questions.length === 0) return null;

  function toggleOption(qi: number, oi: number, multi: boolean) {
    setSelections((prev) => {
      const current = prev[qi] ?? new Set<number>();
      const next = new Set(current);
      if (multi) {
        if (next.has(oi)) next.delete(oi);
        else next.add(oi);
      } else {
        next.clear();
        next.add(oi);
      }
      return { ...prev, [qi]: next };
    });
  }

  function handleSubmit() {
    if (!send || submitted) return;
    const parts: string[] = [];
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const sel = selections[qi];
      if (sel && sel.size > 0) {
        const labels = [...sel].map((i) => q.options[i]?.label).filter(Boolean);
        parts.push(`${q.header}: ${labels.join(', ')}`);
      }
    }
    if (freeText.trim()) {
      parts.push(freeText.trim());
    }
    const answer = parts.length > 0 ? parts.join('\n') : 'No selection';
    send(answer);
    setSubmitted(true);
  }

  return (
    <div className="ml-4 mt-1 mb-2 space-y-3 rounded border border-outline-variant/30 bg-surface-container-lowest px-3 py-2.5">
      {questions.map((q, qi) => (
        <div key={qi}>
          <div className="mb-1.5 font-sans text-xs font-medium text-on-surface">{q.header}</div>
          <div className="space-y-1">
            {q.options.map((opt, oi) => {
              const selected = selections[qi]?.has(oi) ?? false;
              return (
                <button
                  key={oi}
                  onClick={() => toggleOption(qi, oi, q.multiSelect)}
                  disabled={submitted}
                  className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
                    selected
                      ? 'bg-info-surface/40 border border-info/50'
                      : 'border border-outline-variant/30 hover:border-outline-variant/50 hover:bg-surface-container'
                  } ${submitted ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-[10px]">
                    {q.multiSelect
                      ? (selected ? '☑' : '☐')
                      : (selected ? '◉' : '○')}
                  </span>
                  <span>
                    <span className="font-medium text-on-surface">{opt.label}</span>
                    {opt.description && (
                      <span className="block text-on-surface-variant mt-0.5">{opt.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div>
        <input
          type="text"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder="Additional notes (optional)..."
          disabled={submitted}
          className="w-full rounded border border-outline-variant/30 bg-surface-container-lowest px-2 py-1.5 font-mono text-xs text-on-surface placeholder:text-on-surface-variant focus:border-outline-variant/50 focus:outline-none disabled:opacity-50"
        />
      </div>
      <button
        onClick={handleSubmit}
        disabled={submitted || !send}
        className="rounded bg-info px-3 py-1.5 font-sans text-xs font-medium text-white hover:bg-info disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitted ? 'Submitted' : 'Submit Answer'}
      </button>
    </div>
  );
}
