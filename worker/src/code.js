import words from './words.json' with { type: 'json' };

const WORDS = new Set(words);

export function normaliseCode(value) {
  const parts = String(value || '').toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return parts.length === 4 && parts.every((word) => WORDS.has(word))
    ? parts.join('-')
    : null;
}

export function makeCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => words[byte]).join('-');
}
