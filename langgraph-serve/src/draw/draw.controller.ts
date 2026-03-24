import { Controller, Post, Body, BadRequestException, HttpCode, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger';
import { DrawService } from './draw.service';
import { DrawDto, DrawResponseDto } from './dto/draw.dto';

@ApiTags('draw')
@Controller('api')
export class DrawController {
  constructor(private readonly drawService: DrawService) {}

  @Post('draw')
  @HttpCode(200)
  @ApiOperation({ summary: '生成图形（带记忆）' })
  @ApiBody({ type: DrawDto })
  async draw(@Body() body: DrawDto): Promise<DrawResponseDto> {
    if (!body.text) {
      throw new BadRequestException('请输入指令');
    }

    try {
      // 将 sessionId 传给 Service。如果没有传，Service 会使用默认的 'default-session-id'
      return await this.drawService.draw(body.text, body.sessionId);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // 暴露流式接口，注意这里需要注入 @Res() 以便直接操作底层 Response 写入流
  @Post('stream-draw')
  @HttpCode(200)
  @ApiOperation({ summary: '流式生成图形', description: '通过 SSE 流式传输实时生成图形配置' })
  @ApiBody({
    type: DrawDto,
    description: '用户绘图指令',
  })
  @ApiResponse({ status: 200, description: '流式返回成功', type: DrawResponseDto })
  @ApiResponse({ status: 400, description: '请输入指令' })
  async streamDraw(@Body('text') text: string, @Res() res: Response) {
    await this.drawService.streamDraw(text, res);
  }
}