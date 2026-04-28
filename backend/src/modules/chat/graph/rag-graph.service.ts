import { Injectable, Logger } from '@nestjs/common';
import { END, START, StateGraph } from '@langchain/langgraph';
import { LangfuseTraceClient } from 'langfuse';
import { GeneratorNodeService } from '../nodes/generator.node';
import { RetrievalNodeService } from '../nodes/retrieval.node';
import { RouterNodeService } from '../nodes/router.node';
import { RAGState, RAGStateAnnotation, WriteTokenFn } from '../types/rag-state.types';

/**
 * RagGraphService builds and executes the LangGraph RAG pipeline per request.
 *
 * Graph topology:
 *   START → RouterNode
 *   RouterNode → VIOLATION: END | GREETING: GeneratorNode | RAG_QUERY: RetrievalNode
 *   RetrievalNode → NO_CONTEXT: END | continue: GeneratorNode
 *   GeneratorNode → END
 *
 * The graph is rebuilt on every execute() call because the writeToken closure
 * is request-scoped and cannot be cached at the class level. compile() overhead is ~1ms.
 *
 * writeToken and Langfuse trace are passed via closure — NOT stored in LangGraph state —
 * to keep state serializable and satisfy TypeScript strict mode.
 */
@Injectable()
export class RagGraphService {
  private readonly logger = new Logger(RagGraphService.name);

  constructor(
    private readonly routerNode: RouterNodeService,
    private readonly retrievalNode: RetrievalNodeService,
    private readonly generatorNode: GeneratorNodeService,
  ) {}

  /**
   * Executes the RAG LangGraph for a single chat turn.
   *
   * @param initialState - Pre-populated state from ChatService (sessionId, userQuery, queryEmbedding, etc.).
   * @param writeToken - SSE write callback — called by GeneratorNode for each streamed token.
   * @param trace - Langfuse trace for this request (may be null if Langfuse is unavailable).
   * @returns Final RAG state after graph execution completes.
   */
  async execute(
    initialState: Partial<RAGState>,
    writeToken: WriteTokenFn,
    trace: LangfuseTraceClient | null,
  ): Promise<RAGState> {
    const graph = new StateGraph(RAGStateAnnotation)
      .addNode('RouterNode', (state: RAGState) => this.routerNode.execute(state, trace))
      .addNode('RetrievalNode', (state: RAGState) => this.retrievalNode.execute(state, trace))
      .addNode('GeneratorNode', (state: RAGState) =>
        this.generatorNode.execute(state, writeToken, trace),
      )
      .addEdge(START, 'RouterNode')
      .addConditionalEdges(
        'RouterNode',
        (state: RAGState) => {
          if (state.route === 'VIOLATION') return 'violation';
          if (state.route === 'GREETING') return 'greeting';
          return 'rag';
        },
        {
          violation: END,
          greeting: 'GeneratorNode',
          rag: 'RetrievalNode',
        },
      )
      .addConditionalEdges(
        'RetrievalNode',
        (state: RAGState) => (state.route === 'NO_CONTEXT' ? 'no_context' : 'continue'),
        {
          no_context: END,
          continue: 'GeneratorNode',
        },
      )
      .addEdge('GeneratorNode', END)
      .compile();

    this.logger.log({ event: 'graph_start', sessionId: initialState.sessionId });
    const finalState = await graph.invoke(initialState as RAGState);
    this.logger.log({
      event: 'graph_complete',
      sessionId: initialState.sessionId,
      route: (finalState as RAGState).route,
    });

    return finalState as RAGState;
  }
}
