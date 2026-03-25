/**
 * ============================================================
 * 多 Agent 协作服务 (Multi-Agent Collaboration)
 * ============================================================
 *
 * 4 个 Agent 分工协作：
 *   1. Supervisor（主管）：分析用户需求，制定设计方案
 *   2. Designer（设计师）：确定图形的类型、数量、尺寸
 *   3. Colorist（配色师）：调用真实 API 确定配色
 *   4. Layouter（布局师）：确定位置和排列
 *
 * 工具全部调用真实开放 API：
 *   - generate_color_scheme (thecolorapi.com) → 色彩理论配色方案
 *   - get_ai_palette (colormind.io) → AI 生成调色板
 *   - resolve_color (thecolorapi.com) → 颜色名称/信息查询
 */
import { Injectable, Logger } from '@nestjs/common';
import { START, END, Annotation, StateGraph, interrupt, Command } from '@langchain/langgraph';
import { colorSchemeTool, aiPaletteTool, resolveColorTool } from './tool.service';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';

// ============================================================
// 1. 共享状态
// ============================================================
const MultiAgentState = Annotation.Root({
  userInput: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  messages: Annotation<any[]>({ reducer: (cur, next) => cur.concat(next), default: () => [] }),
  designPlan: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  shapeDrafts: Annotation<any[]>({ reducer: (_, next) => next, default: () => [] }),
  coloredShapes: Annotation<any[]>({ reducer: (_, next) => next, default: () => [] }),
  shapes: Annotation<any[]>({ reducer: (_, next) => next, default: () => [] }),
  currentAgent: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
});

// ============================================================
// 2. 数据结构 Schema
// ============================================================
const DESIGN_PLAN_SCHEMA = z.object({
  plan: z.string().describe('设计方案描述'),
  shapeCount: z.number().describe('图形数量'),
  style: z.string().describe('风格关键词'),
});

const SHAPE_DRAFT_SCHEMA = z.object({
  shapes: z.array(z.object({
    type: z.enum(['rect', 'circle']).describe('图形类型'),
    width: z.number().describe('宽度'),
    height: z.number().describe('高度'),
    purpose: z.string().describe('用途说明'),
  })),
});

const COLORED_SHAPES_SCHEMA = z.object({
  shapes: z.array(z.object({
    type: z.enum(['rect', 'circle']).describe('图形类型'),
    width: z.number().describe('宽度'),
    height: z.number().describe('高度'),
    fill: z.string().describe('填充颜色（十六进制）'),
    colorReason: z.string().describe('选色理由'),
  })),
});

const FINAL_SHAPES_SCHEMA = z.object({
  shapes: z.array(z.object({
    type: z.enum(['rect', 'circle']).describe('图形类型'),
    width: z.number().describe('宽度'),
    height: z.number().describe('高度'),
    fill: z.string().describe('填充颜色'),
    x: z.number().describe('X 坐标'),
    y: z.number().describe('Y 坐标'),
  })),
});

@Injectable()
export class MultiAgentService {
  private agentApp: any;
  private readonly logger = new Logger(MultiAgentService.name);
  private checkpointer: RedisSaver;

  // Colorist 的工具集：三个真实 API
  private colorTools = [colorSchemeTool, aiPaletteTool, resolveColorTool];

  constructor(private configService: ConfigService) {
    this.init();
  }

  private async init() {
    const redisUrl = this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.checkpointer = await RedisSaver.fromUrl(redisUrl, {
      defaultTTL: 1440,
      refreshOnRead: true,
    });
    this.logger.log('✅ [多Agent] Redis Checkpointer 初始化成功');
    this.initGraph();
  }

  private initGraph() {
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');

    const createModel = (modelName = 'qwen-turbo') => new ChatOpenAI({
      apiKey,
      model: modelName,
      configuration: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });

    // ============================================================
    // 3. Agent 节点定义
    // ============================================================

    // --- Agent 1: Supervisor（主管）---
    const supervisorNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('🧠 [Supervisor] 分析用户需求...');

      const model = createModel('qwen-turbo');
      const structuredModel = model.withStructuredOutput(DESIGN_PLAN_SCHEMA);

      const result = await structuredModel.invoke([
        new SystemMessage(`你是设计总监，分析用户的绘图需求并制定设计方案。
要求：
1. 理解用户想画什么
2. 确定需要几个图形
3. 确定整体风格
4. 不要确定具体颜色（交给配色师）
5. 不要确定位置（交给布局师）`),
        new HumanMessage(state.userInput),
      ]);

      this.logger.log(`📋 [Supervisor] 设计方案: ${result.plan}`);

      return {
        designPlan: result.plan,
        currentAgent: 'supervisor',
        messages: [new HumanMessage(`[Supervisor] ${result.plan}，${result.shapeCount} 个图形，风格：${result.style}`)],
      };
    };

    // --- Agent 2: Designer（设计师，纯 AI 无工具）---
    const designerNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('✏️ [Designer] 设计图形规格...');

      const model = createModel('qwen-turbo');
      const structuredModel = model.withStructuredOutput(SHAPE_DRAFT_SCHEMA);

      const result = await structuredModel.invoke([
        new SystemMessage(`你是图形设计师，根据设计方案确定图形的类型和尺寸。
规则：
1. 只确定 type（rect 或 circle）、width、height
2. 不要决定颜色（那是配色师的工作）
3. 不要决定位置（那是布局师的工作）
4. 每个图形要说明用途（purpose）
5. 圆形的 width 和 height 应该相同`),
        new HumanMessage(`用户需求：${state.userInput}\n设计方案：${state.designPlan}`),
      ]);

      this.logger.log(`📐 [Designer] 图形骨架: ${JSON.stringify(result.shapes)}`);

      return {
        shapeDrafts: result.shapes,
        currentAgent: 'designer',
        messages: [new HumanMessage(`[Designer] 设计了 ${result.shapes.length} 个图形`)],
      };
    };

    // --- Agent 3: Colorist（配色师，带 3 个真实 API 工具）---
    const coloristModel = createModel('qwen-turbo');
    const coloristWithTools = coloristModel.bindTools(this.colorTools);

    const coloristNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('🎨 [Colorist] 开始配色...');

      const response = await coloristWithTools.invoke([
        new SystemMessage(`你是专业配色师，为图形确定合适的颜色。你有三个工具可以调用：

1. generate_color_scheme：调用 The Color API，根据一个基础色 + 配色模式生成专业配色方案
   - 用户指定了一个颜色时，用它扩展出一组和谐色
   - mode 选择：complement(互补), analogic(类似), triad(三角), monochrome(同色系)

2. get_ai_palette：调用 Colormind AI，用深度学习生成 5 色调色板
   - 可以锁定已知颜色，让 AI 填充剩余颜色
   - 适合没有明确颜色要求时，让 AI 自由发挥

3. resolve_color：调用 The Color API，查询颜色的详细信息（名称、对比色等）
   - 用户给了模糊颜色描述（如"珊瑚色"），你可以先给出对应 hex 再查详情

使用策略：
- 用户指定了颜色 → 用 generate_color_scheme 扩展配色
- 用户没指定颜色 → 用 get_ai_palette 让 AI 生成
- 需要确认颜色信息 → 用 resolve_color 查详情

不要修改图形的类型和尺寸。`),
        new HumanMessage(`用户需求：${state.userInput}\n待配色的图形：${JSON.stringify(state.shapeDrafts)}`),
      ]);

      if ((response.tool_calls?.length ?? 0) > 0) {
        this.logger.log(`🔧 [Colorist] 调用 ${response.tool_calls.length} 个工具`);
        return { messages: [response], currentAgent: 'colorist' };
      }

      this.logger.log('💬 [Colorist] 直接配色，未调用工具');
      return { messages: [response], currentAgent: 'colorist' };
    };

    // 工具执行节点
    const toolNodeBase = new ToolNode(this.colorTools);
    const colorToolNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('🛠️ [Color Tools] 执行 API 调用...');
      const result = await toolNodeBase.invoke(state);
      return result;
    };

    // Colorist 最终配色节点
    const colorFinalizeNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('🎨 [Colorist] 根据 API 结果生成最终配色...');

      const model = createModel('qwen-turbo');
      const structuredModel = model.withStructuredOutput(COLORED_SHAPES_SCHEMA);

      const toolResults = state.messages
        .filter((m: any) => m.content && typeof m.content === 'string')
        .map((m: any) => m.content)
        .join('\n');

      const result = await structuredModel.invoke([
        new SystemMessage(`你是配色师。根据 API 返回的颜色信息为图形配色。
规则：
1. 保持图形的 type、width、height 不变
2. 从 API 返回的颜色中选择合适的颜色分配给各图形
3. 每个颜色要说明理由（colorReason），引用 API 返回的信息
4. 颜色必须使用十六进制格式（如 #FF6B6B）`),
        new HumanMessage(`用户需求：${state.userInput}
待配色的图形：${JSON.stringify(state.shapeDrafts)}
API 返回的颜色信息：
${toolResults}`),
      ]);

      this.logger.log(`🎨 [Colorist] 配色结果: ${JSON.stringify(result.shapes)}`);

      return {
        coloredShapes: result.shapes,
        currentAgent: 'colorist-done',
        messages: [new HumanMessage(`[Colorist] 配色完成: ${result.shapes.map((s: any) => s.fill).join(', ')}`)],
      };
    };

    // --- Agent 4: Layouter（布局师，纯 AI 无工具）---
    const layouterNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('📍 [Layouter] 计算布局...');

      const model = createModel('qwen-turbo');
      const structuredModel = model.withStructuredOutput(FINAL_SHAPES_SCHEMA);

      const result = await structuredModel.invoke([
        new SystemMessage(`你是布局师，确定每个图形在画布上的位置。
画布大小：1200 x 600 像素。
规则：
1. 保持 type、width、height、fill 不变
2. 为每个图形确定 x、y 坐标
3. 图形之间不要重叠，保持合理间距
4. 整体布局美观、居中
5. 单个图形放画布中央
6. 多个图形合理排列（水平或网格）`),
        new HumanMessage(`用户需求：${state.userInput}\n待布局的图形：${JSON.stringify(state.coloredShapes)}`),
      ]);

      this.logger.log(`📍 [Layouter] 最终布局: ${JSON.stringify(result.shapes)}`);

      return {
        shapes: result.shapes,
        currentAgent: 'layouter',
        messages: [new HumanMessage(`[Layouter] 布局完成`)],
      };
    };

    // --- 人工审核节点 ---
    const reviewNode = async (state: typeof MultiAgentState.State) => {
      this.logger.log('⏸️ [Review] 等待人工审核...');

      const humanDecision = interrupt({
        message: '多 Agent 协作完成，请确认是否渲染',
        shapes: state.shapes,
        pipeline: {
          designPlan: state.designPlan,
          shapeDrafts: state.shapeDrafts,
          coloredShapes: state.coloredShapes,
          finalShapes: state.shapes,
        },
      });

      if (humanDecision === 'approve') {
        return { shapes: state.shapes, currentAgent: 'approved' };
      } else {
        return { shapes: [], currentAgent: 'rejected' };
      }
    };

    // ============================================================
    // 4. 编排工作流
    // ============================================================
    //
    //   START → supervisor → designer → colorist → [条件] → color_tools → color_finalize → layouter → review → END
    //                                      └─────────────────────────> color_finalize ──┘
    //
    const workflow = new StateGraph(MultiAgentState)
      .addNode('supervisor', supervisorNode)
      .addNode('designer', designerNode)
      .addNode('colorist', coloristNode)
      .addNode('color_tools', colorToolNode)
      .addNode('color_finalize', colorFinalizeNode)
      .addNode('layouter', layouterNode)
      .addNode('review', reviewNode)

      .addEdge(START, 'supervisor')
      .addEdge('supervisor', 'designer')
      .addEdge('designer', 'colorist')

      .addConditionalEdges('colorist', (state) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if ((lastMsg.tool_calls?.length ?? 0) > 0) {
          return 'color_tools';
        }
        return 'color_finalize';
      })

      .addEdge('color_tools', 'color_finalize')
      .addEdge('color_finalize', 'layouter')
      .addEdge('layouter', 'review')
      .addEdge('review', END);

    this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
    this.logger.log('✅ [多Agent] 工作流编译完成');
  }

  // ============================================================
  // 5. 对外方法
  // ============================================================

  async draw(text: string, sessionId: string = 'default-session') {
    try {
      const finalState = await this.agentApp.invoke(
        { userInput: text, messages: [new HumanMessage(text)] },
        { configurable: { thread_id: sessionId } },
      );

      if (finalState.__interrupt__?.length > 0) {
        const interruptData = finalState.__interrupt__[0].value;
        return {
          success: true,
          status: 'pending_review',
          shapes: interruptData.shapes,
          message: interruptData.message,
          pipeline: interruptData.pipeline,
        };
      }

      return { success: true, status: 'completed', shapes: finalState.shapes };
    } catch (error) {
      this.logger.error(`[多Agent] 运行失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async resumeDraw(sessionId: string, decision: string) {
    try {
      const finalState = await this.agentApp.invoke(
        new Command({ resume: decision }),
        { configurable: { thread_id: sessionId } },
      );

      if (decision === 'approve') {
        return { success: true, status: 'approved', shapes: finalState.shapes };
      } else {
        return { success: true, status: 'rejected', shapes: [] };
      }
    } catch (error) {
      this.logger.error(`[多Agent] 恢复执行失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
