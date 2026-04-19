'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { projectApi } from '@/features/project/api/project-api';
import type { ProjectUser } from '@/features/project/types';

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}

export function MentionInput({ value, onChange, placeholder, rows = 2, className = '', onKeyDown, onPaste }: MentionInputProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<ProjectUser[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const searchUsers = useCallback(async (query: string) => {
    if (query.length < 1) {
      setSuggestions([]);
      return;
    }
    try {
      const users = await projectApi.getUsers(query);
      setSuggestions(Array.isArray(users) ? users.slice(0, 5) : []);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newValue.slice(0, cursorPos);

    // Find the last @ before cursor that isn't preceded by a word character
    const match = textBeforeCursor.match(/(^|[^a-zA-Z0-9])@([a-zA-Z0-9_.-]*)$/);

    if (match) {
      const query = match[2];
      setMentionQuery(query);
      setMentionStart(cursorPos - query.length - 1);
      setShowSuggestions(true);
      setSelectedIndex(0);

      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => searchUsers(query), 200);
    } else {
      setShowSuggestions(false);
    }
  };

  const insertMention = (username: string) => {
    const before = value.slice(0, mentionStart);
    const after = value.slice(mentionStart + mentionQuery.length + 1); // +1 for @
    const newValue = `${before}@${username} ${after}`;
    onChange(newValue);
    setShowSuggestions(false);

    // Focus and set cursor after mention
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const pos = before.length + username.length + 2; // @ + space
        textarea.focus();
        textarea.setSelectionRange(pos, pos);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(suggestions[selectedIndex].username);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        return;
      }
    }
    onKeyDown?.(e);
  };

  // Clear debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    if (!showSuggestions) return;
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSuggestions]);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={rows}
        className={`w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm ${className}`}
      />
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-sm border border-outline-variant/30 bg-background py-1 shadow-2xl"
        >
          {suggestions.map((user, i) => (
            <button
              key={user.id}
              type="button"
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs font-medium uppercase tracking-widest ${
                i === selectedIndex ? 'bg-surface-container-high text-primary' : 'text-outline hover:bg-surface-container-low'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(user.username);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-surface-container-low border border-outline-variant/50 text-[10px] font-bold text-tertiary">
                {user.username[0].toUpperCase()}
              </span>
              <span className="truncate">{user.username}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
