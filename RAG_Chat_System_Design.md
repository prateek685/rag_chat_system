**RAG CHAT SYSTEM**

Technical Design Document

# **1\. Functionality**

The system operates as an open, login-free RAG (Retrieval-Augmented Generation) chat platform with the following core features:

1. Open System — No Login Required

2. Document Upload Panel

3. Chat Interface

4. User History

5. Feedback Mechanism

# **2\. Technical Architecture**

## **2.1  Backend Framework**

**Framework:** NestJS (TypeScript / JavaScript)

## **2.2  Orchestration Framework**

Three candidates have been evaluated. Key decision factors are dynamic routing capability, TypeScript support, and observability integration.

| Option | Pros | Cons |
| :---- | :---- | :---- |
| **LlamaIndex** | ✓ Good out-of-the-box parser ✓ High retrieval accuracy ✓ Native citation support — Query Engines return source nodes automatically | ✗ Rigid for dynamic routing ✗ Weak TypeScript support |
| **LangGraph** | ✓ Best-in-class dynamic routing ✓ Strong TypeScript support ✓ Tight integration with LangSmith & Langfuse for evaluations | ✗ Higher boilerplate — document chunking and embedding require more manual code compared to LlamaIndex |

Recommendation: LangGraph — preferred for dynamic routing, TypeScript support, and observability integration with Langfuse.

## **2.3  Vector Database**

| Option | Pros | Cons |
| :---- | :---- | :---- |
| **Qdrant** | ✓ Fast query performance ✓ Explicit payload filtering — ideal for session\_id isolation ✓ Local deployment via Docker ✓ Open-source and free if self-hosted ✓ High scalability ✓ Native hybrid search support | ✗ Requires managing a separate database |
| **pgvector** | ✓ Zero additional infrastructure ✓ Single database to manage | ✗ Limited scalability at high volume |
| **Pinecone** | ✓ Serverless — no management overhead ✓ Excellent metadata filtering ✓ Strong NestJS / TypeScript SDK support | ✗ Cost increases at scale ✗ Cloud-only — potential data privacy concerns |

Recommendation: pgvector — Zero additional infrastructure

## **2.4  LLM Models**

If adopting the OpenAI ecosystem, the following model configuration is recommended:

| Role | Model | Why |
| :---- | :---- | :---- |
| **Generator** | gpt-4o | Excellent reasoning and response quality |
| **Router** | gpt-4o-mini | Extremely fast and cost-efficient for JSON routing logic |
| **Embeddings** | text-embedding-3-small | Industry standard; strong balance of accuracy and cost |

Alternative options to consider:

* Claude 3.5 Sonnet — currently outperforming GPT-4o on several benchmarks and may be a stronger generator choice

* Open-source models (e.g. Qwen3) — viable if cost constraints are significant

Final model selection will be confirmed once cost efficiency targets are defined (see Open Questions).

## **2.5  Other Infrastructure**

**Primary Database:** PostgreSQL \+ Prisma ORM

**Caching:** Redis — used for API-side caching and session management

**Dynamic Routing:** LLM-based routing via the selected orchestration platform

## **2.6  AI Observability**

| Option | Pros | Cons |
| :---- | :---- | :---- |
| **Langfuse ✓** | ✓ Open-source ✓ Easy to set up ✓ Good NestJS integration | ✗ Comparatively newer — smaller ecosystem |
| **LangSmith** | ✓ Mature tooling | ✗ Heavy ✗ Expensive at scale ✗ Not fully open-source |
| **Arize** | ✓ Established platform | ✗ Python / data-science focused ✗ Poor NestJS fit |

Recommendation: Langfuse — best fit for an open-source NestJS stack.

## **2.7  Testing**

**Unit & Integration Tests:** Jest

Jest is the recommended testing framework for NestJS projects. It is natively supported and requires no additional configuration out of the box.

**API & End-to-End Tests:** Supertest

Supertest is used for API and end-to-end testing. Like Jest, it is natively supported within the NestJS ecosystem and requires no extra setup.

## **2.8  API Documentation**

**Tool:** Swagger (OpenAPI)

Globally proven standard with excellent first-class integration with the NestJS framework.

# **3\. Required Enhancements**

The following components are recommended but require further prioritisation based on budget, latency tolerance, and accuracy targets.

  **Hybrid Search**

Combine Vector Search (semantic meaning) with Keyword Search (BM25) to improve recall on specific names, dates, and technical codes. For the sparse vector layer there are two options:

* Use a JavaScript BM25 library (e.g. wink-bm25)

* Use a lightweight sparse embedding model

Note: If Qdrant is selected as the Vector DB, hybrid search is supported natively — no additional library is required.

  **Evaluation Pipeline**

Use tools like Ragas or TruLens in your CI/CD pipeline to mathematically grade whether the bot is grounding responses in retrieved context or hallucinating.

  **Reranking Layer**

Retrieve the top 50 candidates, then use a reranker model (e.g. Cohere Rerank 3\) to select the top 5 most relevant chunks before building the prompt. Significantly improves precision at marginal latency cost. But it introduces a slight latency trade-off.

 ** Semantic Chunking**

Split documents at natural boundaries (headings, paragraphs) rather than fixed token counts. Preserves semantic context and reduces hallucination caused by mid-sentence splits.

# **4\. Open Questions**

The following decisions are pending and will directly influence infrastructure choices, cost projections, and feature scope.

1. What is the expected number of concurrent users?

   * Design for 100 and build for 10

2. What are the cost efficiency targets?

Everything should run locally (open source only \- expect for LLM)

3. What is the acceptable response latency — sub-2 seconds (real-time feel) or 5–8 seconds (deep agentic research mode)?

P95 of \<= 2 seconds.

4. Should conversation history persist after a tab is closed or the session ends?

Yes. Should maintain in LocalSession store on browser

5. Is there a specific frontend technology stack requirement?

React / Next.js 

6. Where should uploaded documents be stored (e.g. local storage, S3, or another object store)?

Local for now. Containerise everything. Docker \+ Docker Compose

7. Should we use standard vector search (dense vectors only) or a hybrid approach (dense \+ sparse vectors)?

Hybrid. I want the best search results. Pick the one which works best.

8. What will be the conversational memory expectation with the system ?  
9. Evaluation pipeline discussion ?   
10. Prompt injection discussion ?  
11. CI/CD discussion ? 

Backend Architecture

 src/

├── app.module.ts

├── common/

│   ├── filters/           

│   └── interceptors/      

├── config/

│   └── env.config.ts      

├── modules/

│   ├── prisma/            

│   │   ├── prisma.module.ts

│   │   ├── prisma.service.ts 

│   │   └── prisma.service.spec.ts      \# Unit tests (Mock DB calls)

│   ├── document/          

│   │   ├── document.controller.ts  

│   │   ├── document.controller.spec.ts \# Unit tests (Mock services)

│   │   ├── document.service.ts     

│   │   ├── document.service.spec.ts    \# Unit tests (Business logic)

│   │   └── document.module.ts

│   ├── chat/              

│   │   ├── chat.controller.ts      

│   │   ├── chat.controller.spec.ts     \# Unit tests 

│   │   ├── chat.service.ts         

│   │   ├── chat.service.spec.ts        \# Unit tests (Prompt assembly, mock LLM)

│   │   └── chat.module.ts

│   ├── worker/            

│   │   ├── document.processor.ts   

│   │   ├── document.processor.spec.ts  \# Unit tests (Chunking edge-cases)

│   │   ├── vector.service.ts       

│   │   ├── vector.service.spec.ts      \# Unit tests (Mock OpenAI embeddings)

│   │   └── worker.module.ts

│   └── observability/

│       ├── langfuse.service.ts     

│       ├── langfuse.service.spec.ts    \# Unit tests

│       └── observability.module.ts

prisma/                    

├── schema.prisma          

└── migrations/            

test/                      \# NEW: Root level testing directory

├── integration/           \# End-to-end API & Pipeline tests (Supertest \+ Test DB)

│   ├── document.e2e-spec.ts            \# Tests Upload \-\> Queue \-\> DB flow

│   ├── chat.e2e-spec.ts                \# Tests Chat \-\> Retrieval \-\> Response flow

│   └── jest-e2e.json                   \# Specific Jest config for E2E

└── evals/                 \# RAG Quality & LLM tests ( Langfuse)

    ├── datasets/

    │   └── golden-dataset.json         \# Static test cases: \[Input, Context, Ideal Output\]

    ├── scripts/

    │   └── run-evals.ts                \# Custom script for LLM-as-a-judge execution

    └── retrieval-quality.spec.ts       \# Tests Top-K relevance against the Golden Dataset

# **3\. System Flow**

This section describes how the user interacts with the system from first landing on the page through to submitting a query and receiving a response.

## **3.1  User Journey — Document Upload**

 **Step 1    Landing & Session Initialisation**

The user lands on the application. The UI immediately checks localStorage for an existing session\_id. If none is found, a new UUID is generated and persisted to localStorage. This session\_id is used throughout the entire interaction to isolate the user's documents and chat context — no login or registration is required.

 **Step 2    Document Upload Panel**

The user is presented with a drag-and-drop upload zone. Only text-based documents are accepted — the file input is restricted client-side. Accepted formats: .txt, .md, .json, .xml. Maximum file size: 10 MB per file. Multiple files can be selected and uploaded simultaneously. Once files are chosen (via drag-and-drop or the file manager dialog), an upload progress indicator is shown for each file.

 **Step 3    Sending Files to the Backend**

The UI packages the selected files as a multipart/form-data POST request, attaching the session\_id alongside the file payload. The server responds immediately with a job\_id and a status of 'queued' — it does not wait for processing to complete. This keeps the UI responsive.

 **Step 4    Polling for Processing Status**

The UI begins polling the backend every 2 seconds: GET /api/documents/status/:job\_id. While the status is 'processing', a loading state is shown and the chat input remains locked. Once the backend returns status: 'completed', the chat input is unlocked and the user can begin asking questions about the uploaded documents.

The chat interface remains disabled until all uploaded documents have been fully vectorised and stored — this prevents queries against incomplete data.

## **3.2  Backend Document Processing Pipeline**

When the server receives an upload, it does not process the file synchronously. Instead, it queues a background job and returns immediately. The following phases then run asynchronously in the background:

Accepted File types : .`txt`, `.csv,.md,.pdf`

Maximum File Size: 10MB per document

| Phase | Technology | Description |
| :---- | :---- | :---- |
| **1\. Validation** | Multer / NestJS Guard | The file is validated before any disk writes occur. File type and MIME type are checked against the allowed list. File size (.`txt`, `.csv,.md,.pdf`) is enforced at 10 MB. If validation fails, an appropriate error message is returned to the user immediately. |
| **2\. Local Save** | Node.js fs module | After successful validation, the file is saved to disk in a dedicated folder namespaced by session\_id (e.g. /uploads/{session\_id}/). Files are given a consistent, sanitised name to avoid collisions. |
| **3\. Job Creation** | Redis Queue (BullMQ) | The NestJS controller creates a lightweight JSON job object containing the session\_id and file\_path, then pushes it onto a Redis queue. The controller immediately returns the job\_id to the client. The heavy processing work happens entirely in the background worker. |
| **4\. Parsing** | LangChain Loaders | The background worker picks up the job and parses the document using the appropriate LangChain loader (e.g. TextLoader). LangChain automatically injects metadata such as page number and source file into each raw document chunk — this metadata is preserved through the pipeline and surfaced as citations in chat responses. |
| **5\. Chunking** | @langchain/textsplitters RecursiveCharacterTextSplitter | The raw document text is split into smaller, semantically coherent chunks. The splitter prioritises natural boundaries: double newlines (paragraphs) first, then single newlines, then spaces. This avoids cutting sentences or tables mid-way, which would degrade retrieval quality. |
| **6\. Embedding** | OpenAI text-embedding-3-small | The array of text chunks is sent to OpenAI in a single batch request. Each chunk is transformed into a dense vector of 1,536 floating-point numbers representing its semantic meaning. OpenAI returns one vector per chunk. |
| **7\. Storage** | PostgreSQL \+ pgvector \+ tsvector | Each chunk is stored in the database with: (a) the dense vector in a pgvector column for semantic similarity search; (b) a tsvector column populated via to\_tsvector('english', raw\_text) for keyword (BM25-style) search — Postgres automatically removes stop words and indexes lexemes. Each row is tagged with the session\_id and a timestamp for filtering and isolation. |

**3\. Job Creation : Background Job Error Handling & Observability**

**1\. Retry Policy (Handling Transient Failures) :** Background jobs are configured with an **Exponential Backoff** strategy to handle transient network issues or API rate limits gracefully.

* **Max Attempts:** 3 (1 initial attempt \+ 2 retries).  
* **Backoff Strategy:** Exponential, starting with a 2,000ms (2-second) delay, doubling on subsequent failures.  
* *Implementation detail:* `removeOnComplete: true` to keep the queue clean, but `removeOnFail: false` to retain exhausted jobs for the Dead Letter Queue.

**2\. Dead Letter Queue (DLQ) Management :** If a job fails all 3 retry attempts, it is permanently marked as dead. BullMQ natively moves these exhausted jobs into a dedicated `failed` set within Redis. We listen for this event to update the Postgres database so the user isn't waiting forever.

**3\. Job Status Tracking :** The primary database schema changes to sync the background worker's state with the frontend UI, ensuring the user is always informed.

* The `Document` table includes a `status` Enum column (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`).  
* The table includes an `error_message` string column.  
* **Flow:** When a job permanently fails, the worker updates the document's status to `FAILED` and writes the failure reason to the `error_message` column. The Next.js UI polling mechanism reads this state, instantly stops the loading spinner, and displays a "Processing Failed" alert to the user along with the reason.

**4\. Alerting:** To ensure the engineering team is aware of systemic issues before users report them, an automated threshold alert is established.

* A lightweight Cron service (e.g., running every 5 minutes) monitors the length of the BullMQ `failed` queue.  
* If the failed job queue length exceeds a critical threshold (**N \= 10**), the system triggers a webhook alert directly to the engineering Slack channel (and/or Langfuse) requiring immediate intervention.

**5\. Worker Crash Recovery (Stalled Jobs) :** If the Node.js worker process unexpectedly dies (e.g., Out of Memory exception) mid-job, the job is not lost.

* The system utilizes BullMQ’s stalled job detection logic.  
* **Configuration:** The `lockDuration` is set to 30,000ms (30 seconds), and the worker is configured to renew this lock automatically while processing.  
* **Recovery:** If the worker container crashes, the lock ceases to renew. BullMQ's `stalledInterval` sweeper detects the expired lock, classifies the job as "stalled," and automatically redelivers it to the active queue to be picked up by the next available, healthy worker container. The `maxStalledCount` is strictly set to 2 to prevent infinite crash loops.

Session Management:

1. When a user visits the application for the very first time, the Next.js client checks `localStorage` for an existing `session_id`. If none exists, it generates a fresh UUIDv4 and saves it to the browser's local storage.  
2. This `session_id` is attached to every single HTTP request (either in the headers, e.g., `x-session-id`, or the request body) sent to the NestJS backend.  
3. To prevent User A from seeing User B's documents or chat history, the NestJS backend enforces strict multitenancy at the database query level.  
4. Every core table in PostgreSQL (`Session`, `Document`, `DocumentChunk`, `Message`) contains a mandatory `sessionId` column.  
5. Query Enforcement: strict `WHERE` clause bound to the incoming `session_id`  
6. **The "Clear Cache" Event:** If a user clears their browser data, uses an Incognito window, or switches devices (from Laptop to Mobile), their local `session_id` is destroyed.  
7. Upon their next visit, Next.js generates a brand new UUID

 

**Edge Cases :** 

* Handling Duplicates (Hash Validation): The backend generates a SHA-256 hash of the file buffer. If a document with that exact hash already exists for the current session\_id, it is rejected with a 409 Conflict.  
* Corrupted Files / Password Protection: If the specific parser fails (e.g., a PDF is encrypted, or a .txt file is corrupted with binary data), the worker catches the error, aborts the job, and updates the database status to FAILED. And the user will get appropriate UI validation.  
* Safe Cleanup: For any asynchronous failure or successful completion, the system deletes the temporary file from the local /uploads directory to prevent disk bloat.

Once the final database transaction commits, the job status is updated to 'completed' and the polling UI unlocks the chat interface.

## **3.1  User Journey — Chat Interface**

Once the document is uploaded and processed by the server, the user moves to the chat dashboard. User will see the major components as

* User will see a welcome msg  
* Input Area to query the system   
* A side bar where user can see chat history  
* Search bar for historic chats ?

Once the user will input the query and hit send then following flow will run

* Payload will be created with input message and session\_id  
* Ui interact with the backend using /chat endpoint

## **3.2  Backend Chat Processing Pipeline**

**Query extraction:** 

* Query extracted from the req along with session\_id  
* Stream Initialization : The NestJS `ChatController` intercepts the request. It immediately configures the Express response object (`@Res()`) to keep the connection open by setting headers:  
  `Content-Type: text/event-stream`  
  `Connection: keep-alive`  
* ~~Exact Cache Check : check the exact query in redis with the same session\_id if found then reply with cached res.~~  
* Trace Initialization: Langfuse asynchronously opens a tracking trace for the request lifecycle with the received session\_id.

NOTE : drop exact caching checking entirely, do only semantic caching.

**Orchestration :**   
We define strict, physical tracks (the Graph), but we use a small AI agent (`gpt-4o-mini`) as the train conductor to pull the levers.

Here is what LangGraph orchestration actually looks like under the hood:

* **The State:** LangGraph maintains a shared "State" object (an array of messages and retrieved documents) that gets passed from node to node.  
* **The Nodes (Functions):** We define specific, isolated JavaScript functions:  
  * `RouterNode`: Asks `gpt-4o-mini` to classify the intent.  
  * `RetrievalNode`: Executes the Prisma SQL query.  
  * `GeneratorNode`: Streams the final answer using `gpt-4o`.  
* **The Edges (The Tracks):** We define the rules of exactly how data can move.  
* **The Flow:**  
1. The request enters the graph.  
2. It hits the **Router Agent**. The agent thinks: *"This question requires factual data."* It outputs `RAG_QUERY`.  
3. Because the output was `RAG_QUERY`, LangGraph forces the data down the track to the **Retrieval Node**.  
4. The Retrieval Node runs the fast Postgres query, attaches the chunks to the State, and forces the data down the track to the **Generator Node**.  
5. The Generator streams the final answer.

**Routing & Vectorization:** 

* **Semantic Embedding:** NestJS sends the user's prompt to OpenAI (`text-embedding-3-small`). The API returns a 1536-dimensional dense vector representing the semantic meaning of the text.  
* **Semantic Cache Check:** NestJS checks Redis for any previously answered questions with a cosine similarity distance of $\> 0.98$ to the new vector. If found, it returns the cached answer. TTL : 24-hour  
* **Dynamic Routing** (LangGraph \+ `gpt-4o-mini`) :   
  * If a user says "Hello," running a database vector search is a waste of 300 milliseconds and API credits. Routing acts as the traffic controller.   
  * When the prompt arrives, LangGraph passes it to a highly specialized, ultra-fast `RouterNode` powered by `gpt-4o-mini`.  
  * When a user sends a message, LangGraph first passes the prompt to `gpt-4o-mini` with strict instructions to simply classify the intent (e.g., outputting a JSON object like `{"route": "GREETING"}` or `{"route": "RAG_QUERY"}`).  
    

**Hybrid Search :** Instead of asking PostgreSQL to return the Top 5 chunks, your NestJS Prisma query is updated to cast a wider net. It runs the Hybrid Search (Dense \+ Sparse) and asks for the Top 50 chunks.

* NestJS executes a Reciprocal Rank Fusion (RRF) query against PostgreSQL via `prisma.$queryRaw`.  
  * Semantic\_search SELECT id, content, metadata, \-- Calculate distance score 1 \- (embedding \<=\> ${embeddingString}::vector) AS semantic\_score FROM document\_chunks WHERE session\_id \= ${sessionId} ORDER BY embedding \<=\> ${embeddingString}::vector LIMIT 20  
  * keyword\_search  SELECT id, content, metadata, \-- Calculate text match score ts\_rank\_cd(search\_vector, plainto\_tsquery('english', ${userPrompt})) AS keyword\_score FROM document\_chunks WHERE session\_id \= ${sessionId} AND search\_vector @@ plainto\_tsquery('english', ${userPrompt}) ORDER BY keyword\_score DESC LIMIT 20  
  * \-- Combine results, prioritizing items that appear in both (Reciprocal Rank Fusion logic) SELECT COALESCE(s.id, k.id) as id, COALESCE(s.content, k.content) as content, COALESCE(s.metadata, k.metadata) as metadata FROM semantic\_search s FULL OUTER JOIN keyword\_search k ON s.id \= k.id ORDER BY COALESCE(s.semantic\_score, 0\) \+ COALESCE(k.keyword\_score, 0\) DESC LIMIT 50;  
* Reranking : NestJS takes the user's string prompt and the 50 string chunks returned by Postgres, and sends them to a Cross-Encoder model (like the Cohere Rerank 3 API or a locally hosted HuggingFace model if you want to keep costs zero).  
  * *The payload:* `{ "query": "What is the revenue?", "documents": ["chunk 1", "chunk 2", ... "chunk 50"] }`  
  * *The action:* The reranker model reads the prompt and deeply compares it against every single chunk. Unlike a standard embedding model, a reranker understands the semantic relationship *between* the prompt and the document simultaneously.  
  * The system is architected to absorb the following expected latency additions:  
    * **p50 Latency Impact:** \~150ms to 250ms additional time.  
    * **p95 Latency Impact:** \~350ms to 500ms additional time.  
    * **Timeout Threshold:** **600ms**.  
  * The Fallback Strategy (Graceful Degradation) : The backend catches the exception, logs a warning to the Observability platform (Langfuse/Datadog) tagged as `rerank_failure`, and immediately bypasses the reranking step. The system simply takes the raw **Top-5 chunks** as scored by the initial vector database (pgvector/Qdrant hybrid search) and passes them directly to the LLM prompt assembly.  
* Sorting and Truncation: Cohere (or your local reranker) returns an array of the exact same 50 chunks, but re-ordered with a highly accurate relevance score (e.g., 0.0 to 1.0). NestJS slices this array, keeping only the **Top 5**.  
* Guardrail Check: The system uses a **safety threshold** to abort generation if the Reranker's top score is too low, returning a fallback message; otherwise, **NestJS** passes the top 5 chunks  for context assembly and final prompting of **GPT-4o**.

**Prompt Assembly:**

* System Prompt: Contains strict grounding rules ("Answer ONLY using the provided context") and citation instructions ("You must cite the \[Source\] at the end of the sentence").  
* Memory: The last 4-6 messages from the active session are appended to maintain conversational state.  
* Context Block: The 5 retrieved chunks.  
* User Prompt: The current question  
* LLM Invocation: LangGraph triggers the `GeneratorNode` using `gpt-4o` with the configuration `stream: true`.

**Streaming :**

* Token Piping: As OpenAI yields tokens, NestJS instantly writes them to the open HTTP connection (`res.write(\`data: ${token}\\n\\n\`)\`).  
* Client Rendering: Next.js receives the stream and uses `react-markdown` to render the text and format citations (e.g., turning `[Page 4]` into a UI badge).  
* Completion Signal: OpenAI concludes the generation. NestJS sends a final `[DONE]` event and closes the HTTP connection (`res.end()`).  
* The response is **streamed** back to Next.js chunk-by-chunk via Server-Sent Events (SSE) to ensure the first token appears well under the 2-second P95 threshold.  
* State Persistence (Async): In the background, NestJS saves the Question/Answer pair to Postgres for future memory, saves the vector/response to Redis for future caching, and finalizes the Langfuse trace.

**AI Observatory Flow :**

* Trace Initiation: The moment Next.js hits your NestJS `/api/chat` endpoint, a unique `trace_id` is generated for that specific question.  
* Recording the Steps (Spans): As LangGraph orchestrates the request, Langfuse silently records the critical handoffs:  
* Routing Span: Did `gpt-4o-mini` classify it correctly?  
* Retrieval Span: Exactly which 5 text chunks did PostgreSQL return, and what were their similarity scores? *(This is crucial for debugging hallucinations).*  
* Recording the Output (Generation): Once `gpt-4o` streams the answer, Langfuse logs the exact prompt used, the full output, the exact token count, the latency, and the cost.

**The Feedback Loop:** 

The feedback loop takes the data collected by the Observatory and ties it directly to user satisfaction.

* The UI Trigger: After the bot finishes streaming its answer, the Next.js frontend displays a simple Thumbs Up or Thumbs Down icon next to the message.  
* The API Call: If the user clicks Thumbs Down, Next.js sends a lightweight `POST` request to NestJS containing just two things: the `trace_id` (from Step 1\) and a `score` of `-1`.  
* Binding the Data: NestJS forwards this score to Langfuse. Langfuse permanently attaches this negative score to the exact trace.

**EVALS Pipeline:** Closing the feedback loop with Automated Evals

1. Golden Dataset : export failed traces (the Thumbs Down instances) from Langfuse and fix them. store these in a local file (e.g., `eval_dataset.json`).   
   * \[  
   *   {  
   *     "id": "test\_001",  
   *     "user\_prompt": "What was the Q3 revenue?",  
   *     "retrieved\_context": "Q2 revenue was $2M. Q3 revenue reached $5M.",  
   *     "ideal\_answer": "The Q3 revenue was $5M."  
   *   }  
   * \]  
   *   
2. LLM-as-a-Judge: Standalone script takes your Golden Dataset, asks your *current* local code to answer the `user_prompt`, and then uses an impartial LLM (like `gpt-4o`) to judge the new answer against the `ideal_answer`. Since we are using the TS environment the judgment has these ways as the official ragas library is for the python ecosystem.  
   * Make custom judgment logic (RAGAS mimic)  
   * Use langfuse cloud integration  
   * Or use python microservice for the evals  
   * Or go with any alternative of ragas (e.g.Promptfoo, lamaindex)

**Guardrails:** 

* Input Guardrail : During the Routing phase, if the user asks *"Write me a Python script to hack a server,"* the router flags it as `VIOLATION` and immediately returns a canned refusal, bypassing the rest of the system.  
* Context Guardrail: defense against hallucinations, If the top retrieved chunk has a score below `0.60,`the backend intercepts the flow, bypasses `LLM`, and instantly replies with canned reply.  
* Cost Guardrails & API Protection:   
  * **Token/Page Limit:** During the parsing phase, if a document exceeds a predefined token limit (e.g., 50,000 tokens or roughly 100 pages), the upload is rejected with a `413 Payload Too Large` error, prompting the user to upload a smaller, more focused document.  
  * Session Token Budgets: Once a session reaches a hard cap (e.g., 100,000 total tokens), the backend halts generation.  
  * The user receives a message stating: *"You have reached the maximum conversation limit for this session. Please clear your session to start a new chat.*  
  * ***OpenAI Hard Limits:** Within the OpenAI developer portal, a strict monthly hard-cap limit is set. If this dollar amount is reached, the API physically rejects all further requests.*

**Database Interaction :** 

1. Saving the User's Prompt  
   1. As soon as the NestJS backend receives the request, save the user's message to the database.  
   2. If the OpenAI API crashes or times out, we at least have a record that the user *asked* the question.  
2. The Streaming Buffer (During Generation)  
   1. While NestJS is piping these chunks down the open HTTP connection to the frontend, it also concatenates them in the server's memory.  
   2. let fullAssistantResponse \= ""; for await (const chunk of stream) { res.write(chunk.content); // Send to frontend fullAssistantResponse \+= chunk.content; // Save in memory }  
3. Saving the AI's Response (After Streaming)  
   1. The moment OpenAI sends the final `[DONE]` signal and the HTTP stream is closed, NestJS takes that concatenated string and saves it to the database asynchronously.  
   2. Writing to the database now takes 0ms away from the user's experience because their interaction is already finished.  
* Edge case : If the user clicks "Stop Generating" mid-stream, the frontend closes the connection.  
  * It aborts the OpenAI stream  
  * It takes whatever is currently in the `fullAssistantResponse` memory buffer (even if it's half a sentence) and saves *that* to the database. This ensures the conversational memory accurately reflects exactly what the user actually saw on their screen.

## **3.3  User Journey — Document Change**

When a user clicks the trash can icon next to an uploaded document in the UI, Following actions will perform on backend 

* Request: The Next.js frontend sends `DELETE /api/documents/:documentId`  
* Database Clean: Because you set up Prisma with cascading deletes (`onDelete: Cascade` on the chunks), deleting the parent document automatically wipes all associated high-dimensional vectors and text chunks in PostgreSQL instantly.  
* Invalidate Cache: NestJS must clear any cached answers associated with this `session_id`  
* The "Ghost Memory" Problem : If the bot answers a question using Document A, and the user then deletes Document A, the bot's chat history still contains the facts it generated. If the user asks a follow-up question, the bot will read its own chat history and confidently state facts from a document that no longer exists in the database.  
  * Soft Boundary: Instead of deleting the `messages` table, you append a new, invisible message to the chat history explicitly telling `gpt-4o` that the state of the world has changed  
  * ​​ await this.prisma.message.create({ data: { sessionId: currentSessionId, role: 'system', // Notice the role is 'system', not 'assistant' or 'user' content: \`\[SYSTEM DIRECTIVE: The user has permanently deleted the document named "Document\_B.pdf". If the user asks about topics exclusively found in that document, you must reply that the document is no longer available. Ignore any facts in our previous chat history that came exclusively from that document.\]\` } });

## **3.4  User Journey — Retry/Regenerate Response**

UI: When the user clicks the "Retry" icon below an AI response

* Delete old msg state  
* Set the thinking/loading state of the system  
* it fires a specific request to a new endpoint: `POST /api/chat/retry` with the `session_id` and the `message_id` of the AI's response they want to regenerate.

Backend: once the request hit the server following steps will take place

*  Database Rollback: server must clean up the timeline before asking the LLM to think again.  
* Fetch the Prompt: fetch the user's prompt that came immediately before the message that was just deleted.  
* Cache Bypass: a "Retry" implies the cached answer was either wrong or unhelpful.  
  * The `POST /api/chat/retry` endpoint must pass a `skipCache: true` flag  
  * force a fresh generation  
* Then the process will be the same as the chat process pipeline from orchestration to streaming.  
* dynamically bump the `temperature` of `gpt-4o` slightly (e.g., from `0.0` to `0.4`) during a retry to encourage the AI to phrase things differently.  
* Observability changes : add a tag like `tags: ["retry"]` to this specific Langfuse trace


**Edge Cases:** 

**Chat Spamming :** A user rapidly sending 20 complex queries in 5 seconds

Implement Rate Limiting at the NestJS level (e.g., max 10 messages per minute per IP or `session_id`).

**Orphaned Data:** Users upload documents, chat once, close the tab, and never return

**Prompt Injection :** LLMs pay the most attention to the very last thing they read. If your system instructions are at the top of the prompt, and the user's malicious instruction ("Forget everything") is at the bottom, the LLM will likely obey the user. **??**

* The Message Array Structure : Instead of sending a single block of text, you are using LangChain's message classes (`SystemMessage`, `HumanMessage`, `AIMessage`)

**Context Window Overflow:** If a user talks to the bot for 2 hours, appending the entire chat history to every single request will eventually exceed `gpt-4o`'s input limits and skyrocket your costs.

* Sliding window : Instead of pulling the entire conversation history from your `messages` table, you use Prisma's `take` parameter to fetch only the most recent *N* messages.  
  * **Pros:** Zero extra cost, zero extra latency.   
  * **Cons:** If the user says, *"Remember that thing I asked you an hour ago?"*, the bot will have no idea what they are talking about.  
      
* Running Summary: If your users are doing deep, agentic research over long periods, you cannot afford for the bot to forget old information. Instead of dropping old messages, you use your cheap router model (`gpt-4o-mini`) to continuously compress them into a "Running Summary"  
  * add a `summary` column to your session management  
  * LangGraph is perfectly designed for this. You add a specific node to your graph called `SummarizeMemoryNode`.  
  * If `message_count > 10`, trigger the `SummarizeMemoryNode`.  
  * The node takes the existing summary \+ the 8 oldest messages and asks `gpt-4o-mini`: *"Condense this conversation into a brief summary of facts and context."*  
  * It saves the new summary to PostgreSQL.  
  * It deletes those 8 old messages from PostgreSQL to save space.  
  * The final prompt sent to `gpt-4o` now looks like: `[System Prompt] + [Running Summary] + [Last 2 Messages] + [Document Context] + [User Prompt]`.

# **4\. Deployment**

Everything except the LLM APIs remains containerized using **Docker & Docker Compose**.

**Containers :**

1. Next.js (React)  
2. NestJS (Backend)  
3. PostgreSQL with the `pgvector` extension  
4. Redis (BullMQ)  
5. Langfuse  
6. **File Storage:** Local Docker Volume mounted to the NestJS container.

**Docker Compose :**

version: '3.8'

services:

  \# 1\. Unified Database (PostgreSQL \+ pgvector)

  postgres:

    image: ankane/pgvector:latest \# Uses official Postgres image with pgvector pre-installed

    container\_name: rag\_postgres

    environment:

      POSTGRES\_USER: ${POSTGRES\_USER}

      POSTGRES\_PASSWORD: ${POSTGRES\_PASSWORD}

      POSTGRES\_DB: ${POSTGRES\_DB}

    ports:

      \- "5432:5432"

    volumes:

      \- pgdata:/var/lib/postgresql/data

      \- ./init-db.sql:/docker-entrypoint-initdb.d/init.sql \# Optional: auto-creates tables/extensions

    healthcheck:

      test: \["CMD-SHELL", "pg\_isready \-U ${POSTGRES\_USER} \-d ${POSTGRES\_DB}"\]

      interval: 5s

      timeout: 5s

      retries: 5

  \# 2\. Redis (Cache & BullMQ)

  redis:

    image: redis:7-alpine

    container\_name: rag\_redis

    ports:

      \- "6379:6379"

    volumes:

      \- redisdata:/data

    command: redis-server \--appendonly yes \# Ensures queue persistence across restarts

  \# 3\. Langfuse Server (Observability)

  langfuse-server:

    image: langfuse/langfuse:latest

    container\_name: rag\_langfuse

    depends\_on:

      postgres:

        condition: service\_healthy

    ports:

      \- "3000:3000"

    environment:

      \- DATABASE\_URL=postgresql://${POSTGRES\_USER}:${POSTGRES\_PASSWORD}@postgres:5432/${POSTGRES\_DB}

      \- NEXTAUTH\_URL=${NEXTAUTH\_URL:-http://localhost:3000}

      \- NEXTAUTH\_SECRET=${NEXTAUTH\_SECRET}

      \- SALT=${SALT}

      \- TELEMETRY\_ENABLED=false

  \# 4\. NestJS Backend Gateway & Worker

  backend:

    build: 

      context: ./backend \# Assumes your NestJS code is in a 'backend' folder

      dockerfile: Dockerfile

    container\_name: rag\_nestjs

    depends\_on:

      postgres:

        condition: service\_healthy

      redis:

        condition: service\_started

    ports:

      \- "8080:8080"

    environment:

      \- PORT=8080

      \- DATABASE\_URL=postgresql://${POSTGRES\_USER}:${POSTGRES\_PASSWORD}@postgres:5432/${POSTGRES\_DB}

      \- REDIS\_HOST=redis

      \- REDIS\_PORT=6379

      \- OPENAI\_API\_KEY=${OPENAI\_API\_KEY} 

      \- LANGFUSE\_PUBLIC\_KEY=${LANGFUSE\_PUBLIC\_KEY}

      \- LANGFUSE\_SECRET\_KEY=${LANGFUSE\_SECRET\_KEY}

      \- LANGFUSE\_HOST=http://langfuse-server:3000

    volumes:

      \# Mounts a local folder directly into the container for PDF storage

      \- ./uploads:/app/uploads 

  \# 5\. Next.js Frontend

  frontend:

    build:

      context: ./frontend \# Assumes your Next.js code is in a 'frontend' folder

      dockerfile: Dockerfile

    container\_name: rag\_nextjs

    ports:

      \- "3001:3000"

    environment:

      \- NEXT\_PUBLIC\_API\_URL=${NEXT\_PUBLIC\_API\_URL:-http://localhost:8080}

volumes:

  pgdata:

  Redisdata:

.env.example : 

\# \==========================================

\# Database Configuration

\# \==========================================

POSTGRES\_USER=admin

POSTGRES\_PASSWORD=your\_secure\_postgres\_password

POSTGRES\_DB=rag\_database

\# \==========================================

\# Langfuse Security

\# \==========================================

\# Generate random strings for these in production (e.g., using \`openssl rand \-base64 32\`)

NEXTAUTH\_SECRET=your\_super\_secret\_key\_123

SALT=your\_salt\_123

\# \==========================================

\# External API Keys

\# \==========================================

OPENAI\_API\_KEY=sk-your-openai-api-key

LANGFUSE\_PUBLIC\_KEY=pk-lf-your-public-key

LANGFUSE\_SECRET\_KEY=sk-lf-your-secret-key

\# Optional overrides (Docker compose sets defaults for these if left blank)

\# NEXTAUTH\_URL=http://localhost:3000

\# NEXT\_PUBLIC\_API\_URL=http://localhost:8080

.gitignore: 

\# Environment variables

.env

.env.local

.env.production

# **5\. Database Structure**

Prisma natively supports PostgreSQL extensions. We need to enable the `postgresqlExtensions` preview feature and define the `vector` type as an `Unsupported` type (since Prisma doesn't have a native Typescript type for vectors yet, but allows them in the DB).

generator client {

  provider        \= "prisma-client-js"

  previewFeatures \= \["postgresqlExtensions"\]

}

datasource db {

  provider   \= "postgresql"

  url        \= env("DATABASE\_URL")

  extensions \= \[vector\] // Enables pgvector extension

}

// \------------------------------------------------------

// TABLE 1: Session (The Parent Container)

// \------------------------------------------------------

model Session {

  id             String          @id // Maps to the localStorage session\_id from Next.js

  runningSummary String?         @map("running\_summary") 

  // Used if you implement the long-term memory compression

  createdAt      DateTime        @default(now()) @map("created\_at")

  updatedAt      DateTime        @updatedAt @map("updated\_at")

  // Relationships

  chunks         DocumentChunk\[\]

  messages       Message\[\]

  @@map("sessions")

}

// \------------------------------------------------------

// TABLE 2: Document (Parent Table)

// \------------------------------------------------------

model Document {

  id          String   @id @default(uuid())

  sessionId   String   @map("session\_id")

  filename    String   // e.g., "Q3\_Report\_v1.pdf"

  createdAt   DateTime @default(now())

  session     Session  @relation(fields: \[sessionId\], references: \[id\], onDelete: Cascade)

  chunks      DocumentChunk\[\] // One-to-Many relation to the chunks

  @@map("documents")

}

// \------------------------------------------------------

// TABLE 2: DocumentChunk (The Vector Database)

// \------------------------------------------------------

model DocumentChunk {

  id            String   @id @default(dbgenerated("gen\_random\_uuid()")) @db.Uuid

  documentId     String   @map("session\_id")

  content       String   // The actual 500-1000 character text string

  metadata      Json?    // Stores page numbers, original filename, etc.

  // Vector column (1536 is the dimension for OpenAI's text-embedding-3-small)

  embedding     Unsupported("vector(1536)")? 

  // Full Text Search column (Sparse Vectors)

  searchVector  Unsupported("tsvector")?     @map("search\_vector")

  createdAt     DateTime @default(now())     @map("created\_at")

  // Link back to the session

  document       Document  @relation(fields: \[documentid\], references: \[id\], onDelete: Cascade)

  // Indexes to speed up queries where we only search a specific user's chunks

  @@index(\[sessionId\])

  @@map("document\_chunks")

}

// \------------------------------------------------------

// TABLE 3: Message (The Chat History)

// \------------------------------------------------------

model Message {

  id          String   @id @default(dbgenerated("gen\_random\_uuid()")) @db.Uuid

  sessionId   String   @map("session\_id")

  role        String   // Strictly "user" or "assistant"

  content     String   // The text of the message

  citations   Json?    // Optional: Array of DocumentChunk IDs used to generate this answer

  createdAt   DateTime @default(now()) @map("created\_at")

  // Link back to the session

  session     Session  @relation(fields: \[sessionId\], references: \[id\], onDelete: Cascade)

  // Indexed by session and time to make the "Sliding Window" query ultra-fast

  @@index(\[sessionId, createdAt(sort: Asc)\]) 

  @@map("messages")

}

Mandatory SQL Migration: does not know how to generate the advanced mathematical indexes, append this exact SQL before applying the migration

\-- 1\. Create the HNSW index for ultra-fast Dense Vector Search (Cosine Distance)

CREATE INDEX document\_chunks\_embedding\_idx 

ON document\_chunks USING hnsw (embedding vector\_cosine\_ops);

\-- 2\. Create the GIN index for ultra-fast Full-Text Search (Keywords)

CREATE INDEX document\_chunks\_search\_idx 

ON document\_chunks USING GIN (search\_vector);

\-- 3\. Create a Postgres Trigger to automatically build the tsvector whenever you insert text

CREATE FUNCTION tsvector\_update\_trigger() RETURNS trigger AS $$

BEGIN

  NEW.search\_vector := to\_tsvector('pg\_catalog.english', NEW.content);

  RETURN NEW;

END

$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvectorupdate 

BEFORE INSERT OR UPDATE ON document\_chunks 

FOR EACH ROW EXECUTE FUNCTION tsvector\_update\_trigger();

# **6\. Testing**

## **6.1 Deterministic Testing (The Code)**

These tests validate that standard engineering logic works. They execute in milliseconds and should block any pull request if they fail.

**Target Coverage:** **85% global coverage** for business logic, with **100% coverage** required for core RAG utilities (chunking, embedding formatting, and prompt assembly).

1. RAG-Specific Unit Tests (Mock external APIs):   
   1. **The Chunking Engine:**  
* *Test:* The `RecursiveCharacterTextSplitter` logic will be tested against strict edge cases to ensure the background worker never crashes. Test cases include:  
  * Empty documents (`""`).  
  * Single-character documents.  
  * Massive, unbroken text blocks (no spaces or newlines).  
  * Documents containing only images/tables (testing fallback handling).  
* *Assert:* It does not crash, and it returns arrays of strings within your specified token limits.  
  2. **Prompt Assembly:** \* *Test:* Pass a mock user prompt, mock database chunks, and mock history into your `ChatService`.  
     * *Assert:* The final string array strictly follows the "Safety Caboose" pattern, with the anti-injection system prompt sitting at the very end of the array.  
  3. **LangGraph Routing:** Mock `gpt-4o-mini` to simply return the string `RAG_QUERY`.  
     * *Assert:* LangGraph successfully transitions to the Retrieval Node and does not fall back to the Greeting Node.  
2. Database & Vector Integration Tests:  
   1. The Hybrid Search:  
      * *Test:* Execute your `HybridSearch` Prisma query for "Alpha".  
      * *Assert:* The database returns the 5 chunks, and chunk \#1 has the highest cosine similarity score.  
   2. Cascading Deletes:   
      * *Test:* Programmatically upload a document, verify chunks exist, then delete the parent document ID.  
      * *Assert:* The `document_chunks` table for that session is completely empty (proving no orphaned vectors are left behind to pollute the context).

## **6.2 Non-Deterministic Testing (The AI Evals)**

mathematically prove bot is accurate

1. Creating the "Golden Dataset": You create a static JSON file containing 50 carefully chosen questions, the *expected* chunks that should answer them, and the *ideal* human-written answer.  
2. Retrieval Evaluation : evaluate the database. If the database grabs the wrong data, the LLM is guaranteed to fail.  
   * *Test:* Run the 50 Golden questions through your retrieval function.  
   * *Metric (Context Precision):* Did the exact chunk that contains the answer appear in the Top 5 results?  
   * *Threshold:* Must be \> 95%. If it fails, pgvector weights (dense vs. sparse) are wrong.  
3. Generation Evaluation : Run the 50 Golden questions through the full pipeline (retrieval \+ generation). Use an LLM-as-a-Judge to score the output.  
   * *Metric 1 (Faithfulness / Anti-Hallucination):* Does the generated answer contain *only* facts found in the retrieved chunks? (Threshold: 100%. Zero tolerance for outside knowledge).  
   * *Metric 2 (Answer Relevance):* Did the bot actually answer the user's question, or did it dodge it? (Threshold: \> 90%).

## **6.3 LLM Output & Citation Tests (Groundedness)**

These tests ensure the application safely and accurately handles the final LLM response and properly attributes facts to the database.

* **Mocked Generation:** Mock the LLM to return a predefined response that includes citations (e.g., *"Revenue was $5M \[chunk\_123\]."*).  
* **Assertion:** Verify that the backend parser correctly extracts the citation, links it to the retrieved metadata, and formats the payload correctly for the Next.js frontend.  
* **Guardrail Testing:** Inject a mocked LLM hallucination and verify that the system's defensive prompts or output parsers successfully catch or flag the ungrounded statement.

## **6.4 CI/CD Execution Strategy (The Pipeline)**

1. On Pre-Commit (Local): Runs only Unit Tests  
2. On Pull Request:   
   1. Runs Unit \+ Integration tests.  
   2. Runs a *mini* Eval (10 Golden Questions) to catch obvious prompt regressions. Blocks merge if the Eval score drops below 90%  
3. Nightly Build (Cron): Runs the full 50+ question Golden Dataset Eval