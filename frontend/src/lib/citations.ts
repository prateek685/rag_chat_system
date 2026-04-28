export interface CitationSegment {
  type: 'text' | 'citation';
  value: string;
}

/** Matches [Source N] patterns produced by the system prompt citation rules. */
const CITATION_RE = /\[Source\s+(\d+)\]/g;

/**
 * Splits assistant response text into alternating text and citation segments.
 * Incomplete [Source patterns during streaming pass through as raw text — the
 * regex will not match until the closing ] arrives.
 */
export function parseCitations(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  CITATION_RE.lastIndex = 0;
  while ((match = CITATION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'citation', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}
