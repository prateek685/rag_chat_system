jest.mock('langfuse', () => ({ Langfuse: jest.fn() }));
jest.mock('@langchain/langgraph', () => {
  const actual = jest.requireActual('@langchain/langgraph');
  const compiledGraph = { invoke: jest.fn() };
  const mockGraph = {
    addNode: jest.fn().mockReturnThis(),
    addEdge: jest.fn().mockReturnThis(),
    addConditionalEdges: jest.fn().mockReturnThis(),
    compile: jest.fn().mockReturnValue(compiledGraph),
  };
  return {
    ...actual,
    StateGraph: jest.fn().mockImplementation(() => mockGraph),
    compiledGraph,
    mockGraph,
  };
});

import { Test, TestingModule } from '@nestjs/testing';
import { RagGraphService } from './rag-graph.service';
import { RouterNodeService } from '../nodes/router.node';
import { RetrievalNodeService } from '../nodes/retrieval.node';
import { GeneratorNodeService } from '../nodes/generator.node';
import { RAGState } from '../types/rag-state.types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compiledGraph, mockGraph } = require('@langchain/langgraph');

function makeInitialState(overrides: Partial<RAGState> = {}): Partial<RAGState> {
  return {
    sessionId: 'session-1',
    userQuery: 'What is the SLA?',
    queryEmbedding: [],
    route: null,
    chunks: [],
    slidingWindow: [],
    runningSummary: null,
    fullResponse: '',
    traceId: 'trace-1',
    skipCache: false,
    temperature: 0.7,
    ...overrides,
  };
}

describe('RagGraphService', () => {
  let service: RagGraphService;
  let routerNode: { execute: jest.Mock };
  let retrievalNode: { execute: jest.Mock; embedQuery: jest.Mock };
  let generatorNode: { execute: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagGraphService,
        {
          provide: RouterNodeService,
          useValue: { execute: jest.fn() },
        },
        {
          provide: RetrievalNodeService,
          useValue: { execute: jest.fn(), embedQuery: jest.fn() },
        },
        {
          provide: GeneratorNodeService,
          useValue: { execute: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(RagGraphService);
    routerNode = module.get(RouterNodeService) as unknown as typeof routerNode;
    retrievalNode = module.get(RetrievalNodeService) as unknown as typeof retrievalNode;
    generatorNode = module.get(GeneratorNodeService) as unknown as typeof generatorNode;
  });

  it('returns the final state from graph.invoke()', async () => {
    const finalState: RAGState = {
      sessionId: 'session-1',
      userQuery: 'What is the SLA?',
      queryEmbedding: [],
      route: 'RAG_QUERY',
      chunks: [],
      slidingWindow: [],
      runningSummary: null,
      fullResponse: 'The SLA is 99.9%.',
      traceId: 'trace-1',
      skipCache: false,
      temperature: 0.7,
    };
    compiledGraph.invoke.mockResolvedValueOnce(finalState);

    const result = await service.execute(makeInitialState(), jest.fn(), null);

    expect(result.fullResponse).toBe('The SLA is 99.9%.');
    expect(compiledGraph.invoke).toHaveBeenCalledTimes(1);
  });

  it('builds a new graph on every execute() call', async () => {
    const { StateGraph } = require('@langchain/langgraph');
    compiledGraph.invoke.mockResolvedValue({ route: 'GREETING', fullResponse: 'Hi!' });

    await service.execute(makeInitialState(), jest.fn(), null);
    await service.execute(makeInitialState(), jest.fn(), null);

    expect(StateGraph).toHaveBeenCalledTimes(2);
  });

  it('passes the initial state directly to graph.invoke()', async () => {
    const state = makeInitialState({ userQuery: 'Tell me about clause 5.' });
    compiledGraph.invoke.mockResolvedValueOnce({ ...state, route: 'RAG_QUERY', fullResponse: 'Clause 5 says...' });

    await service.execute(state, jest.fn(), null);

    expect(compiledGraph.invoke).toHaveBeenCalledWith(state);
  });

  it('propagates errors thrown by graph.invoke()', async () => {
    compiledGraph.invoke.mockRejectedValueOnce(new Error('graph execution failed'));

    await expect(service.execute(makeInitialState(), jest.fn(), null)).rejects.toThrow(
      'graph execution failed',
    );
  });

  // ── Conditional edge routing ──────────────────────────────────────────────
  // Exercises the inline lambdas registered via addConditionalEdges so that
  // all route branches are covered.

  describe('RouterNode conditional edges', () => {
    let routerEdgeFn: (state: Partial<RAGState>) => string;

    beforeEach(async () => {
      compiledGraph.invoke.mockResolvedValueOnce({ route: 'RAG_QUERY', fullResponse: '' });
      await service.execute(makeInitialState(), jest.fn(), null);
      // addConditionalEdges call[0] is for RouterNode
      routerEdgeFn = mockGraph.addConditionalEdges.mock.calls[0][1] as (state: Partial<RAGState>) => string;
    });

    it('routes VIOLATION to "violation"', () => {
      expect(routerEdgeFn({ route: 'VIOLATION' })).toBe('violation');
    });

    it('routes GREETING to "greeting"', () => {
      expect(routerEdgeFn({ route: 'GREETING' })).toBe('greeting');
    });

    it('routes RAG_QUERY to "rag"', () => {
      expect(routerEdgeFn({ route: 'RAG_QUERY' })).toBe('rag');
    });

    it('routes null/unknown route to "rag" as the default', () => {
      expect(routerEdgeFn({ route: null })).toBe('rag');
    });
  });

  describe('RetrievalNode conditional edges', () => {
    let retrievalEdgeFn: (state: Partial<RAGState>) => string;

    beforeEach(async () => {
      compiledGraph.invoke.mockResolvedValueOnce({ route: 'RAG_QUERY', fullResponse: '' });
      await service.execute(makeInitialState(), jest.fn(), null);
      // addConditionalEdges call[1] is for RetrievalNode
      retrievalEdgeFn = mockGraph.addConditionalEdges.mock.calls[1][1] as (state: Partial<RAGState>) => string;
    });

    it('routes NO_CONTEXT to "no_context"', () => {
      expect(retrievalEdgeFn({ route: 'NO_CONTEXT' })).toBe('no_context');
    });

    it('routes any other state to "continue"', () => {
      expect(retrievalEdgeFn({ route: 'RAG_QUERY' })).toBe('continue');
    });
  });

  // ── Node callbacks ────────────────────────────────────────────────────────
  // Exercises the arrow functions passed to addNode, verifying each one
  // delegates to the correct node service with the right arguments.

  describe('node callbacks', () => {
    const trace = null;

    beforeEach(async () => {
      compiledGraph.invoke.mockResolvedValueOnce({ route: 'RAG_QUERY', fullResponse: '' });
      await service.execute(makeInitialState(), jest.fn(), trace);
    });

    it('RouterNode callback delegates to routerNode.execute(state, trace)', async () => {
      const routerNodeFn = mockGraph.addNode.mock.calls[0][1] as (s: RAGState) => unknown;
      const state = makeInitialState() as RAGState;
      await routerNodeFn(state);
      expect(routerNode.execute).toHaveBeenCalledWith(state, trace);
    });

    it('RetrievalNode callback delegates to retrievalNode.execute(state, trace)', async () => {
      const retrievalNodeFn = mockGraph.addNode.mock.calls[1][1] as (s: RAGState) => unknown;
      const state = makeInitialState() as RAGState;
      await retrievalNodeFn(state);
      expect(retrievalNode.execute).toHaveBeenCalledWith(state, trace);
    });

    it('GeneratorNode callback delegates to generatorNode.execute(state, writeToken, trace)', async () => {
      const writeToken = jest.fn();
      // Re-run execute with a known writeToken to capture it in the GeneratorNode closure
      jest.clearAllMocks();
      compiledGraph.invoke.mockResolvedValueOnce({ route: 'RAG_QUERY', fullResponse: '' });
      await service.execute(makeInitialState(), writeToken, trace);

      const generatorNodeFn = mockGraph.addNode.mock.calls[2][1] as (s: RAGState) => unknown;
      const state = makeInitialState() as RAGState;
      await generatorNodeFn(state);
      expect(generatorNode.execute).toHaveBeenCalledWith(state, writeToken, trace);
    });
  });
});
