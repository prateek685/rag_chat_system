import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RagGraphService } from './graph/rag-graph.service';
import { GeneratorNodeService } from './nodes/generator.node';
import { RetrievalNodeService } from './nodes/retrieval.node';
import { RouterNodeService } from './nodes/router.node';
import { PromptBuilderService } from './prompt-builder.service';

@Module({
  imports: [ObservabilityModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    PromptBuilderService,
    RagGraphService,
    RouterNodeService,
    RetrievalNodeService,
    GeneratorNodeService,
  ],
})
export class ChatModule {}
