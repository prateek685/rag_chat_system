import { Test, TestingModule } from '@nestjs/testing';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { PromptBuilderService } from './prompt-builder.service';
import { RAGState } from './types/rag-state.types';

const BASE_STATE: RAGState = {
  sessionId: 'sess-1',
  userQuery: 'What is attention?',
  queryEmbedding: [],
  route: 'RAG_QUERY',
  chunks: [],
  slidingWindow: [],
  runningSummary: null,
  fullResponse: '',
  traceId: 'trace-1',
  skipCache: false,
  temperature: 0.7,
};

function makeState(overrides: Partial<RAGState> = {}): RAGState {
  return { ...BASE_STATE, ...overrides };
}

describe('PromptBuilderService', () => {
  let service: PromptBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PromptBuilderService],
    }).compile();
    service = module.get(PromptBuilderService);
  });

  describe('buildMessages() — message order (Safety Caboose)', () => {
    it('places system prompt last for RAG_QUERY', () => {
      const msgs = service.buildMessages(makeState());
      expect(msgs[msgs.length - 1]).toBeInstanceOf(SystemMessage);
    });

    it('places system prompt last for GREETING', () => {
      const msgs = service.buildMessages(makeState({ route: 'GREETING' }));
      expect(msgs[msgs.length - 1]).toBeInstanceOf(SystemMessage);
    });

    it('places context immediately before the user query for RAG_QUERY', () => {
      const chunk = {
        id: 'c1', content: 'attention is all you need', documentId: 'd1',
        filename: 'paper.pdf', rrfScore: 0.05, cosineSimilarity: 0.8, metadata: null,
      };
      const msgs = service.buildMessages(makeState({ chunks: [chunk] }));
      const systemIdx = msgs.length - 1;
      const queryIdx = systemIdx - 1;
      const contextIdx = queryIdx - 1;

      expect(msgs[queryIdx]).toBeInstanceOf(HumanMessage);
      expect((msgs[queryIdx] as HumanMessage).content).toBe('What is attention?');
      expect(msgs[contextIdx]).toBeInstanceOf(HumanMessage);
      expect((msgs[contextIdx] as HumanMessage).content).toContain('Context from uploaded documents');
    });
  });

  describe('buildMessages() — duplicate query fix', () => {
    it('does NOT duplicate the current query when it is the only entry in the sliding window', () => {
      const state = makeState({
        userQuery: 'What is attention?',
        slidingWindow: [{ role: 'user', content: 'What is attention?' }],
      });
      const msgs = service.buildMessages(state);
      const userMsgs = msgs.filter(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content === 'What is attention?',
      );
      expect(userMsgs).toHaveLength(1);
    });

    it('does NOT duplicate the current query when window has full history', () => {
      const state = makeState({
        userQuery: 'What is dropout?',
        slidingWindow: [
          { role: 'user', content: 'What is attention?' },
          { role: 'assistant', content: 'Attention is a mechanism...' },
          { role: 'user', content: 'What is dropout?' },
        ],
      });
      const msgs = service.buildMessages(state);
      const queryMsgs = msgs.filter(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content === 'What is dropout?',
      );
      expect(queryMsgs).toHaveLength(1);
    });

    it('includes prior history messages that precede the current query', () => {
      const state = makeState({
        userQuery: 'What is dropout?',
        slidingWindow: [
          { role: 'user', content: 'What is attention?' },
          { role: 'assistant', content: 'Attention is a mechanism...' },
          { role: 'user', content: 'What is dropout?' },
        ],
      });
      const msgs = service.buildMessages(state);
      const contents = msgs.map((m) =>
        typeof m.content === 'string' ? m.content : '',
      );
      expect(contents).toContain('What is attention?');
      expect(contents).toContain('Attention is a mechanism...');
    });
  });

  describe('buildMessages() — orphaned assistant turn fix', () => {
    it('trims a leading assistant message from history', () => {
      const state = makeState({
        userQuery: 'What is dropout?',
        slidingWindow: [
          // window slice starts with assistant (orphaned turn)
          { role: 'assistant', content: 'Prior orphaned answer.' },
          { role: 'user', content: 'What is attention?' },
          { role: 'assistant', content: 'Attention is...' },
          { role: 'user', content: 'What is dropout?' },
        ],
      });
      const msgs = service.buildMessages(state);
      expect(msgs[0]).toBeInstanceOf(HumanMessage);
      expect((msgs[0] as HumanMessage).content).toBe('What is attention?');
    });

    it('trims multiple leading assistant messages', () => {
      const state = makeState({
        userQuery: 'Q3',
        slidingWindow: [
          { role: 'assistant', content: 'A0' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
          { role: 'user', content: 'Q3' },
        ],
      });
      const msgs = service.buildMessages(state);
      expect(msgs[0]).toBeInstanceOf(HumanMessage);
      expect((msgs[0] as HumanMessage).content).toBe('Q2');
    });
  });

  describe('buildMessages() — empty / first message', () => {
    it('handles empty sliding window (first ever message)', () => {
      const msgs = service.buildMessages(makeState({ slidingWindow: [] }));
      // Only current query + system prompt
      const userMsgs = msgs.filter((m) => m instanceof HumanMessage);
      expect(userMsgs).toHaveLength(1);
      expect((userMsgs[0] as HumanMessage).content).toBe('What is attention?');
    });

    it('excludes context block when chunks are empty for RAG_QUERY', () => {
      const msgs = service.buildMessages(makeState({ chunks: [] }));
      const contextMsg = msgs.find(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content.startsWith('Context from uploaded documents'),
      );
      expect(contextMsg).toBeUndefined();
    });
  });

  describe('buildMessages() — context block', () => {
    it('labels sources starting at [Source 1]', () => {
      const chunks = [
        { id: 'c1', content: 'chunk one', documentId: 'd1', filename: 'a.pdf', rrfScore: 0.1, cosineSimilarity: 0.9, metadata: null },
        { id: 'c2', content: 'chunk two', documentId: 'd1', filename: 'a.pdf', rrfScore: 0.09, cosineSimilarity: 0.8, metadata: null },
      ];
      const msgs = service.buildMessages(makeState({ chunks }));
      const context = msgs.find(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content.startsWith('Context from uploaded documents'),
      ) as HumanMessage;
      expect(context.content).toContain('[Source 1]');
      expect(context.content).toContain('[Source 2]');
    });

    it('includes page number in source header when metadata provides it', () => {
      const chunks = [
        {
          id: 'c1', content: 'chunk', documentId: 'd1', filename: 'paper.pdf',
          rrfScore: 0.1, cosineSimilarity: 0.9, metadata: { loc: { pageNumber: 4 } },
        },
      ];
      const msgs = service.buildMessages(makeState({ chunks }));
      const context = msgs.find(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content.startsWith('Context from uploaded documents'),
      ) as HumanMessage;
      expect(context.content).toContain('page 4');
    });

    it('omits context block for GREETING route even when chunks exist', () => {
      const chunk = {
        id: 'c1', content: 'some text', documentId: 'd1', filename: 'a.pdf',
        rrfScore: 0.1, cosineSimilarity: 0.9, metadata: null,
      };
      const msgs = service.buildMessages(makeState({ route: 'GREETING', chunks: [chunk] }));
      const contextMsg = msgs.find(
        (m) => m instanceof HumanMessage &&
          (m as HumanMessage).content.startsWith('Context from uploaded documents'),
      );
      expect(contextMsg).toBeUndefined();
    });
  });

  describe('buildMessages() — PDF table content preservation', () => {
    it('passes merged PDF table data verbatim into the context message without modification', () => {
      // Reproduces the data shape from trace 0fb23d8c: PDF extractor merges column values
      // into a single string with no delimiters. The prompt builder must not alter this —
      // any stripping or normalisation here silently removes the answer before it reaches the model.
      const pdfTableChunk = {
        id: 'c1',
        content: 'Table 3: Variations on the Transformer architecture.\nbase65122048864640.10.1100K4.9225.865\n(B)\n165.1625.158\n325.0125.460',
        documentId: 'd1', filename: '1706.03762v7.pdf',
        rrfScore: 0.016, cosineSimilarity: 0.525, metadata: null,
      };
      const msgs = service.buildMessages(makeState({ chunks: [pdfTableChunk] }));
      const context = msgs.find(
        (m) => m instanceof HumanMessage &&
          typeof m.content === 'string' &&
          m.content.startsWith('Context from uploaded documents'),
      ) as HumanMessage;

      expect(context.content).toContain('base65122048864640.10.1100K4.9225.865');
      expect(context.content).toContain('165.1625.158');
      expect(context.content).toContain('325.0125.460');
    });

    it('places the PDF table chunk as [Source 1] when it is the top-ranked result', () => {
      const pdfTableChunk = {
        id: 'c1',
        content: 'Table 3 rows (B)\n165.1625.158\n325.0125.460',
        documentId: 'd1', filename: '1706.03762v7.pdf',
        rrfScore: 0.016, cosineSimilarity: 0.525, metadata: { loc: { pageNumber: 9 } },
      };
      const msgs = service.buildMessages(makeState({ chunks: [pdfTableChunk] }));
      const context = msgs.find(
        (m) => m instanceof HumanMessage &&
          typeof m.content === 'string' &&
          m.content.startsWith('Context from uploaded documents'),
      ) as HumanMessage;

      expect(context.content).toContain('[Source 1] — 1706.03762v7.pdf, page 9');
      expect(context.content).toContain('165.1625.158');
    });
  });

  describe('buildMessages() — message type mapping', () => {
    it('maps user history to HumanMessage', () => {
      const state = makeState({
        userQuery: 'Q2',
        slidingWindow: [
          { role: 'user', content: 'Q1' },
          { role: 'user', content: 'Q2' },
        ],
      });
      const msgs = service.buildMessages(state);
      expect(msgs[0]).toBeInstanceOf(HumanMessage);
    });

    it('maps assistant history to AIMessage', () => {
      const state = makeState({
        userQuery: 'Q2',
        slidingWindow: [
          { role: 'user', content: 'Q1' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
        ],
      });
      const msgs = service.buildMessages(state);
      expect(msgs[1]).toBeInstanceOf(AIMessage);
    });

    it('excludes system-role ghost messages from history', () => {
      const state = makeState({
        userQuery: 'Q2',
        slidingWindow: [
          { role: 'user', content: 'Q1' },
          { role: 'system', content: 'internal ghost directive' },
          { role: 'user', content: 'Q2' },
        ],
      });
      const msgs = service.buildMessages(state);
      const ghostMsg = msgs.find(
        (m) => m instanceof SystemMessage &&
          (m as SystemMessage).content === 'internal ghost directive',
      );
      expect(ghostMsg).toBeUndefined();
    });
  });
});
