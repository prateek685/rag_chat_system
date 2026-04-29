import { computeKeywordOverlap } from './faithfulness.util';

describe('computeKeywordOverlap', () => {
  describe('basic overlap', () => {
    it('returns 1.0 when every response word appears in context', () => {
      const score = computeKeywordOverlap(
        'transformer attention mechanism sequence',
        ['The transformer model relies on the attention mechanism for sequence processing.'],
      );
      expect(score).toBe(1);
    });

    it('returns 0.0 when no response word appears in context', () => {
      const score = computeKeywordOverlap(
        'quantum entanglement physics particle',
        ['The transformer model relies on attention mechanisms.'],
      );
      expect(score).toBe(0);
    });

    it('returns a partial score for partial overlap', () => {
      // "transformer" and "attention" are in context; "novel" and "approach" are not
      const score = computeKeywordOverlap(
        'novel approach transformer attention',
        ['transformer architecture uses attention layers'],
      );
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });
  });

  describe('edge cases', () => {
    it('returns 1.0 for an empty response (no claims to verify)', () => {
      expect(computeKeywordOverlap('', ['some context text here'])).toBe(1);
    });

    it('returns 1.0 when response contains only stop words or short tokens', () => {
      // All filtered out: "the", "is", "a" (≤3 chars)
      expect(computeKeywordOverlap('the is a', ['some relevant context'])).toBe(1);
    });

    it('returns 1.0 for an empty context when response is also empty', () => {
      expect(computeKeywordOverlap('', [])).toBe(1);
    });

    it('is case-insensitive', () => {
      const score = computeKeywordOverlap(
        'Transformer Model',
        ['transformer model description'],
      );
      expect(score).toBe(1);
    });

    it('ignores punctuation in response', () => {
      const score = computeKeywordOverlap(
        'transformer, attention! mechanism.',
        ['transformer attention mechanism'],
      );
      expect(score).toBe(1);
    });

    it('combines content from multiple chunks', () => {
      const score = computeKeywordOverlap(
        'training costs flops performance',
        ['training costs measured in flops', 'model performance metrics'],
      );
      expect(score).toBe(1);
    });
  });

  describe('realistic RAG response scoring', () => {
    it('scores a well-grounded response above 0.3', () => {
      const response =
        'The Transformer (big) model required approximately 2.3×10^19 floating-point operations to train.';
      const chunks = [
        'Transformer (big)28.441.82.3·10^19 Residual Dropout training cost floating point operations',
        'Table 2 summarizes training costs BLEU scores English German translation tasks',
      ];
      const score = computeKeywordOverlap(response, chunks);
      expect(score).toBeGreaterThan(0.3);
    });

    it('scores a hallucinated response lower than a grounded response', () => {
      const chunks = ['Transformer model training costs attention mechanism BLEU scores'];

      const grounded = computeKeywordOverlap(
        'Transformer training costs attention BLEU',
        chunks,
      );
      const hallucinated = computeKeywordOverlap(
        'unicorn rainbow sparkles glitter fantasy',
        chunks,
      );

      expect(grounded).toBeGreaterThan(hallucinated);
    });
  });
});
