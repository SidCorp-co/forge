'use client';

import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Eye, Code2 } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Markdown } from '@/components/ui/markdown';

interface SkillFileEditorProps {
  /** Logical path — drives language selection + preview availability. */
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  onChange: (content: string) => void;
  readOnly?: boolean;
}

function extension(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'py':
      return [python()];
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return [javascript({ jsx: ext.endsWith('x'), typescript: ext.startsWith('ts') })];
    case 'json':
      return [json()];
    case 'sh':
    case 'bash':
    case 'zsh':
      return [StreamLanguage.define(shell)];
    default:
      return [];
  }
}

function isMarkdown(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'md' || ext === 'markdown';
}

export function SkillFileEditor({ path, content, encoding, onChange, readOnly }: SkillFileEditorProps) {
  const { resolvedTheme } = useTheme();
  const [showPreview, setShowPreview] = useState(false);
  const extensions = useMemo(() => extension(path), [path]);
  const markdownFile = isMarkdown(path);

  if (encoding === 'base64') {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center rounded border border-outline-variant/30 bg-surface-container-low p-6 text-center text-xs text-outline">
        Binary file ({path}). Content is base64-encoded and not editable here — use the tree to
        rename or delete it.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-outline-variant/20 px-2 py-1.5">
        <span className="truncate font-mono text-[11px] text-on-surface-variant">{path}</span>
        {markdownFile && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info-surface/20"
          >
            {showPreview ? <Code2 className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {showPreview ? 'Edit' : 'Preview'}
          </button>
        )}
      </div>

      {markdownFile && showPreview ? (
        <div className="max-h-[420px] min-h-[200px] overflow-auto rounded-b border border-t-0 border-outline-variant/30 bg-surface-container-low p-3">
          {content.trim() ? (
            <Markdown>{content}</Markdown>
          ) : (
            <p className="text-xs text-outline">Nothing to preview.</p>
          )}
        </div>
      ) : (
        <CodeMirror
          value={content}
          height="420px"
          theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
          extensions={extensions}
          editable={!readOnly}
          readOnly={readOnly}
          onChange={onChange}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: !readOnly }}
          className="overflow-hidden rounded-b border border-t-0 border-outline-variant/30 text-[13px]"
        />
      )}
    </div>
  );
}
