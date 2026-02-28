import { ToolNode } from '@langchain/langgraph/prebuilt';
import { brandThemeTool } from './tool.service'; // 引入刚才定义的工具
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';

// 1. 状态需要升级：因为 Tool 调用是基于对话历史的，我们需要消息数组
const GraphState = Annotation.Root({
  userInput: Annotation<string>({ reducer: (cur, next) => next }),
  messages: Annotation<any[]>({ reducer: (cur, next) => cur.concat(next), default: () => [] }),
  shapes: Annotation<any[]>({ reducer: (cur, next) => next, default: () => [] }),
  // ... 其他 retry 字段保留
});

@Injectable()
export class DrawService {
  private agentApp: any;
  private tools = [brandThemeTool]; // 管理所有工具

  private initGraph() {
    const aliyun = createOpenAI({ ... });
    
    // 关键：将工具绑定到大模型上
    // 注意：有了工具，通常使用 model.invoke 而不是 generateObject，因为过程变复杂了
    const modelWithTools = (aliyun as any).chat('qwen-plus').bindTools(this.tools);

    // 节点 1: 决策者 (Agent)
    const agentNode = async (state: typeof GraphState.State) => {
      // 第一次运行需要把 userInput 变成消息
      const currentMessages = state.messages.length === 0 
        ? [new HumanMessage(state.userInput)] 
        : state.messages;

      const response = await modelWithTools.invoke(currentMessages);
      // 返回消息，LangGraph 会自动 concat 到状态里
      return { messages: [response] };
    };

    // 节点 2: 工具执行器 (使用预建的 ToolNode)
    const toolNode = new ToolNode(this.tools);

    // 节点 3: 结果提取器 (当工具跑完，AI 给出最终结论后，我们再提取 JSON)
    const extractorNode = async (state: typeof GraphState.State) => {
      const lastMessage = state.messages[state.messages.length - 1];
      // 此时再用 generateObject 强制让 AI 把刚才拿到的工具信息转成你要的 shapes 格式
      const { object } = await generateObject({
        model: (aliyun as any).chat('qwen-turbo'),
        prompt: `根据对话历史：${JSON.stringify(state.messages)}，生成最终的图形 JSON`,
        schema: z.object({ shapes: z.array(z.object({ ... })) }),
      } as any);
      return { shapes: (object as any).shapes };
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
        if (lastMsg.tool_calls?.length > 0) {
          return 'tools'; // 走向工具节点
        }
        return 'extractor'; // AI 觉得信息够了，走向提取器
      })
      
      .addEdge('tools', 'agent') // 工具跑完一定要回到 agent，让 AI 思考下一步
      .addEdge('extractor', END);

    this.agentApp = workflow.compile();
  }
}