'use client';

import { useState, useRef, useCallback } from 'react';
import { MentionInput } from '@/components/ui/mention-input';
import { FileUpload, type UploadedFile } from '@/components/ui/file-upload';
import { apiUpload } from '@/lib/api/client';

interface CommentInputProps {
  onAddComment: (body: string, attachments?: number[]) => void;
}

async function uploadFile(file: File): Promise<UploadedFile | null> {
  try {
    const formData = new FormData();
    formData.append('files', file);
    const uploaded = await apiUpload(formData);
    const first = uploaded[0];
    if (!first?.id) return null;
    return { id: first.id, url: first.url, name: file.name };
  } catch {
    return null;
  }
}

export function CommentInput({ onAddComment }: CommentInputProps) {
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const submitting = useRef(false);

  const handleAttachments = useCallback((files: UploadedFile[]) => {
    setAttachments(files);
  }, []);

  const submit = () => {
    if (!body.trim() || submitting.current) return;
    submitting.current = true;
    const attachmentIds = attachments.length > 0 ? attachments.map((a) => a.id) : undefined;
    onAddComment(body, attachmentIds);
    setBody('');
    setAttachments([]);
    setTimeout(() => { submitting.current = false; }, 300);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length === 0) return;
    e.preventDefault();
    const results: UploadedFile[] = [];
    for (const file of imageFiles) {
      const res = await uploadFile(file);
      if (res) results.push(res);
    }
    if (results.length > 0) setAttachments((prev) => [...prev, ...results]);
  }, []);

  return (
    <form onSubmit={handleSubmit} className="mb-4">
      <MentionInput
        value={body}
        onChange={setBody}
        placeholder="Add a comment... (use @ to mention, paste images)"
        rows={2}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <FileUpload
        value={attachments}
        onChange={handleAttachments}
        uploadFn={uploadFile}
      />
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-outline">Ctrl+Enter to submit</span>
        <button
          type="submit"
          disabled={!body.trim()}
          className="rounded-sm bg-primary px-4 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-primary hover:bg-on-surface-variant shadow-sm transition-all disabled:opacity-50"
        >
          COMMENT
        </button>
      </div>
    </form>
  );
}
