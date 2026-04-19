import { useRef, useState, useCallback, useEffect } from "react";

interface FilePreview {
  id: string;
  file: File;
  previewUrl: string;
}

interface ChatInputProps {
  onSend: (text: string, files: File[]) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<FilePreview[]>([]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 24 * 6; // 6 lines
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => { resize(); }, [text, resize]);

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      setFiles((prev) => {
        prev.forEach((f) => URL.revokeObjectURL(f.previewUrl));
        return prev;
      });
    };
  }, []);

  const addFiles = useCallback((incoming: File[]) => {
    const images = incoming.filter((f) => f.type.startsWith("image/"));
    const newPreviews = images.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setFiles((prev) => [...prev, ...newPreviews]);
  }, []);

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const removed = prev.find((f) => f.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, files.map((f) => f.file));
    setText("");
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled) handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) addFiles(imageFiles);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  const hasContent = text.trim() || files.length > 0;

  return (
    <div className="border-t border-gray-200 bg-white px-4 py-3">
      {/* File previews */}
      {files.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {files.map((f) => (
            <div key={f.id} className="relative group">
              <img src={f.previewUrl} alt={f.file.name} className="h-14 w-14 rounded-lg object-cover border border-gray-200" />
              <button
                onClick={() => removeFile(f.id)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-gray-800 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Input area */}
      <div
        className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-gray-400 focus-within:bg-white transition-colors"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <button
          onClick={() => fileInputRef.current?.click()}
          className="mb-0.5 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
          type="button"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Message..."
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-gray-400 disabled:opacity-50"
          style={{ maxHeight: "144px" }}
        />
        <button
          onClick={handleSend}
          disabled={!hasContent || disabled}
          className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-white transition-colors hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          type="button"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
}
