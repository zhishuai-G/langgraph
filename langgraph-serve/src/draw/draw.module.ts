import { Module } from '@nestjs/common';
import { DrawController } from './draw.controller';
import { DrawService } from './draw.service';
import { MultiAgentController } from './multi-agent.controller';
import { MultiAgentService } from './multi-agent.service';

@Module({
  controllers: [DrawController, MultiAgentController],
  providers: [DrawService, MultiAgentService],
})
export class DrawModule {}