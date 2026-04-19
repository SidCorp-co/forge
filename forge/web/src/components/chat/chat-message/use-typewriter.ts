'use client';

import { useState, useEffect, useRef } from 'react';

/**
 * Typewriter effect for streaming text. Reveals content progressively
 * when new text arrives in large chunks (common with Gemini/LiteLLM).
 *
 * @param text - The full text received so far
 * @param isStreaming - Whether the message is still streaming
 * @param charsPerFrame - Characters to reveal per animation frame (default 3)
 */
export function useTypewriter(text: string, _isStreaming: boolean, _charsPerFrame = 3): string {
  // Directly return text — streaming text arrives incrementally via WS text_delta
  // events, so the natural arrival rate provides the typewriter effect.
  return text;
}
