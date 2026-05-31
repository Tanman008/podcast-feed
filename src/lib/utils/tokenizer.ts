// lib/utils/tokenizer.ts
// GPT-4 tokenizer for consistent token counting
// Used by chunker to respect 400/600 token boundaries

import { encodingForModel } from 'js-tiktoken';

const gpt4Encoding = encodingForModel('gpt-4');

export function countTokens(text: string): number {
  return gpt4Encoding.encode(text).length;
}

export function estimateChunkSize(text: string, targetTokens: number = 400): number {
  const tokens = countTokens(text);
  const avgCharsPerToken = text.length / Math.max(tokens, 1);
  return Math.round(targetTokens * avgCharsPerToken);
}
