# Skill: Observability & Evals (Langfuse)

## Scope
`modules/observability/`, `test/evals/`. Langfuse trace/span instrumentation, feedback loop, golden dataset evals, LLM-as-a-Judge.
Use this skill when adding tracing to any node, building eval scripts, or wiring up the thumbs up/down feedback API.

---

## Langfuse Instrumentation Pattern

Every chat request gets one **trace** with nested **spans** per LangGraph node.

```typescript
// 1. Open trace at request entry
const trace = langfuse.trace({
  id: traceId,           // generated per request, returned to frontend
  name: 'rag-chat',
  sessionId,
  input: { userPrompt },
});

// 2. Span per node — always record input AND output
const routerSpan = trace.span({ name: 'router', input: { userPrompt } });
// ... run RouterNode ...
routerSpan.end({ output: { route } });

const retrievalSpan = trace.span({ name: 'retrieval', input: { queryEmbedding, sessionId } });
// ... run RetrievalNode ...
retrievalSpan.end({ output: { chunks: retrievedChunks.map(c => ({ id: c.id, score: c.score })) } });

const generatorSpan = trace.generation({
  name: 'generator',
  model: 'gpt-4o',
  input: messages,        // full prompt array
});
// ... stream GeneratorNode ...
generatorSpan.end({
  output: fullResponse,
  usage: { promptTokens, completionTokens },
});

// 3. Finalize trace after streaming completes
trace.update({ output: fullResponse });
await langfuse.flushAsync();
```

---

## Feedback Loop (Thumbs Up / Down)

### Frontend sends
```typescript
POST /api/chat/feedback
{ traceId: string, score: 1 | -1 }
```

### Backend
```typescript
await langfuse.score({
  traceId,
  name: 'user-feedback',
  value: score,           // 1 = thumbs up, -1 = thumbs down
});
```

Thumbs-down traces become the **source of truth** for expanding the golden dataset: export from Langfuse → fix → add to `test/evals/datasets/golden-dataset.json`.

---

## Golden Dataset Format

File: `test/evals/datasets/golden-dataset.json`

```json
[
  {
    "id": "test_001",
    "user_prompt": "What was the Q3 revenue?",
    "retrieved_context": "Q2 revenue was $2M. Q3 revenue reached $5M.",
    "ideal_answer": "The Q3 revenue was $5M.",
    "expected_chunk_ids": ["chunk_abc123"]
  }
]
```

Minimum 50 entries for the full nightly eval. 10 entries used for the PR mini-eval.

---

## Eval Script: `run-evals.ts`

```typescript
// For each golden entry:
// 1. Run retrieval → check if expected_chunk_ids appear in Top 5 (Context Precision)
// 2. Run full pipeline → judge the answer with gpt-4o as judge

const judgePrompt = `
You are an objective evaluator. Score the following response.

Question: ${entry.user_prompt}
Retrieved Context: ${entry.retrieved_context}
Generated Answer: ${generatedAnswer}
Ideal Answer: ${entry.ideal_answer}

Return JSON only:
{
  "faithfulness": 0 or 1,    // 1 if answer uses ONLY facts from context, 0 if any hallucination
  "relevance": 0.0 to 1.0,   // did the answer address the question?
  "reasoning": "..."
}
`;
```

### Thresholds (block merge on PR if violated)
| Metric | Threshold |
|---|---|
| Context Precision (retrieval) | > 95% |
| Faithfulness (anti-hallucination) | 100% — zero tolerance |
| Answer Relevance | > 90% |

---

## DLQ Alert (Cron)

```typescript
// Runs every 5 minutes
@Cron('*/5 * * * *')
async checkDlqThreshold() {
  const failedCount = await this.documentQueue.getFailedCount();
  if (failedCount >= 10) {
    await this.http.post(process.env.SLACK_WEBHOOK_URL, {
      text: `🚨 RAG system: ${failedCount} jobs in DLQ. Immediate investigation required.`,
    });
  }
}
```

---

## Retry Tag Convention (Langfuse)
```typescript
// Tag retry traces for easy filtering in Langfuse dashboard
trace.update({ tags: ['retry'] });
```

---

## What to Record in Each Span
| Span | Input | Output |
|---|---|---|
| `router` | userPrompt | route classification |
| `retrieval` | embedding vector, sessionId | chunk IDs + similarity scores |
| `reranker` | top-50 chunks, query | reranked top-5 + scores |
| `generator` | full messages array | full streamed response + token usage |
| `summarize` | oldest N messages | new running summary |
