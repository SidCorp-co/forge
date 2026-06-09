"use client";

// Thin CodeMirror wrapper for the Skill Studio. Picks a language extension from
// the file path (SKILL.md / *.md → markdown, *.json → json, *.sh → shell, else
// plain) and renders with line numbers. Kept dependency-light: only the langs
// declared in package.json are imported.
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";

function extensionsFor(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".md") || p.endsWith(".markdown")) return [markdown()];
  if (p.endsWith(".json")) return [json()];
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".zsh"))
    return [StreamLanguage.define(shell)];
  return [];
}

export function CodeEditor({
  path,
  value,
  onChange,
  editable = true,
  minHeight = "16rem",
}: {
  /** File path — only its extension matters (language selection). */
  path: string;
  value: string;
  onChange: (v: string) => void;
  editable?: boolean;
  minHeight?: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensionsFor(path)}
        editable={editable}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: editable }}
        minHeight={minHeight}
        className="fg-mono text-sm"
      />
    </div>
  );
}
