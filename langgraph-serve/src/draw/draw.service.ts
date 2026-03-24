import { Injectable, Logger } from '@nestjs/common';
import { START, END, Annotation, StateGraph, interrupt, Command } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { brandThemeTool, githubTool, weatherTool } from './tool.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { streamObject } from 'ai';
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';

// ==========================================
// 1. 定义全局状态 (State)
// ==========================================
const GraphState = Annotation.Root({
  userInput: Annotation<string>({ reducer: (cur, next) => next, default: () => '' }),
  messages: Annotation<any[]>({ reducer: (cur, next) => cur.concat(next), default: () => [] }),
  shapes: Annotation<any[]>({ reducer: (cur, next) => next, default: () => [] }),
  errorLog: Annotation<string | null>({ reducer: (cur, next) => next, default: () => null }),
  retryCount: Annotation<number>({ reducer: (cur, next) => next, default: () => 0 }),
});

// ==========================================
// 2. 定义前端需要的数据格式 (Zod Schema)
// ==========================================
const SHAPE_SCHEMA = z.object({
  shapes: z.array(
    z.object({
      type: z.enum(['rect', 'circle']).describe('图形类型'),
      width: z.number().describe('宽度/半径'),
      height: z.number().describe('高度'),
      fill: z.string().describe('填充颜色'),
    }),
  ),
});

@Injectable()
export class DrawService {
  private agentApp: any;
  private tools = [brandThemeTool, weatherTool, githubTool]; // 挂载所有工具：品牌色查询、天气查询、GitHub信息查询
  private aliyun: any;
  private readonly logger = new Logger(DrawService.name);
  private checkpointer: RedisSaver;

  constructor(private configService: ConfigService) {
    this.initAliyun();
    this.init();
  }

  private async init() {
    const redisUrl = this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.checkpointer = await RedisSaver.fromUrl(redisUrl, {
      defaultTTL: 1440,
      refreshOnRead: true,
    });
    this.logger.log('✅ Redis Checkpointer 初始化成功');
    this.initGraph();
  }

  private initAliyun() {
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');
    this.aliyun = createOpenAI({
      apiKey: apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  }

  private initGraph() {
    // 初始化 LangChain 的 OpenAI 客户端（兼容阿里云 DashScope）
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');
    const model = new ChatOpenAI({
      apiKey: apiKey,
      model: 'qwen-turbo',
      configuration: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });

    // 🔑 核心动作：把工具绑定到大模型上
    const modelWithTools = model.bindTools(this.tools);

    // 系统提示：强行立下死规矩，防幻觉
    const systemPrompt = new SystemMessage(
      `你是一个智能图形生成助手。
重要规则：
1. 工具调用规则：
   - 当用户提到任何品牌名称（如：支付宝、谷歌、阿里巴巴、腾讯、百度等）时，调用 get_brand_color 工具获取品牌官方配色
   - 当用户提到城市名称并询问天气，或想根据天气画图时，调用 get_weather 工具查询天气信息
   - 当用户提到 GitHub 用户名或想根据 GitHub 数据画图时，调用 get_github_info 工具查询用户信息
   - 不要自己猜测颜色或天气数据，必须通过工具查询

2. 颜色使用规则：
   - 只有当用户明确指定了具体颜色（如：红色、蓝色、#FF0000）时，才可以直接使用该颜色
   - 如果查询到了品牌色，优先使用品牌色

3. 根据天气画图规则：
   - 晴天：使用暖色调（红色、橙色、黄色），可以添加圆形或太阳元素
   - 多云/阴天：使用中性色（灰色、浅蓝色），可以使用矩形或方形元素
   - 雨/雪天气：使用冷色调（蓝色、紫色），可以添加小圆点表示雨滴
   - 根据温度调整：
     * 高温（>30°C）：使用冷色调，图形简洁
     * 低温（<10°C）：使用暖色调，图形圆润
     * 舒适温度（10-30°C）：根据天气类型选择颜色`
    );

    // --- 节点 A: 决策大脑 ---
    const agentNode = async (state: typeof GraphState.State) => {
      console.log(`\n⚙️ 呼叫大模型...`);
      const currentMessages =
        state.messages.length === 0
          ? [systemPrompt, new HumanMessage(state.userInput)]
          : [systemPrompt, ...state.messages];

      const response = await modelWithTools.invoke(currentMessages);

      // 打印日志，方便我们在终端观察 AI 是不是去调工具了
      if ((response.tool_calls?.length ?? 0) > 0) {
        console.log('🔧 AI 决定调用工具:', JSON.stringify(response.tool_calls, null, 2));
      } else {
        console.log('💬 AI 直接回复，无工具调用');
        console.log('📝 AI 回复内容:', response.content);
      }
      return { messages: [response] };
    };

    // --- 节点 B: 工具执行器 ---
    const toolNodeBase = new ToolNode(this.tools);
    const toolNode = async (state: typeof GraphState.State) => {
      console.log('🛠️ 开始执行工具...');
      const result = await toolNodeBase.invoke(state);
      console.log('✅ 工具执行完成，结果:', JSON.stringify(result.messages?.map((m: any) => m.content), null, 2));
      return result;
    };

    // --- 节点 C: 结果提取器 ---
    const extractorNode = async (state: typeof GraphState.State) => {
      console.log('📊 提取最终结果...');
      const structuredModel = model.withStructuredOutput(SHAPE_SCHEMA);

      // 构建"上一轮已有图形"的上下文，让大模型知道画布当前状态
      const previousShapesContext = (state.shapes && state.shapes.length > 0)
        ? `\n当前画布上已有的图形（上一次生成的结果）：\n${JSON.stringify(state.shapes, null, 2)}\n注意：如果用户的请求是在已有图形的基础上做修改（如改颜色、改大小），请保留未提及属性不变，只修改用户明确要求改动的部分。`
        : '';

      const prompt = `你是图形生成助手。请根据以下信息生成图形配置：
用户原始请求：${state.userInput}
${previousShapesContext}
对话过程中获取的信息：
${state.messages.map((m: any) => m.content).filter(Boolean).join('\n')}

要求：
1. 严格按照用户请求生成图形，不要添加额外的图形
2. 如果用户说"画一个圆"，就只生成一个圆形
3. 如果用户的请求是修改类指令（如"把颜色改成…"、"把形状变大"等），必须基于"当前画布上已有的图形"进行修改，只改用户提到的属性，其余属性保持不变
4. 颜色优先级：品牌色 > 天气推荐颜色 > 用户指定颜色
5. 根据天气选择合适的颜色：
   - 晴天：暖色调（#FF6B6B 红色、#FFA500 橙色、#FFD700 黄色）
   - 多云/阴天：中性色（#A9A9A9 灰色、#87CEEB 浅蓝色）
   - 雨/雪：冷色调（#1E90FF 蓝色、#9370DB 紫色）
   - 根据温度调整：高温用冷色，低温用暖色，舒适温度根据天气选择
6. 图形形状选择：
   - 晴天：圆形（表示太阳）
   - 多云：矩形或方形
   - 雨/雪：圆形（表示雨滴）
7. 圆形的 width 和 height 应该相同`;

      const result = await structuredModel.invoke(prompt);
      console.log('✨ 最终图形配置:', JSON.stringify(result.shapes, null, 2));
      return { shapes: result.shapes };
    };

    // --- 👇 节点 D: 人工审核节点（Human-in-the-Loop 的核心！） ---
    const reviewNode = async (state: typeof GraphState.State) => {
      console.log('⏸️ 暂停等待人工审核...');
      console.log('📋 待审核的图形:', JSON.stringify(state.shapes, null, 2));

      // 🔑 调用 interrupt() —— 图的执行在这里冻结！
      // 传入的参数会通过 __interrupt__ 字段返回给调用者（前端）
      const humanDecision = interrupt({
        message: '请确认是否渲染以下图形',
        shapes: state.shapes,
      });

      // ⬇️ 以下代码只有在用户 resume 之后才会执行
      console.log('✅ 收到人工决策:', humanDecision);

      if (humanDecision === 'approve') {
        // 用户确认，shapes 保持不变，流程正常结束
        return { shapes: state.shapes };
      } else {
        // 用户拒绝，清空 shapes
        return { shapes: [] };
      }
    };

    // ==========================================
    // 3. 编排工作流
    // ==========================================
    const workflow = new StateGraph(GraphState)
      .addNode('agent', agentNode)
      .addNode('tools', toolNode)
      .addNode('extractor', extractorNode)
      .addNode('review', reviewNode)   // 👈 新增审核节点
      .addEdge(START, 'agent')

      // 🚦 条件边：判断 AI 是想调工具，还是想结束对话
      .addConditionalEdges('agent', (state) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if ((lastMsg.tool_calls?.length ?? 0) > 0) {
          return 'tools'; // 走向工具节点去干活
        }
        return 'extractor'; // 信息够了，走向提取器去翻译 JSON
      })

      // 🔄 工具跑完一定要回到 agent，让 AI 确认一眼查到的数据
      .addEdge('tools', 'agent')
      // 👇 改动：extractor 完成后不再直接 END，而是走向 review 审核节点
      .addEdge('extractor', 'review')
      .addEdge('review', END);

    this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
  }

  // 新增：专门用于流式输出的接口
  async streamDraw(text: string, res: any) {
    // 1. 设置 HTTP 响应头，开启 SSE 流式传输模式
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // 2. 呼叫大模型，开启 streamObject (使用 ai SDK)
      const { partialObjectStream } = await streamObject({
        model: this.aliyun.chat('qwen-turbo'),
        schema: SHAPE_SCHEMA,
        prompt: `请根据需求生成图形配置：${text}`,
      });

      // 3. 核心魔法：异步遍历生成的"半成品"对象
      for await (const partialObject of partialObjectStream) {
        // partialObject 是经过 SDK 自动修补的合法 JS 对象！
        // 我们把它包装成 SSE 标准格式 (data: {JSON}\n\n) 推给前端
        res.write(`data: ${JSON.stringify(partialObject)}\n\n`);
      }

      // 4. 生成结束，发送结束信号
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      this.logger.error(`流式生成失败: ${error.message}`);
      res.write(`data: {"error": "${error.message}"}\n\n`);
      res.end();
    }
  }

  // 供 Controller 调用的入口（第一次调用，会触发 interrupt 暂停）
  async draw(text: string, sessionId: string = 'default-session') {
    try {
      const finalState = await this.agentApp.invoke(
        {
          userInput: text,
          messages: [new HumanMessage(text)]
        },
        {
          configurable: { thread_id: sessionId }
        }
      );

      // 🔑 检查是否被 interrupt 暂停了
      if (finalState.__interrupt__ && finalState.__interrupt__.length > 0) {
        // 图被暂停了，返回待审核的 shapes 给前端预览
        const interruptData = finalState.__interrupt__[0].value;
        return {
          success: true,
          status: 'pending_review',  // 告诉前端：需要人工确认
          shapes: interruptData.shapes,
          message: interruptData.message,
        };
      }

      return { success: true, status: 'completed', shapes: finalState.shapes };
    } catch (error) {
      this.logger.error(`Agent 运行失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // 👇 新增：恢复执行（用户确认或拒绝后调用）
  async resumeDraw(sessionId: string, decision: string) {
    try {
      const finalState = await this.agentApp.invoke(
        // 🔑 用 Command({ resume }) 恢复被 interrupt 暂停的图
        // resume 的值会成为 interrupt() 的返回值
        new Command({ resume: decision }),
        {
          configurable: { thread_id: sessionId }
        }
      );

      if (decision === 'approve') {
        return { success: true, status: 'approved', shapes: finalState.shapes };
      } else {
        return { success: true, status: 'rejected', shapes: [] };
      }
    } catch (error) {
      this.logger.error(`恢复执行失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}