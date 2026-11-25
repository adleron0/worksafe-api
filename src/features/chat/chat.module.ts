import { Module } from '@nestjs/common';
import { PrivateStorageModule } from 'src/common/storage/module';
import { BotsAiModule } from 'src/features/ai/ai.module';
import { ChatController } from './chat.controller';
import { ChatChannelsService } from './chat-channels.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatEventsService } from './chat-events.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatInstagramService } from './chat-instagram.service';
import { ChatCustomerService } from './chat-customer.service';
import { ChatLibraryService } from './chat-library.service';
import { ChatMediaService } from './chat-media.service';
import { ChatSendService } from './chat-send.service';
import { EvolutionProvider } from './providers/evolution.provider';

/** Conversas: WhatsApp (Evolution) e Instagram Direct na caixa de entrada, em tempo real. */
@Module({
  imports: [PrivateStorageModule, BotsAiModule],
  controllers: [ChatController],
  providers: [EvolutionProvider, ChatEventsService, ChatCustomerService, ChatLibraryService, ChatMediaService, ChatInstagramService, ChatChannelsService, ChatInboundService, ChatSendService, ChatConversationsService],
  exports: [ChatChannelsService, ChatConversationsService, ChatSendService, ChatEventsService],
})
export class ChatModule {}
