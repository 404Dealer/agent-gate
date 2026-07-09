import { sanitizeMetadataText } from './metadata.js';

export function parseSelection(value: string, choiceCount: number): number {
  const selected = Number(value.trim());
  if (!Number.isInteger(selected) || selected < 1 || selected > choiceCount) {
    throw new Error(`Selection must be an integer between 1 and ${choiceCount}`);
  }
  return selected - 1;
}

export function sanitizeTerminalText(value: string): string {
  return sanitizeMetadataText(value, 1_000) ?? '';
}
