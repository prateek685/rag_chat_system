/**
 * Evaluation runner — v1 stub.
 *
 * Full implementation is v2. This script establishes the golden-dataset contract
 * and the LLM-as-Judge scoring pattern used by the nightly CI eval cron.
 *
 * Run:
 *   npx ts-node test/evals/scripts/run-evals.ts
 *
 * v2 TODO(#evals-001, @owner): Wire each entry against the live /chat endpoint
 *   using a test session_id, then call the judge prompt below.
 *
 * v2 TODO(#evals-002, @owner): Persist results to Langfuse as dataset run items
 *   so the dashboard shows metric trends over time.
 *
 * v2 TODO(#evals-003, @owner): Block PR merge if faithfulness < 100% or
 *   answer relevance < 90% on the 10-entry mini-eval subset.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Shape of a single golden-dataset entry. */
interface GoldenEntry {
  id: string;
  user_prompt: string;
  retrieved_context: string;
  ideal_answer: string;
  /** Chunk IDs expected to appear in the top-5 retrieval results. Empty until real chunks are seeded. */
  expected_chunk_ids: string[];
}

/**
 * LLM-as-Judge prompt template (v2 implementation).
 * Scores a generated answer against the ideal answer for faithfulness and relevance.
 *
 * @see .claude/skills/observability-evals.md for the full judge prompt spec.
 */
// v2 TODO(#evals-001, @owner): uncomment and wire up when the full eval runner is implemented.
// const buildJudgePrompt = (entry: GoldenEntry, generatedAnswer: string): string => `
// You are an objective evaluator. Score the following response.
//
// Question: ${entry.user_prompt}
// Retrieved Context: ${entry.retrieved_context}
// Generated Answer: ${generatedAnswer}
// Ideal Answer: ${entry.ideal_answer}
//
// Return JSON only:
// {
//   "faithfulness": 0 or 1,
//   "relevance": 0.0 to 1.0,
//   "reasoning": "..."
// }
// `;

/** Eval thresholds — block merge on PR if violated (enforced in v2 CI gate). */
const THRESHOLDS = {
  /** Fraction of eval entries that must pass context precision check. */
  CONTEXT_PRECISION: 0.95,
  /** Zero tolerance: every answer must use only facts from the retrieved context. */
  FAITHFULNESS: 1.0,
  /** Minimum fraction of answers that adequately address the question. */
  ANSWER_RELEVANCE: 0.90,
} as const;

function loadGoldenDataset(): GoldenEntry[] {
  const datasetPath = path.join(__dirname, '../datasets/golden-dataset.json');
  const raw = fs.readFileSync(datasetPath, 'utf-8');
  return JSON.parse(raw) as GoldenEntry[];
}

async function main(): Promise<void> {
  const entries = loadGoldenDataset();
  console.log(`Loaded ${entries.length} golden entries.`);
  console.log(`Thresholds: context_precision=${THRESHOLDS.CONTEXT_PRECISION}, faithfulness=${THRESHOLDS.FAITHFULNESS}, relevance=${THRESHOLDS.ANSWER_RELEVANCE}`);

  // v2 TODO(#evals-001, @owner): iterate entries, call /chat, run judge, aggregate scores.
  console.log('\n[v1 stub] Full eval execution deferred to v2. Dataset structure validated successfully.');
}

main().catch((err: unknown) => {
  console.error('Eval runner failed:', err);
  process.exit(1);
});
