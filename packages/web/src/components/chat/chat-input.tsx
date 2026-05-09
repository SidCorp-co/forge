'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { ArrowUp, Square, Paperclip, X } from 'lucide-react';

interface FilePreview {
  id: string;
  file: File;
  previewUrl: string;
}

interface ChatInputProps {
  onSend: (text: string, files: File[]) => void;
  disabled?: boolean;
  /** Show a stop button instead of send when true */
  isRunning?: boolean;
  onStop?: () => void;
  /**
   * Show the paperclip button and accept paste/drag image attachments.
   * Default true. Pass false on surfaces that have no real upload endpoint
   * — silently dropping files would mislead the user.
   */
  allowAttachments?: boolean;
}

export function ChatInput({ onSend, disabled, isRunning, onStop, allowAttachments = true }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FilePreview[]>([]);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, []);

  // Use requestAnimationFrame for smoother resize
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    requestAnimationFrame(resize);
  }, [resize]);

  // Revoke all blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      setFiles((prev) => {
        prev.forEach((f) => URL.revokeObjectURL(f.previewUrl));
        return prev;
      });
    };
  }, []);

  const addFiles = useCallback((incoming: File[]) => {
    const images = incoming.filter((f) => f.type.startsWith('image/'));
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

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, files.map((f) => f.file));
    setText('');
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, files, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isRunning) handleSend();
    }
  }, [disabled, isRunning, handleSend]);

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!allowAttachments) return;
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length > 0) addFiles(imageFiles);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!allowAttachments) return;
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!allowAttachments) return;
    e.preventDefault();
  };

  const hasContent = text.trim() || files.length > 0;
  const inputDisabled = disabled;

  return (
    <div className="shrink-0 border-t border-outline-variant/30 bg-surface-container-low px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-3">
      {/* File previews */}
      {allowAttachments && files.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {files.map((f) => (
            <div key={f.id} className="relative group">
              <img
                src={f.previewUrl}
                alt={f.file.name}
                className="h-14 w-14 rounded-lg object-cover border"
              />
              <button
                onClick={() => removeFile(f.id)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-surface-container text-on-surface flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Input area */}
      <div
        className="flex items-end gap-2 rounded-2xl border border-outline-variant/30 bg-surface px-3 py-2 focus-within:border-outline transition-colors"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {allowAttachments && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="mb-0.5 p-2 text-on-surface-variant hover:text-on-surface-variant transition-colors shrink-0"
              type="button"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(Array.from(e.target.files));
                e.target.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isRunning ? 'Agent is running...' : 'Message...'}
          rows={1}
          disabled={inputDisabled}
          className="flex-1 resize-none bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant disabled:opacity-50"
          style={{ maxHeight: '144px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}
        />
        {isRunning && onStop ? (
          <button
            onClick={onStop}
            className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger text-white transition-colors hover:bg-danger"
            type="button"
            title="Stop agent"
          >
            <Square className="h-3 w-3" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasContent || inputDisabled}
            className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-on-primary text-on-surface transition-colors hover:bg-surface-container disabled:bg-surface-variant disabled:cursor-not-allowed"
            type="button"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
