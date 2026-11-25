import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatChannelsService } from './chat-channels.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatInboundService } from './chat-inbound.service';
import { ChatSendService } from './chat-send.service';
import { EvolutionProvider } from './providers/evolution.provider';

/** Conversas: WhatsApp (Evolution) na caixa de entrada do sistema. */
@Module({
  controllers: [ChatController],
  providers: [EvolutionProvider, ChatChannelsService, ChatInboundService, ChatSendService, ChatConversationsService],
  exports: [ChatChannelsService, ChatConversationsService, ChatSendService],
})
export class ChatModule {}
