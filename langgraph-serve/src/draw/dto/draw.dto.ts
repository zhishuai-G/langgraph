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

// 👇 新增：恢复执行的 DTO
export class ResumeDrawDto {
  @ApiProperty({
    description: '会话ID（必须与之前的 draw 请求使用相同的 sessionId）',
    example: 'session-1711234567890',
  })
  sessionId: string;

  @ApiProperty({
    description: '用户决策：approve（确认渲染）或 reject（拒绝重来）',
    enum: ['approve', 'reject'],
    example: 'approve',
  })
  decision: 'approve' | 'reject';
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
    description: '状态：pending_review（等待审核）、approved（已确认）、rejected（已拒绝）、completed（完成）',
    required: false,
    enum: ['pending_review', 'approved', 'rejected', 'completed'],
  })
  status?: string;

  @ApiProperty({
    description: '生成的图形配置数组',
    type: [ShapeDto],
    required: false,
  })
  shapes?: ShapeDto[];

  @ApiProperty({ description: '提示信息', required: false })
  message?: string;

  @ApiProperty({ description: '错误信息（失败时返回）', required: false })
  error?: string;
}