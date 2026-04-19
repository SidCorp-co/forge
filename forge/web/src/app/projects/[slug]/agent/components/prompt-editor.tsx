'use client';

import { Loader2, Play, X } from 'lucide-react';
import { Textarea } from '@/components/ui';

interface PromptEditorProps {
  isBuildingPrompt: boolean;
  draftPrompt: string | null;
  editablePrompt: string;
  onEditablePromptChange: (value: string) => void;
  onCancel: () => void;
  onStart: () => void;
}

export function PromptEditor({
  isBuildingPrompt,
  draftPrompt,
  editablePrompt,
  onEditablePromptChange,
  onCancel,
  onStart,
}: PromptEditorProps) {
  if (isBuildingPrompt && !draftPrompt) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-outline">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Desktop is building prompt...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-variant shrink-0">
        <span className="text-xs text-outline">Review and edit the prompt before starting</span>
        <button onClick={onCancel} className="p-1 text-primary-fixed hover:text-outline">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <Textarea
          value={editablePrompt}
          onChange={(e) => onEditablePromptChange(e.target.value)}
          className="min-h-[60vh] h-full resize-none border-surface-variant bg-surface p-4 text-sm text-on-surface-variant font-mono focus:border-primary-fixed"
        />
      </div>

      <div className="flex justify-end gap-2 border-t border-surface-variant px-4 py-3 shrink-0">
        <button
          onClick={onCancel}
          className="rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-xs text-outline hover:bg-surface-container"
        >
          Cancel
        </button>
        <button
          onClick={onStart}
          disabled={!editablePrompt.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-success px-3 py-2 text-xs font-medium text-white hover:bg-success disabled:opacity-50"
        >
          <Play className="h-3 w-3" />
          Start Session
        </button>
      </div>
    </>
  );
}
