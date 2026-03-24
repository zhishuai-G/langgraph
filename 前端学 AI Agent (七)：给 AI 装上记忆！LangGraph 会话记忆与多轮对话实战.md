在上一篇中，我们的 AI Agent 已经能根据一句话生成图形了。但你有没有发现一个致命问题？

**每次对话都是"一锤子买卖"。** 你说"画一个红色的矩形"，AI 画了。紧接着你说"把它的颜色改成蓝色"——AI 却完全不知道"它"是什么，因为它压根不记得上一轮画了什么！结果可能给你蹦出一个蓝色的圆形，形状都变了。

这就像你跟一个金鱼记忆的画师合作：每次开口，他都觉得是第一次见你。

今天，我们要给这个 AI Agent **装上海马体**——让它拥有**会话记忆（Session Memory）**，实现真正意义上的**多轮对话**。

## 一、 核心概念：什么是 Checkpointer？

LangGraph 提供了一个优雅的记忆机制：**Checkpointer（检查点存储器）**。

你可以把它想象成游戏中的**存档系统**。每次 AI Agent 完成一轮对话（一个 graph 的完整执行），Checkpointer 就会把当前的**全部状态**——包括对话消息、生成的图形、用户输入——像游戏存档一样保存下来。

下一次对话开始时，AI 会先**读档**，加载之前的状态，然后在这个基础上继续工作。

LangGraph 内置了一个开箱即用的实现：**`MemorySaver`**。它把所有状态存在内存中（适合开发调试，生产环境可以换成 Redis/PostgreSQL 等持久化方案）。

整个接入只需要**三步**，我们一步步来。

## 二、 实战改造：三步让 AI 拥有记忆

### 第一步：引入 MemorySaver——AI 的"海马体"

打开 `draw.service.ts`，在文件顶部引入 `MemorySaver`，并在 `DrawService` 类中实例化它：

```typescript
import { MemorySaver } from '@langchain/langgraph'; // 👈 1. 引入记忆存储器

@Injectable()
export class DrawService {
  private agentApp: any;
  private tools = [brandThemeTool, weatherTool, githubTool];
  private aliyun: any;
  private readonly logger = new Logger(DrawService.name);
  // 👇 2. 实例化一个内存存储器（你可以把它想象成 AI 的海马体）
  private checkpointer = new MemorySaver();

  // ...
}
```

就这么一行代码，我们就拥有了一个"记忆仓库"。但光有仓库不够，还得告诉 AI："你的记忆存这里。"

### 第二步：编译 Graph 时挂载 Checkpointer——开启存档机制

在 `initGraph()` 方法的最后，编译工作流时，把 `checkpointer` 传进去：

```typescript
// 改造前：没有记忆
// this.agentApp = workflow.compile();

// 💡 改造后：编译时开启记忆机制！
this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
```

**就这一个参数的差异**，LangGraph 就会在每次 `invoke()` 执行完后，自动把完整的 `GraphState`（包括 `messages`、`shapes`、`userInput` 等所有字段）序列化并存入 `MemorySaver`。

### 第三步：调用时传入 thread_id——告诉 AI "你在跟谁聊天"

这是最关键的一步。记忆是按"会话"隔离的——就像微信的聊天记录，每个好友有独立的对话窗口。我们通过 `thread_id` 来区分不同的会话：

```typescript
// 供 Controller 调用的入口
async draw(text: string, sessionId: string = 'default-session') {
  try {
    const finalState = await this.agentApp.invoke(
      { 
        userInput: text,
        // 🚨 直接在这里把用户当前的话作为 HumanMessage 存入记忆数组！
        // 这样底层的 state.messages 就会永远保持最新，且包含历史记录
        messages: [new HumanMessage(text)] 
      },
      { 
        // 🚨 通过 configurable 传入 thread_id，让 AI 知道现在是在跟谁聊天
        configurable: { thread_id: sessionId } 
      }
    );

    return { success: true, shapes: finalState.shapes };
  } catch (error) {
    this.logger.error(`Agent 运行失败: ${error.message}`);
    return { success: false, error: error.message };
  }
}
```

注意 `invoke` 的第二个参数 `{ configurable: { thread_id: sessionId } }`。这就是告诉 LangGraph：

- **存档时**：用这个 `thread_id` 作为存档文件名
- **读档时**：根据这个 `thread_id` 找到对应的历史状态，恢复到 `state` 里

这意味着，如果你传 `sessionId = 'user-A'`，那么 user-A 的所有对话历史会被串起来；传 `sessionId = 'user-B'`，则是完全独立的另一段对话。

Controller 层也要做相应的适配，把 `sessionId` 透传下去：

```typescript
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
```

## 三、 踩坑实录：记忆生效了，但图形还是乱变？

如果你照着上面的三步做完就以为大功告成，那你大概率会踩到一个**隐蔽的坑**。

让我们来复现一下：

**第一次请求**：`{ "text": "画一个红色的矩形" }`

返回：
```json
{
  "success": true,
  "shapes": [{ "type": "rect", "width": 200, "height": 100, "fill": "#FF6B6B" }]
}
```

✅ 完美。

**第二次请求**：`{ "text": "把它的颜色改成蓝色，形状保持不变" }`

返回：
```json
{
  "success": true,
  "shapes": [{ "type": "circle", "width": 100, "height": 100, "fill": "#1E90FF" }]
}
```

❌ 颜色确实变蓝了，但形状从 `rect` 变成了 `circle`！用户明明说了"形状保持不变"！

### 为什么会这样？

问题出在 **`extractorNode`（结果提取器）** 上。让我们看看它的工作流程：

```
用户说"把颜色改成蓝色" 
  → agent 节点（大模型理解语义，对话消息中知道要改什么）
  → extractor 节点（调用 structuredModel 生成最终 JSON）
```

`extractorNode` 用 `model.withStructuredOutput()` 调用了一次**独立的、全新的**大模型请求。它的 prompt 里只有：

```
用户原始请求：把它的颜色改成蓝色，形状保持不变
对话过程中获取的信息：（一堆对话消息文本）
```

**问题的关键来了**：prompt 里根本**没有告诉大模型上一次生成的图形是什么**！大模型不知道画布上现在是一个 `rect`，它只能从"把颜色改成蓝色"这句话里猜——猜不准，就随机输出了一个 `circle`。

简单来说：`MemorySaver` 确实把 `state.shapes` 存起来了（记忆是有的），但 `extractorNode` 的 prompt **没有读取这份记忆**。就像你明明把笔记写在了本子上，但做题的时候忘了翻开看。

### 修复方案：让提取器"读档"

我们需要在 `extractorNode` 的 prompt 中，**注入上一轮生成的图形数据**，让大模型知道"画布上现在有什么"：

```typescript
// --- 节点 C: 结果提取器 ---
const extractorNode = async (state: typeof GraphState.State) => {
  console.log('📊 提取最终结果...');
  const structuredModel = model.withStructuredOutput(SHAPE_SCHEMA);

  // 🔑 构建"上一轮已有图形"的上下文，让大模型知道画布当前状态
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
```

核心变化就是这几行：

```typescript
const previousShapesContext = (state.shapes && state.shapes.length > 0)
  ? `\n当前画布上已有的图形（上一次生成的结果）：\n${JSON.stringify(state.shapes, null, 2)}\n...`
  : '';
```

当 `state.shapes` 有值时（说明这不是第一次对话），我们把上一轮的图形 JSON **原封不动**地塞进 prompt。大模型看到了 `[{ "type": "rect", ... }]`，自然就知道"它"指的是矩形，只需要改 `fill` 就行。

## 四、 完整代码

修改完成后的 `draw.service.ts` 完整代码如下：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { START, END, Annotation, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { brandThemeTool, githubTool, weatherTool } from './tool.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { streamObject } from 'ai';
import { MemorySaver } from '@langchain/langgraph'; // 👈 1. 引入记忆存储器

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
  private tools = [brandThemeTool, weatherTool, githubTool];
  private aliyun: any;
  private readonly logger = new Logger(DrawService.name);
  // 👇 2. 实例化一个内存存储器（你可以把它想象成 AI 的海马体）
  private checkpointer = new MemorySaver();

  constructor(private configService: ConfigService) {
    this.initGraph();
    this.initAliyun();
  }

  private initAliyun() {
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');
    this.aliyun = createOpenAI({
      apiKey: apiKey,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  }

  private initGraph() {
    const apiKey = this.configService.get<string>('DASHSCOPE_API_KEY');
    const model = new ChatOpenAI({
      apiKey: apiKey,
      model: 'qwen-turbo',
      configuration: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });

    const modelWithTools = model.bindTools(this.tools);

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

      // 🔑 构建"上一轮已有图形"的上下文，让大模型知道画布当前状态
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

    // ==========================================
    // 3. 编排工作流
    // ==========================================
    const workflow = new StateGraph(GraphState)
      .addNode('agent', agentNode)
      .addNode('tools', toolNode)
      .addNode('extractor', extractorNode)
      .addEdge(START, 'agent')

      .addConditionalEdges('agent', (state) => {
        const lastMsg = state.messages[state.messages.length - 1];
        if ((lastMsg.tool_calls?.length ?? 0) > 0) {
          return 'tools';
        }
        return 'extractor';
      })

      .addEdge('tools', 'agent')
      .addEdge('extractor', END);

    // 💡 3. 核心魔法：编译时开启记忆机制！
    this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
  }

  // 供 Controller 调用的入口
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

      return { success: true, shapes: finalState.shapes };
    } catch (error) {
      this.logger.error(`Agent 运行失败: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}
```

## 五、 见证奇迹的时刻

保存所有代码，重启 NestJS。打开 Swagger 或 Postman，我们来做一个完整的多轮对话测试：

**第一轮**：`{ "text": "画一个红色的矩形" }`

```json
{
  "success": true,
  "shapes": [{ "type": "rect", "width": 200, "height": 100, "fill": "#FF6B6B" }]
}
```

✅ 红色矩形，完美。

**第二轮**：`{ "text": "把它的颜色改成蓝色，形状保持不变" }`

```json
{
  "success": true,
  "shapes": [{ "type": "rect", "width": 200, "height": 100, "fill": "#1E90FF" }]
}
```

✅ 形状依然是 `rect`，只有颜色从红变蓝！**AI 终于记住了画布上有什么！**

**第三轮**：`{ "text": "再加一个圆形" }`

```json
{
  "success": true,
  "shapes": [
    { "type": "rect", "width": 200, "height": 100, "fill": "#1E90FF" },
    { "type": "circle", "width": 80, "height": 80, "fill": "#4CAF50" }
  ]
}
```

✅ 在保留蓝色矩形的基础上，新增了一个圆形。**真正的增量编辑！**

## 六、 原理图解：记忆到底是怎么流转的？

让我们用一张图来看看，有了 Checkpointer 之后，两轮对话的数据流转过程：

```
┌─── 第一轮对话 ──────────────────────────────────────────┐
│                                                           │
│  用户: "画一个红色的矩形"                                    │
│    ↓                                                      │
│  invoke({ userInput, messages: [HumanMessage] },           │
│         { configurable: { thread_id: 'session-1' } })      │
│    ↓                                                      │
│  [agent] → [extractor] → shapes: [{ type: "rect", ... }]  │
│    ↓                                                      │
│  ✅ MemorySaver 自动存档：                                  │
│     session-1 → { messages: [...], shapes: [...] }         │
│                                                           │
└───────────────────────────────────────────────────────────┘
                          ↓
┌─── 第二轮对话 ──────────────────────────────────────────┐
│                                                           │
│  用户: "把颜色改成蓝色"                                     │
│    ↓                                                      │
│  invoke({ userInput, messages: [HumanMessage] },           │
│         { configurable: { thread_id: 'session-1' } })      │
│    ↓                                                      │
│  🔑 MemorySaver 自动读档：                                  │
│     session-1 → 恢复 { messages: [上一轮全部], shapes: [...] } │
│    ↓                                                      │
│  [agent] → [extractor]                                     │
│     prompt 中包含: "当前画布已有图形: [{ type: rect, ... }]"  │
│    ↓                                                      │
│  shapes: [{ type: "rect", fill: "#1E90FF" }] ← 只改了颜色！ │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

## 七、 小结

| 概念 | 作用 | 类比 |
|------|------|------|
| `MemorySaver` | 内存级状态存储器 | AI 的海马体 |
| `checkpointer` | 编译时注入，开启自动存/读档 | 游戏存档系统 |
| `thread_id` | 区分不同会话的唯一标识 | 微信聊天窗口 |
| `state.shapes` 注入 prompt | 让提取器知道画布当前状态 | 翻开笔记本做题 |

**核心要点**：

1. **接入记忆只需三步**：引入 `MemorySaver` → 编译时传 `checkpointer` → 调用时传 `thread_id`
2. **记忆存了不等于记忆用了**：`Checkpointer` 负责存/读 `state`，但**你的节点逻辑必须主动从 `state` 中读取并使用**这些历史数据
3. **提取器是最容易被忽略的环节**：它是一次独立的大模型调用，必须在 prompt 中显式注入上一轮的结果，否则大模型只能靠猜

下一篇，我们将探索如何把 `MemorySaver` 替换为 **持久化存储**（如 Redis），让 AI 的记忆在服务重启后依然保留。敬请期待！
