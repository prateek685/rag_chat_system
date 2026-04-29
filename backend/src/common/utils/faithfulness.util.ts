/**
 * Lightweight stop-word list — words too common to carry semantic meaning.
 * Kept intentionally short: false negatives (keeping a stop word) are harmless;
 * false positives (removing a meaningful word) degrade accuracy.
 */
const STOP_WORDS = new Set([
  'the', 'that', 'this', 'with', 'from', 'have', 'been', 'were', 'they',
  'their', 'than', 'into', 'more', 'some', 'such', 'when', 'which', 'will',
  'also', 'each', 'used', 'both', 'only', 'very', 'well', 'then', 'over',
  'here', 'does', 'what', 'about', 'would', 'there', 'these', 'those',
]);

/**
 * Tokenizes text into a set of lowercase alphabetic words longer than 3 characters,
 * excluding common stop words.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Computes a keyword-overlap faithfulness score between an LLM response and the
 * retrieved context chunks that were used to generate it.
 *
 * Measures what fraction of significant words in the response also appear in the context.
 * A low score suggests the response may contain content not grounded in the retrieved chunks.
 *
 * Score interpretation:
 *   1.0 — every significant word in the response exists in the context (fully grounded)
 *   0.0 — no significant words match the context (potential hallucination)
 *   0.3–0.7 — typical range for a well-grounded RAG response that uses natural phrasing
 *
 * Limitation: this is a lexical metric only — it cannot detect factual errors that use
 * correct vocabulary (e.g. right words, wrong numbers). Use LLM-based evaluation
 * (RAGAS, G-Eval) for higher precision when budget allows.
 *
 * @param response - The LLM-generated response text.
 * @param chunkTexts - Content strings from each retrieved chunk.
 * @returns Overlap score in [0, 1].
 */
export function computeKeywordOverlap(response: string, chunkTexts: string[]): number {
  const responseTokens = tokenize(response);
  if (responseTokens.size === 0) return 1; // empty response — no claims to verify

  const contextTokens = tokenize(chunkTexts.join(' '));

  let overlap = 0;
  for (const token of responseTokens) {
    if (contextTokens.has(token)) overlap++;
  }

  return overlap / responseTokens.size;
}
