import { Injectable } from '@nestjs/common';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RAGState } from './types/rag-state.types';
import { GREETING_SYSTEM_PROMPT } from './prompts/greeting-prompt';
import { RAG_SYSTEM_PROMPT } from './prompts/system-prompt';

/**
 * Assembles the LangChain message array for each LLM call.
 *
 * Safety Caboose order (CLAUDE.md non-negotiable):
 *   [sliding window — alternating HumanMessage/AIMessage, ghost system messages excluded]
 *   [HumanMessage: retrieved context chunks]  ← RAG_QUERY only
 *   [HumanMessage: current user question]
 *   [SystemMessage: grounding instructions]   ← LAST
 *
 * Placing the SystemMessage last prevents injected text in retrieved document chunks
 * (or in prior conversation turns) from overriding the grounding constraints.
 */
@Injectable()
export class PromptBuilderService {
  /**
   * Builds the ordered message array for the generator LLM call.
   *
   * @param state - Current RAG pipeline state (route, slidingWindow, chunks, userQuery).
   * @returns Ordered BaseMessage array ready to be passed to the OpenAI chat completions API.
   */
  buildMessages(state: RAGState): BaseMessage[] {
    const messages: BaseMessage[] = [];

    // 1. Sliding window conversation history (chronological order).
    //    Ghost messages (role='system') are internal pipeline directives — never forwarded.
    for (const msg of state.slidingWindow) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else if (msg.role === 'assistant') {
        messages.push(new AIMessage(msg.content));
      }
      // system-role ghost messages intentionally excluded
    }

    // 2. Retrieved context chunks (RAG_QUERY route only).
    if (state.route === 'RAG_QUERY' && state.chunks.length > 0) {
      const contextText = state.chunks
        .map((chunk, i) => {
          const page = this.extractPageNumber(chunk.metadata);
          const header = page
            ? `[Source ${i + 1}] — ${chunk.filename}, page ${page}`
            : `[Source ${i + 1}] — ${chunk.filename}`;
          return `${header}\n${chunk.content}`;
        })
        .join('\n\n');
      messages.push(new HumanMessage(`Context from uploaded documents:\n\n${contextText}`));
    }

    // 3. Current user question.
    messages.push(new HumanMessage(state.userQuery));

    // 4. System prompt — LAST (Safety Caboose).
    const systemPrompt =
      state.route === 'GREETING' ? GREETING_SYSTEM_PROMPT : RAG_SYSTEM_PROMPT;
    messages.push(new SystemMessage(systemPrompt));

    return messages;
  }

  /**
   * Extracts a page number from LangChain chunk metadata.
   * PDFLoader stores it as `loc.pageNumber`; older loaders use a flat `page` field.
   */
  private extractPageNumber(metadata: Record<string, unknown> | null): number | undefined {
    if (!metadata) return undefined;
    const loc = metadata.loc as { pageNumber?: number } | undefined;
    if (loc?.pageNumber !== undefined) return loc.pageNumber;
    if (typeof metadata.page === 'number') return metadata.page;
    return undefined;
  }
}
