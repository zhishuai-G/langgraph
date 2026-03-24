**Generative UI（流式渲染）** 彻底打破了这个僵局。它的核心思想是：**大模型脑子里每想出一个字、一个属性，后端就立刻推给前端，前端拿到半截数据直接开始画图。** 这种效果就像是你在亲眼看着 AI 一笔一划地在画布上把图形勾勒出来。

## 一、 核心原理解析：如何传输“半截” JSON？
流式渲染最大的技术难点在于：**JSON 必须是完整的才能被解析（**`**JSON.parse**`**）。** 如果大模型只吐出了一半的数据 `{"shapes": [{"type": "rect", "wi`，前端直接解析必定会报语法错误，导致画布崩溃。

幸运的是，我们使用的 **Vercel AI SDK** 提供了一个神级 API：`streamObject`。 它在底层帮你做了一件极其复杂的事：**实时修补残缺的 JSON，并将其转化为合法的 JavaScript 对象流 (**`**partialObjectStream**`**)。**

今天，我们将利用这个特性，结合 NestJS 的 **SSE (Server-Sent Events，服务器推送事件)**，让 Konva 画布动起来！

## 二、 后端改造：在 NestJS 中暴露流式接口
为了不破坏我们上一篇写好的、带有复杂工具调用的 Agent，我们可以在 `DrawService` 里新增一个专门用于流式生成的轻量级方法。

### 1. 编写流式 Service
打开 `draw.service.ts`，新增一个 `streamDraw` 方法：

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
```

### 2. 暴露流式 Controller
在你的 `draw.controller.ts` 中，挂载这个新方法：

```typescript
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
  @ApiOperation({ summary: '生成图形', description: '根据用户指令调用 AI 生成图形配置' })
  @ApiBody({
    type: DrawDto,
    description: '用户绘图指令',
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
```

## 三、 前端改造：接收数据流并动态渲染画布
后端的“水管”已经接好了，现在我们要改造 `index.html`，让前端能一口一口地喝水，并实时反映在画布上。

因为我们用的是原生的 `fetch` 发起 POST 请求，我们需要利用 `ReadableStream` 来解析后端源源不断推送过来的数据片段。

修改你 `index.html` 里的点击事件逻辑：

```typescript
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>AI Agent 驱动的 Konva 画布</title>
  <script src="https://unpkg.com/konva@9.3.6/konva.min.js"></script>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #f0f2f5; }
    .control-panel { margin-bottom: 20px; display: flex; gap: 10px; }
    input { flex: 1; padding: 10px; font-size: 16px; border: 1px solid #ccc; border-radius: 4px; }
    button { padding: 10px 20px; font-size: 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:disabled { background: #ccc; }
    /* 给画布加个漂亮的白底和阴影 */
    #container { background: white; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; }
  </style>
</head>
<body>

  <h2>✨ 对话即画图 (AI Agent + Konva.js)</h2>
  
  <div class="control-panel">
    <input type="text" id="userInput" placeholder="例如：帮我画一个蓝色的长方形，稍微宽一点" />
    <button id="sendBtn">发送给 AI</button>
  </div>

  <div id="container"></div>

  <script>
    // 1. 初始化 Konva 舞台和图层
    const stage = new Konva.Stage({
      container: 'container',
      width: window.innerWidth - 40,
      height: 800,
    });
    const layer = new Konva.Layer();
    stage.add(layer);

    const input = document.getElementById('userInput');
    const btn = document.getElementById('sendBtn');

    // 2. 点击发送按钮的逻辑
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      btn.innerText = "AI 正在思考...";
      btn.disabled = true;

      try {
      // 1. 发起流式请求到正确的接口
      const response = await fetch('http://localhost:3000/api/stream-draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text })
      });

      // 2. 获取数据流阅读器
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // 3. 开启死循环，不断读取数据流
      while (true) {
        const { done, value } = await reader.read();
        if (done) break; // 数据流结束，跳出循环

        // 将二进制数据解码成字符串片段
        const chunk = decoder.decode(value, { stream: true });
        
        // 按照 SSE 规范，用双换行符切割数据块
        const lines = chunk.split('\n\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6); // 截取 "data: " 后面的内容
            
            if (dataStr === '[DONE]') {
              console.log('🎉 渲染完成！');
              continue;
            }

            try {
              // 4. 解析大模型传来的“半成品” JSON
              const partialData = JSON.parse(dataStr);
              
              if (partialData.shapes && partialData.shapes.length > 0) {
                // 清空旧图形
                layer.destroyChildren();

                // 5. 动态渲染：防范属性缺失
                partialData.shapes.forEach(shape => {
                  let konvaNode;
                  
                  // 注意：因为是流式输出，width/height/fill 可能还没生成出来！
                  // 我们需要给它们一个默认值，这样就能看到图形“从小变大”的动画效果
                  const currentWidth = shape.width || 10; 
                  const currentFill = shape.fill || '#e0e0e0'; // 没出颜色前显示灰色

                  if (shape.type === 'rect') {
                    konvaNode = new Konva.Rect({
                      x: 300, y: 200,
                      width: currentWidth,
                      height: shape.height || 10,
                      fill: currentFill,
                    });
                  } else if (shape.type === 'circle') {
                    konvaNode = new Konva.Circle({
                      x: 400, y: 250,
                      radius: currentWidth / 2,
                      fill: currentFill,
                    });
                  }

                  if (konvaNode) layer.add(konvaNode);
                });
                
                layer.draw(); // 强制 Konva 重绘
              }
            } catch (e) {
              // 忽略解析错误（由于数据截断可能会偶尔报错，流式渲染中属正常现象）
            }
          }
        }
      }
    } catch (err) {
        alert("网络请求失败");
      } finally {
        btn.innerText = "发送给 AI";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>
```

## 四、 见证奇迹的时刻
保存所有代码，重启 NestJS。 打开页面，输入：**“画一个红色的巨大圆形”**。

点击发送后，**注意观察你的屏幕**！ 你不会再像以前那样干等 3 秒。相反，几乎在点击的瞬间，画布上会突然出现一个**灰色的、极其微小的圆点**。 紧接着（随着大模型在后台推算数据），这个小圆点会**瞬间膨胀**变成一个大圆，然后“唰”地一下**变成了红色**！

整个过程只有零点几秒，但这种“图形随着 AI 思考过程动态生长”的视觉冲击力，就是当下最流行的 **Generative UI** 的核心魅力！

