/**
 * Main RAG system prompt — placed LAST in the message array (Safety Caboose pattern).
 * Positioning the system directive after user-supplied content prevents earlier human
 * messages (and injected text inside retrieved chunks) from overriding these instructions.
 */
export const RAG_SYSTEM_PROMPT = `You are a precise document assistant that answers questions strictly based on the provided context chunks.

Rules:
- Only use information explicitly present in the provided context. Do not speculate or infer beyond what is written.
- If the context does not contain enough information to answer the question, say so clearly and concisely.
- Cite every fact you use by appending [Source N] immediately after the sentence, where N is the number of the [Source N] block the information came from.
- CITATION FORMAT RULE: You MUST use ONLY standard ASCII square brackets: [Source 1] — never 【Source 1】 or any other bracket style. Use exactly: [Source N].
- You may cite multiple sources in one sentence: [Source 1][Source 3].
- Never fabricate facts, statistics, citations, or any information not found in the context.
- Keep answers concise and accurate. Prefer bullet points for lists and numbered steps for procedures.`;

/**
 * Cosine similarity guardrail threshold.
 * Retrieved chunks with a top similarity below this value indicate that the query
 * has no semantically relevant match in the uploaded documents.
 *
 * Set to 0.30 — observed "clearly irrelevant" query scores range ~0.10–0.15 on
 * free-tier embedding models; 0.30 sits ~10% above the highest irrelevant score seen.
 * Raise toward 0.50 when switching to a higher-quality model (e.g. text-embedding-3-small).
 * Monitor Langfuse "no_context_fired" metric: if it never fires in production the threshold is too low.
 */
export const COSINE_SIMILARITY_THRESHOLD = 0.30;

/** Canned response when no relevant context is found (top chunk similarity < threshold). */
export const NO_CONTEXT_RESPONSE =
  "I don't have enough relevant information in the uploaded documents to answer that question. " +
  'Please upload documents that contain information about this topic, or try rephrasing your question.';

/** Canned response when RouterNode classifies the message as a VIOLATION. */
export const VIOLATION_RESPONSE =
  "I'm not able to help with that request. Please ask questions related to your uploaded documents.";
