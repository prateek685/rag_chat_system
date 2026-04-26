// jest.mock is hoisted before imports. Factory must be self-contained — no outer const refs.
jest.mock('langfuse', () => ({
  __esModule: true,
  default: jest.fn(),
}));

import Langfuse from 'langfuse';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { LangfuseService } from './langfuse.service';

/** Returns the plain object given back by the most recent `new Langfuse()` call. */
const getMockClient = (): {
  trace: jest.Mock;
  score: jest.Mock;
  flushAsync: jest.Mock;
} =>
  (Langfuse as jest.MockedClass<typeof Langfuse>).mock.results[0]
    .value as unknown as { trace: jest.Mock; score: jest.Mock; flushAsync: jest.Mock };

describe('LangfuseService', () => {
  let service: LangfuseService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        LANGFUSE_PUBLIC_KEY: 'pk-test',
        LANGFUSE_SECRET_KEY: 'sk-test',
        LANGFUSE_HOST: 'http://localhost:3000',
      };
      return map[key] ?? '';
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Each test gets fresh mock functions via mockImplementation.
    // mock.results[0].value after compile() holds the plain object LangfuseService uses as client.
    const mockSpanEnd = jest.fn();
    const mockSpanCreate = jest.fn().mockReturnValue({ end: mockSpanEnd });
    const mockTraceUpdate = jest.fn();
    const mockTraceCreate = jest.fn().mockReturnValue({
      id: 'trace-123',
      span: mockSpanCreate,
      update: mockTraceUpdate,
    });
    const mockScore = jest.fn().mockResolvedValue(undefined);
    const mockFlushAsync = jest.fn().mockResolvedValue(undefined);

    (Langfuse as jest.MockedClass<typeof Langfuse>).mockImplementation(
      () =>
        ({
          trace: mockTraceCreate,
          score: mockScore,
          flushAsync: mockFlushAsync,
        }) as unknown as Langfuse,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LangfuseService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<LangfuseService>(LangfuseService);
  });

  describe('createTrace', () => {
    it('calls langfuse.trace() with correct params', () => {
      service.createTrace({
        name: 'chat',
        sessionId: 'session-abc',
        input: 'hello world',
        tags: ['retry'],
      });

      expect(getMockClient().trace).toHaveBeenCalledWith({
        name: 'chat',
        sessionId: 'session-abc',
        input: 'hello world',
        tags: ['retry'],
      });
    });

    it('returns the trace client (non-null) on success', () => {
      const result = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      expect(result).not.toBeNull();
      expect(result?.id).toBe('trace-123');
    });

    it('returns null and does not throw when SDK.trace() throws', () => {
      getMockClient().trace.mockImplementationOnce(() => {
        throw new Error('Langfuse unavailable');
      });

      let result: ReturnType<LangfuseService['createTrace']>;
      expect(() => {
        result = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      }).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result!).toBeNull();
    });
  });

  describe('createSpan', () => {
    it('calls trace.span() and returns the span', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      const span = service.createSpan(trace, { name: 'router', input: 'test query' });
      expect(span).not.toBeNull();
    });

    it('returns null when trace is null without throwing', () => {
      const span = service.createSpan(null, { name: 'router' });
      expect(span).toBeNull();
    });
  });

  describe('finalizeSpan', () => {
    it('does not throw when span is null', () => {
      expect(() => service.finalizeSpan(null, 'output')).not.toThrow();
    });
  });

  describe('score', () => {
    it('calls langfuse.score() with traceId, name=user-feedback, and value', async () => {
      await service.score('trace-abc', 1);
      expect(getMockClient().score).toHaveBeenCalledWith({
        traceId: 'trace-abc',
        name: 'user-feedback',
        value: 1,
      });
    });

    it('does not throw when SDK.score() rejects', async () => {
      getMockClient().score.mockRejectedValueOnce(new Error('network error'));
      await expect(service.score('trace-abc', -1)).resolves.toBeUndefined();
    });
  });

  describe('finalizeTrace', () => {
    it('calls trace.update() with output and metadata', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      service.finalizeTrace(trace, 'The answer is 42.', { e2eLatencyMs: 500, route: 'RAG_QUERY' });
      expect(getMockClient().trace.mock.results[0].value.update).toHaveBeenCalledWith({
        output: 'The answer is 42.',
        metadata: { e2eLatencyMs: 500, route: 'RAG_QUERY' },
      });
    });

    it('calls trace.update() with only output when metadata is omitted', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      service.finalizeTrace(trace, 'The answer is 42.');
      expect(getMockClient().trace.mock.results[0].value.update).toHaveBeenCalledWith({
        output: 'The answer is 42.',
        metadata: undefined,
      });
    });

    it('does not throw when trace is null', () => {
      expect(() => service.finalizeTrace(null, 'response')).not.toThrow();
    });
  });

  describe('createGeneration', () => {
    it('calls trace.generation() with name, model, input, and modelParameters', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      // The mock trace returned by getMockClient().trace() needs a generation() method.
      const mockGenerationEnd = jest.fn();
      const mockGenerationClient = { end: mockGenerationEnd };
      (getMockClient().trace.mock.results[0].value as Record<string, jest.Mock>).generation =
        jest.fn().mockReturnValue(mockGenerationClient);

      const gen = service.createGeneration(trace, {
        name: 'router',
        model: 'gpt-4o-mini',
        input: 'classify this',
        modelParameters: { temperature: 0 },
      });

      expect(
        (getMockClient().trace.mock.results[0].value as Record<string, jest.Mock>).generation,
      ).toHaveBeenCalledWith({
        name: 'router',
        model: 'gpt-4o-mini',
        input: 'classify this',
        modelParameters: { temperature: 0 },
      });
      expect(gen).not.toBeNull();
    });

    it('returns null without throwing when trace is null', () => {
      expect(() => service.createGeneration(null, { name: 'router', model: 'm', input: 'q' })).not.toThrow();
      expect(service.createGeneration(null, { name: 'router', model: 'm', input: 'q' })).toBeNull();
    });

    it('returns null without throwing when SDK.generation() throws', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      (getMockClient().trace.mock.results[0].value as Record<string, jest.Mock>).generation =
        jest.fn().mockImplementationOnce(() => { throw new Error('SDK error'); });

      let result: ReturnType<LangfuseService['createGeneration']>;
      expect(() => {
        result = service.createGeneration(trace, { name: 'router', model: 'm', input: 'q' });
      }).not.toThrow();
      expect(result!).toBeNull();
    });
  });

  describe('finalizeGeneration', () => {
    it('calls generation.end() with output, usage, and metadata', () => {
      const mockEnd = jest.fn();
      const mockGeneration = { end: mockEnd } as unknown as import('langfuse').LangfuseGenerationClient;

      service.finalizeGeneration(mockGeneration, {
        output: { route: 'RAG_QUERY' },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        metadata: { latencyMs: 200 },
      });

      expect(mockEnd).toHaveBeenCalledWith({
        output: { route: 'RAG_QUERY' },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        metadata: { latencyMs: 200 },
      });
    });

    it('does not throw when generation is null', () => {
      expect(() => service.finalizeGeneration(null, { output: 'test' })).not.toThrow();
    });

    it('calls generation.end() with undefined usage when usage is omitted', () => {
      const mockEnd = jest.fn();
      const mockGeneration = { end: mockEnd } as unknown as import('langfuse').LangfuseGenerationClient;
      service.finalizeGeneration(mockGeneration, { output: 'out' });
      expect(mockEnd).toHaveBeenCalledWith(
        expect.objectContaining({ usage: undefined }),
      );
    });
  });

  describe('recordTraceError', () => {
    it('calls trace.update() with errorType and errorMessage in metadata', () => {
      const trace = service.createTrace({ name: 'chat', sessionId: 's', input: 'q' });
      service.recordTraceError(trace, 'llm_pipeline_failure', 'timeout after 30s');
      expect(getMockClient().trace.mock.results[0].value.update).toHaveBeenCalledWith({
        metadata: { errorType: 'llm_pipeline_failure', errorMessage: 'timeout after 30s' },
      });
    });

    it('does not throw when trace is null', () => {
      expect(() => service.recordTraceError(null, 'some_error', 'msg')).not.toThrow();
    });
  });
});
