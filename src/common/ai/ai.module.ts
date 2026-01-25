import { Global, Module } from '@nestjs/common';
import { AIService } from './ai.service';
import { GroqSupplier } from './suppliers/groq.supplier';
import { GeminiSupplier } from './suppliers/gemini.supplier';

@Global()
@Module({
  providers: [AIService, GroqSupplier, GeminiSupplier],
  exports: [AIService],
})
export class AIModule {}
