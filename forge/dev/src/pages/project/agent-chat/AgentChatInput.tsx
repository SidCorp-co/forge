import { useState, useRef } from "react";

export function AgentChatInput({
  input, setInput, isRunning, hasRepoPath, claudeSessionId, onSend, onOpenTerminal,
}: {
  input: string; setInput: (v: string) => void; isRunning: boolean; hasRepoPath: boolean;
  claudeSessionId: string | null; onSend: (filesOrText?: File[] | string) => void; onOpenTerminal: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ id: string; file: File; preview: string }[]>([]);

  const addFiles = (incoming: File[]) => {
    const images = incoming.filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...images.map((file) => ({
      id: crypto.randomUUID(), file, preview: URL.createObjectURL(file),
    }))]);
  };

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const f = prev.find((x) => x.id === id);
      if (f) URL.revokeObjectURL(f.preview);
      return prev.filter((x) => x.id !== id);
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() && files.length === 0) return;
    onSend(files.length > 0 ? files.map((f) => f.file) : undefined);
    files.forEach((f) => URL.revokeObjectURL(f.preview));
    setFiles([]);
  };

  return (
    <div className="border-t border-[#333333] bg-[#111111] px-4 py-3">
      {files.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
          {files.map((f) => (
            <div key={f.id} className="group relative">
              <img src={f.preview} alt={f.file.name} className="h-12 w-12 rounded border border-[#444444] object-cover" />
              <button onClick={() => removeFile(f.id)}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] text-white opacity-0 group-hover:opacity-100">&times;</button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl gap-2">
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isRunning || !hasRepoPath}
          className="rounded bg-[#222222] px-2 py-2 text-[#888888] hover:bg-[#333333] hover:text-[#cccccc] disabled:opacity-50" title="Attach image">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(Array.from(e.target.files)); e.target.value = ""; }} />
        <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={isRunning ? "Agent is working..." : "Send a message..."} disabled={isRunning || !hasRepoPath}
          className="flex-1 rounded border border-[#333333] bg-[#0c0c0c] px-4 py-2 font-mono text-sm text-[#cccccc] placeholder-[#555555] focus:border-[#666666] focus:outline-none disabled:opacity-50" />
        <button type="submit" disabled={isRunning || (!input.trim() && files.length === 0) || !hasRepoPath}
          className="rounded bg-[#333333] px-4 py-2 font-mono text-sm text-[#cccccc] hover:bg-[#444444] disabled:opacity-50">Send</button>
        {claudeSessionId && hasRepoPath && (
          <button type="button" onClick={onOpenTerminal} title="Resume in Claude CLI"
            className="rounded bg-[#222222] px-3 py-2 font-mono text-sm text-[#888888] hover:bg-[#333333] hover:text-[#cccccc]">
            <span className="hidden sm:inline">CLI</span>
            <span className="sm:hidden">⎿</span>
          </button>
        )}
      </form>
      <p className="mx-auto mt-1 max-w-3xl font-mono text-xs text-[#555555]">
        {claudeSessionId ? `session: ${claudeSessionId.slice(0, 8)}... (--resume active)` : "new conversation"}
      </p>
    </div>
  );
}
