import { Injectable } from '@nestjs/common';
import { START, END, Annotation, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { brandThemeTool } from './tool.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';

// 定义状态类型
const GraphState = Annotation.Root({
  userInput: Annotation<string>({
    reducer: (cur, next) => next,
    default: () => '',
  }),
  messages: Annotation<any[]>({
    reducer: (cur, next) => cur.concat(next),
    default: () => [],
  }),
  shapes: Annotation<any[]>({
    reducer: (cur, next) => next,
    default: () => [],
  }),
  errorLog: Annotation<string | null>({
    reducer: (cur, next) => next,
    default: () => null,
  }),
  retryCount: Annotation<number>({
    reducer: (cur, next) => next,
    default: () => 0,
  }),
});

// --- 0. 定义数据契约 (Schema) ---
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
  private tools = [brandThemeTool];

  constructor(private configService: ConfigService) {
    this.initGraph();
  }

  private initGraph() {
    // 使用 LangChain OpenAI 模型（兼容阿里云 DashScope）
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');

    const model = new ChatOpenAI({
      apiKey: apiKey,
      model: 'qwen-turbo',
      configuration: {
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    });

    const modelWithTools = model.bindTools(this.tools);

    // 系统提示：强调必须使用工具获取品牌颜色
    const systemPrompt = new SystemMessage(
      `你是一个图形生成助手。
重要规则：
1. 当用户提到任何品牌名称（如：支付宝、谷歌、阿里巴巴、腾讯、百度等）时，你必须调用 get_brand_color 工具来获取该品牌的官方配色。
2. 不要自己猜测品牌颜色，必须通过工具查询。
3. 只有当用户明确指定了具体颜色（如：红色、蓝色、#FF0000）时，才可以直接使用该颜色。`
    );

    const agentNode = async (state: typeof GraphState.State) => {
      console.log(`\n⚙️ 呼叫大模型...`);
      const currentMessages =
        state.messages.length === 0
          ? [systemPrompt, new HumanMessage(state.userInput)]
          : [systemPrompt, ...state.messages];

      const response = await modelWithTools.invoke(currentMessages);
      
      // 🔍 打印是否有工具调用
      if ((response.tool_calls?.length ?? 0) > 0) {
        console.log('🔧 AI 决定调用工具:', JSON.stringify(response.tool_calls, null, 2));
      } else {
        console.log('💬 AI 直接回复，无工具调用');
        console.log('📝 AI 回复内容:', response.content);
      }
      
      return { messages: [response] };
    };

    // 节点 2: 工具执行器 (使用预建的 ToolNode)
    const toolNodeBase = new ToolNode(this.tools);
    const toolNode = async (state: typeof GraphState.State) => {
      console.log('🛠️ 开始执行工具...');
      const result = await toolNodeBase.invoke(state);
      console.log('✅ 工具执行完成，结果:', JSON.stringify(result.messages?.map((m: any) => m.content), null, 2));
      return result;
    };

    // 节点 3: 结果提取器 (当工具跑完，AI 给出最终结论后，我们再提取 JSON)
    const extractorNode = async (state: typeof GraphState.State) => {
      console.log('📊 提取最终结果...');
      // 使用 withStructuredOutput 强制让 AI 输出符合 schema 的 JSON
      const structuredModel = model.withStructuredOutput(SHAPE_SCHEMA);
      
      const prompt = `你是图形生成助手。请根据以下信息生成图形配置：

用户原始请求：${state.userInput}

对话过程中获取的信息：
${state.messages.map((m: any) => m.content).filter(Boolean).join('\n')}

要求：
1. 严格按照用户请求生成图形，不要添加额外的图形
2. 如果用户说"画一个圆"，就只生成一个圆形
3. 颜色必须使用对话中获取到的品牌色（如果有的话）
4. 圆形的 width 和 height 应该相同`;

      const result = await structuredModel.invoke(prompt);
      console.log('✨ 最终图形配置:', JSON.stringify(result.shapes, null, 2));
      return { shapes: result.shapes };
    };

    // 重新编排工作流
    const workflow = new StateGraph(GraphState)
      .addNode('agent', agentNode)
      .addNode('tools', toolNode)
      .addNode('extractor', extractorNode)
      .addEdge(START, 'agent')

      // 条件边：判断 AI 是想调工具，还是想结束对话
      .addConditionalEdges('agent', (state) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if ((lastMsg.tool_calls?.length ?? 0) > 0) {
          return 'tools'; // 走向工具节点
        }
        return 'extractor'; // AI 觉得信息够了，走向提取器
      })

      .addEdge('tools', 'agent') // 工具跑完一定要回到 agent，让 AI 思考下一步
      .addEdge('extractor', END);

    this.agentApp = workflow.compile();
  }

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
