import { Controller, Post, Body, BadRequestException, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger';
import { MultiAgentService } from './multi-agent.service';
import { DrawDto, ResumeDrawDto, DrawResponseDto } from './dto/draw.dto';

/**
 * 多 Agent 协作版 Controller
 * 接口设计和单 Agent 版保持一致（/api/multi-draw、/api/multi-draw-resume）
 * 这样前端只需要换个 URL 就能切换模式
 */
@ApiTags('multi-agent')
@Controller('api')
export class MultiAgentController {
  constructor(private readonly multiAgentService: MultiAgentService) {}

  @Post('multi-draw')
  @HttpCode(200)
  @ApiOperation({ summary: '多 Agent 协作生成图形（设计→配色→布局→审核）' })
  @ApiBody({ type: DrawDto })
  @ApiResponse({ status: 200, type: DrawResponseDto })
  async draw(@Body() body: DrawDto): Promise<any> {
    if (!body.text) {
      throw new BadRequestException('请输入指令');
    }
    try {
      return await this.multiAgentService.draw(body.text, body.sessionId);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  @Post('multi-draw-resume')
  @HttpCode(200)
  @ApiOperation({ summary: '确认/拒绝多 Agent 生成的图形' })
  @ApiBody({ type: ResumeDrawDto })
  @ApiResponse({ status: 200, type: DrawResponseDto })
  async resumeDraw(@Body() body: ResumeDrawDto): Promise<any> {
    if (!body.sessionId || !body.decision) {
      throw new BadRequestException('请提供 sessionId 和 decision');
    }
    try {
      return await this.multiAgentService.resumeDraw(body.sessionId, body.decision);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
