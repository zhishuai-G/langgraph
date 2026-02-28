import { Controller, Post, Body, BadRequestException, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger';
import { DrawService } from './draw.service';
import { DrawDto, DrawResponseDto } from './dto/draw.dto';

@ApiTags('draw')
@Controller('api')
export class DrawController {
  constructor(private readonly drawService: DrawService) {}

  @Post('draw')
  @HttpCode(200)
  @ApiOperation({ summary: '生成图形', description: '根据用户指令调用 AI 生成图形配置' })
  @ApiBody({
    type: DrawDto,
    description: '用户绘图指令',
    examples: {
      普通绘图: {
        summary: '直接指定颜色',
        value: { text: '画一个红色的圆形' },
      },
      品牌配色: {
        summary: '使用品牌色（会调用工具查询）',
        value: { text: '用支付宝的颜色画个圆' },
      },
      带尺寸: {
        summary: '指定图形尺寸',
        value: { text: '画一个蓝色的矩形，宽200高100' },
      },
    },
  })
  @ApiResponse({ status: 200, description: '生成成功', type: DrawResponseDto })
  @ApiResponse({ status: 400, description: '请输入指令' })
  async draw(@Body() body: DrawDto): Promise<DrawResponseDto> {
    if (!body.text) {
      throw new BadRequestException('请输入指令');
    }

    try {
      return await this.drawService.draw(body.text);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}