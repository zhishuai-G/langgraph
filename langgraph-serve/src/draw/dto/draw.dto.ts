import { ApiProperty, ApiHideProperty } from '@nestjs/swagger';

export class DrawDto {
  @ApiProperty({
    description: '用户绘图指令',
    examples: {
      普通绘图: {
        summary: '直接指定颜色',
        value: '画一个红色的圆形',
      },
      品牌配色: {
        summary: '使用品牌色（会调用工具查询）',
        value: '用支付宝的颜色画个圆',
      },
    },
  })
  text: string;

  @ApiHideProperty()
  sessionId?: string;
}

export class ShapeDto {
  @ApiProperty({ description: '图形类型', enum: ['rect', 'circle'] })
  type: 'rect' | 'circle';

  @ApiProperty({ description: '宽度（圆形时为半径）', example: 100 })
  width: number;

  @ApiProperty({ description: '高度（圆形时与宽度一致）', example: 100 })
  height: number;

  @ApiProperty({ description: '填充颜色', example: 'red' })
  fill: string;
}

export class DrawResponseDto {
  @ApiProperty({ description: '是否成功', example: true })
  success: boolean;

  @ApiProperty({
    description: '生成的图形配置数组',
    type: [ShapeDto],
    required: false,
  })
  shapes?: ShapeDto[];

  @ApiProperty({ description: '错误信息（失败时返回）', required: false })
  error?: string;
}