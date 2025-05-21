import { Module } from '@nestjs/common';
import { AreaService } from './area.service';
import { AreaController } from './area.controller';
import { UploadModule } from 'src/features/upload/upload.module';

@Module({
  imports: [UploadModule],
  controllers: [AreaController],
  providers: [AreaService],
})
export class AreaModule {}
