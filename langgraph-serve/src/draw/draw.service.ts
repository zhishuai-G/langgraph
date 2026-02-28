import { Injectable } from '@nestjs/common';
import { START, END, Annotation, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { brandThemeTool, githubTool, weatherTool } from './tool.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';

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

  constructor(private configService: ConfigService) {
    this.initGraph();
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
      
      const prompt = `你是图形生成助手。请根据以下信息生成图形配置：
用户原始请求：${state.userInput}
对话过程中获取的信息：
${state.messages.map((m: any) => m.content).filter(Boolean).join('\n')}

要求：
1. 严格按照用户请求生成图形，不要添加额外的图形
2. 如果用户说"画一个圆"，就只生成一个圆形
3. 颜色优先级：品牌色 > 天气推荐颜色 > 用户指定颜色
4. 根据天气选择合适的颜色：
   - 晴天：暖色调（#FF6B6B 红色、#FFA500 橙色、#FFD700 黄色）
   - 多云/阴天：中性色（#A9A9A9 灰色、#87CEEB 浅蓝色）
   - 雨/雪：冷色调（#1E90FF 蓝色、#9370DB 紫色）
   - 根据温度调整：高温用冷色，低温用暖色，舒适温度根据天气选择
5. 图形形状选择：
   - 晴天：圆形（表示太阳）
   - 多云：矩形或方形
   - 雨/雪：圆形（表示雨滴）
6. 圆形的 width 和 height 应该相同`;

      const result = await structuredModel.invoke(prompt);
      console.log('✨ 最终图形配置:', JSON.stringify(result.shapes, null, 2));
      return { shapes: result.shapes };
    };

    // ==========================================
    // 3. 编排工作流
    // ==========================================
    const workflow = new StateGraph(GraphState)
      .addNode('agent', agentNode)
      .addNode('tools', toolNode)
      .addNode('extractor', extractorNode)
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
      .addEdge('extractor', END);

    this.agentApp = workflow.compile();
  }

  // 供 Controller 调用的入口
  async draw(text: string) {
    const finalState = await this.agentApp.invoke({
      userInput: text,
      shapes: [],
      errorLog: null,
      retryCount: 0,
    });

    return { success: true, shapes: finalState.shapes };
  }
}