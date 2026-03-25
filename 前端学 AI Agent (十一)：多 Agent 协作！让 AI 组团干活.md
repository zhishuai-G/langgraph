前面十篇中，我们的画布 Agent 一直是"孤军奋战"——一个 Agent 既要理解需求，又要选颜色，还要排版布局。就像一个人同时干产品经理、设计师、前端工程师三份工。

**结果呢？prompt 越写越长，AI 越来越容易"犯糊涂"。**

想象一个真实的设计团队：产品经理分析需求、设计师画线框、配色师调色、前端排版——每个人只做自己最擅长的事。我们能不能让 AI 也这样分工？

这就是 **多 Agent 协作（Multi-Agent Collaboration）**。

## 一、 为什么需要多 Agent？

先看看单 Agent 的问题：

```
用户: "用 #FF6B6B 色系画三个不同大小的圆"
  ↓
[单 Agent] 一个节点要同时做：
  1. 理解"三个圆，不同大小" → 确定图形规格
  2. 理解"#FF6B6B 色系" → 查配色 API，挑选和谐色
  3. 确定三个圆在画布上的位置 → 不重叠、美观
  4. 把以上所有信息整合成 JSON
```

一个 prompt 塞进去所有指令，AI 经常顾此失彼——记住了颜色忘了尺寸，或者位置全挤在一起。

**多 Agent 的思路：拆！**

```
用户: "用 #FF6B6B 色系画三个不同大小的圆"
  ↓
[Supervisor]  → "需要 3 个不同大小的圆形，风格：柔和"
  ↓
[Designer]   → [{ circle, 160 }, { circle, 100 }, { circle, 60 }]（只管形状大小）
  ↓
[Colorist]   → 调用 The Color API，拿到 #FF6B6B 的类似色方案 → 填上颜色
  ↓
[Layouter]   → 算好 x, y 坐标 → 三个圆错落排列，不重叠
  ↓
[Review]     → 人工确认 → 渲染
```

每个 Agent 的 prompt 又短又精确，出错率大幅下降。

## 二、 核心概念：共享状态就是"白板"

多 Agent 协作的本质只有一个：**所有 Agent 读写同一个 State**。

想象一个团队围着一块白板工作：
- Supervisor 在白板上写下"设计方案"
- Designer 看方案，在白板上画出"图形骨架"
- Colorist 看骨架，在白板上标注"颜色"
- Layouter 看所有信息，在白板上标注"位置"

翻译成代码：

```typescript
const MultiAgentState = Annotation.Root({
  userInput:     Annotation<string>(...),   // 用户原始输入
  messages:      Annotation<any[]>(...),    // 消息流
  designPlan:    Annotation<string>(...),   // Supervisor 写的
  shapeDrafts:   Annotation<any[]>(...),    // Designer 写的
  coloredShapes: Annotation<any[]>(...),    // Colorist 写的
  shapes:        Annotation<any[]>(...),    // Layouter 写的（最终产出）
  currentAgent:  Annotation<string>(...),   // 当前是谁在干活
});
```

对比之前的单 Agent，state 里只有 `messages` + `shapes`。现在多了 `designPlan`、`shapeDrafts`、`coloredShapes`——这些**中间产物**就是多 Agent 协作的证据。

## 三、 工具设计：全部调用真实 API

之前的工具（品牌色字典、GitHub 查粉丝、天气查询）跟画图关系太弱。这次我们为 Colorist 配备三个**真正有用**的配色工具，全部调用真实的开放 API：

| 工具 | 调用的 API | 用途 |
|------|-----------|------|
| `generate_color_scheme` | thecolorapi.com | 给定基础色+模式，生成专业配色方案 |
| `get_ai_palette` | colormind.io | AI 深度学习生成 5 色调色板 |
| `resolve_color` | thecolorapi.com | 查询颜色的详细信息（名称、对比色等） |

### 工具 1：配色方案生成（The Color API）

这个 API 基于色彩理论，支持互补色、类似色、三角色等 6 种配色模式：

```typescript
export const colorSchemeTool = tool(
  async ({ hex, mode, count }) => {
    const cleanHex = hex.replace('#', '');
    const url = `https://www.thecolorapi.com/scheme?hex=${cleanHex}&mode=${mode}&count=${count}`;

    console.log(`🌐 [API 请求] 调用 The Color API: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`API 返回 ${response.status}`);
      }

      const data = await response.json();

      const colors = data.colors.map((c: any) => ({
        hex: c.hex.value,
        name: c.name.value,
        rgb: c.rgb.value,
      }));

      const result = `基于 #${cleanHex} 生成的「${data.mode}」配色方案（共 ${colors.length} 色）：
${colors.map((c: any, i: number) => `  ${i + 1}. ${c.hex} — ${c.name} (${c.rgb})`).join('\n')}

种子色: ${data.seed.hex.value} (${data.seed.name.value})`;

      console.log(`📥 [API 返回] ${result}`);
      return result;
    } catch (error) {
      return `配色方案生成失败：${error.message}`;
    }
  },
  {
    name: 'generate_color_scheme',
    description: '调用 The Color API 生成专业配色方案。给定一个基础颜色和配色模式，返回一组和谐的颜色。',
    schema: z.object({
      hex: z.string().describe('基础颜色的十六进制值，如 #FF6B6B 或 FF6B6B'),
      mode: z.enum(['complement', 'analogic', 'triad', 'split-complement', 'monochrome', 'quad'])
        .describe('配色模式'),
      count: z.number().min(2).max(10).default(5).describe('生成几个颜色，默认 5'),
    }),
  },
);
```

实际请求示例：
```
GET https://www.thecolorapi.com/scheme?hex=FF6B6B&mode=analogic&count=3

返回：
  1. #FF6B6B — Bittersweet
  2. #FF6BAF — Hot Pink
  3. #FF6BF3 — Pink Flamingo
```

### 工具 2：AI 调色板（Colormind API）

Colormind 不是简单的色彩数学——它是一个**深度学习模型**，训练数据来自真实的设计作品、电影海报、艺术品。它生成的调色板带有"审美"：

```typescript
export const aiPaletteTool = tool(
  async ({ lockedColors }) => {
    console.log(`🌐 [API 请求] 调用 Colormind AI 调色板...`);

    try {
      // 构建 input：锁定的颜色用 [R,G,B]，空位用 "N"
      const input: any[] = ['N', 'N', 'N', 'N', 'N'];

      if (lockedColors && lockedColors.length > 0) {
        lockedColors.forEach((hex, i) => {
          if (i < 5) {
            const clean = hex.replace('#', '');
            input[i] = [
              parseInt(clean.slice(0, 2), 16),
              parseInt(clean.slice(2, 4), 16),
              parseInt(clean.slice(4, 6), 16),
            ];
          }
        });
      }

      const response = await fetch('http://colormind.io/api/', {
        method: 'POST',
        body: JSON.stringify({ model: 'default', input }),
      });

      if (!response.ok) {
        throw new Error(`Colormind API 返回 ${response.status}`);
      }

      const data = await response.json();

      // 将 RGB 数组转为 hex
      const palette = data.result.map((rgb: number[]) => {
        const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
        return { hex, rgb: `rgb(${rgb.join(', ')})` };
      });

      const lockedInfo = lockedColors && lockedColors.length > 0
        ? `（已锁定 ${lockedColors.join(', ')} 作为基准）`
        : '（完全由 AI 自由生成）';

      return `Colormind AI 生成的 5 色调色板${lockedInfo}：
${palette.map((c: any, i: number) => `  ${i + 1}. ${c.hex} (${c.rgb})`).join('\n')}

建议用法：第 1 色作为背景/最浅色，第 3 色作为主色，第 5 色作为强调/最深色。`;
    } catch (error) {
      return `AI 调色板生成失败：${error.message}`;
    }
  },
  {
    name: 'get_ai_palette',
    description: '调用 Colormind AI 生成 5 色调色板。可以锁定 1-4 个颜色让 AI 生成搭配色。',
    schema: z.object({
      lockedColors: z.array(z.string()).max(4).optional()
        .describe('要锁定的颜色（十六进制）。AI 会生成与这些颜色搭配的其余颜色。'),
    }),
  },
);
```

Colormind 的核心能力是**锁定**：你给它一个红色，它会生成与红色和谐搭配的其余 4 个颜色。这比随机选色靠谱得多。

### 工具 3：颜色信息查询（The Color API）

```typescript
export const resolveColorTool = tool(
  async ({ hex }) => {
    const cleanHex = hex.replace('#', '');
    const url = `https://www.thecolorapi.com/id?hex=${cleanHex}`;

    const response = await fetch(url);
    const data = await response.json();

    return `颜色 #${cleanHex} 的详细信息：
  名称: ${data.name.value}
  HEX: ${data.hex.value}
  RGB: ${data.rgb.value}
  HSL: ${data.hsl.value}
  对比色: ${data.contrast.value}`;
  },
  {
    name: 'resolve_color',
    description: '查询颜色的详细信息，包括标准名称、RGB/HSL 值、对比色等。',
    schema: z.object({
      hex: z.string().describe('颜色的十六进制值，如 FF7F50 或 #FF7F50'),
    }),
  },
);
```

三个工具全部是**真实网络请求**，无任何硬编码数据。这才是 Agent 工具该有的样子——Agent 调用工具获取**它自己不知道**的信息。

## 四、 定义 4 个 Agent

### Agent 1：Supervisor（主管）

职责：分析需求，输出设计方案。不做具体设计、配色、布局。

```typescript
const supervisorNode = async (state: typeof MultiAgentState.State) => {
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

  return {
    designPlan: result.plan,
    currentAgent: 'supervisor',
    messages: [new HumanMessage(`[Supervisor] ${result.plan}`)],
  };
};
```

注意：Supervisor 用的是 `withStructuredOutput`，直接输出结构化的设计方案。没有绑定任何工具。

### Agent 2：Designer（设计师）

职责：根据 Supervisor 的方案，确定图形的类型和尺寸。**不管颜色、不管位置。**

```typescript
const designerNode = async (state: typeof MultiAgentState.State) => {
  const model = createModel('qwen-turbo');
  const structuredModel = model.withStructuredOutput(SHAPE_DRAFT_SCHEMA);

  const result = await structuredModel.invoke([
    new SystemMessage(`你是图形设计师，根据设计方案确定图形的类型和尺寸。
规则：
1. 只确定 type（rect 或 circle）、width、height
2. 不要决定颜色（那是配色师的工作）
3. 不要决定位置（那是布局师的工作）
4. 圆形的 width 和 height 应该相同`),
    new HumanMessage(`用户需求：${state.userInput}\n设计方案：${state.designPlan}`),
  ]);

  return {
    shapeDrafts: result.shapes,  // 写入"图形骨架"
    currentAgent: 'designer',
  };
};
```

关键点：Designer 读取的是 `state.designPlan`——这是 Supervisor 写到"白板"上的产出。

### Agent 3：Colorist（配色师）—— 唯一带工具的 Agent

这是最复杂的 Agent，因为它需要决定**是否调用工具**：

```typescript
const coloristModel = createModel('qwen-turbo');
const coloristWithTools = coloristModel.bindTools(this.colorTools);

const coloristNode = async (state: typeof MultiAgentState.State) => {
  const response = await coloristWithTools.invoke([
    new SystemMessage(`你是专业配色师。你有三个工具：
1. generate_color_scheme：给定基础色，生成配色方案
2. get_ai_palette：让 AI 自由生成调色板
3. resolve_color：查询颜色详情

使用策略：
- 用户指定了颜色 → 用 generate_color_scheme 扩展
- 用户没指定颜色 → 用 get_ai_palette 让 AI 生成
- 需要确认颜色信息 → 用 resolve_color 查详情`),
    new HumanMessage(`用户需求：${state.userInput}\n待配色的图形：${JSON.stringify(state.shapeDrafts)}`),
  ]);

  // AI 决定是否调用工具
  if ((response.tool_calls?.length ?? 0) > 0) {
    return { messages: [response], currentAgent: 'colorist' };
  }
  return { messages: [response], currentAgent: 'colorist' };
};
```

注意：**只有 Colorist 绑定了工具**。Supervisor、Designer、Layouter 都是纯 AI 推理，不需要工具。这是多 Agent 的优势之一——工具和职责精确匹配。

### Agent 4：Layouter（布局师）

职责：拿到配好色的图形，在画布上排版。

```typescript
const layouterNode = async (state: typeof MultiAgentState.State) => {
  const model = createModel('qwen-turbo');
  const structuredModel = model.withStructuredOutput(FINAL_SHAPES_SCHEMA);

  const result = await structuredModel.invoke([
    new SystemMessage(`你是布局师，确定每个图形在画布上的位置。
画布大小：1200 x 600 像素。
规则：
1. 保持 type、width、height、fill 不变
2. 为每个图形确定 x、y 坐标
3. 图形之间不要重叠
4. 整体布局美观、居中`),
    new HumanMessage(`待布局的图形：${JSON.stringify(state.coloredShapes)}`),
  ]);

  return {
    shapes: result.shapes,  // 最终产出，包含 x, y 坐标
    currentAgent: 'layouter',
  };
};
```

Layouter 读取的是 `state.coloredShapes`——这是 Colorist 写到"白板"上的产出。每个 Agent 只读上一步的产出，不需要关心更早的步骤。

## 五、 编排工作流

这是多 Agent 协作的精华——用 `StateGraph` 把 4 个 Agent 串成流水线：

```typescript
const workflow = new StateGraph(MultiAgentState)
  .addNode('supervisor', supervisorNode)
  .addNode('designer', designerNode)
  .addNode('colorist', coloristNode)
  .addNode('color_tools', colorToolNode)
  .addNode('color_finalize', colorFinalizeNode)
  .addNode('layouter', layouterNode)
  .addNode('review', reviewNode)

  // 顺序管道
  .addEdge(START, 'supervisor')
  .addEdge('supervisor', 'designer')
  .addEdge('designer', 'colorist')

  // Colorist 的条件边：是否需要调用工具
  .addConditionalEdges('colorist', (state) => {
    const lastMsg = state.messages[state.messages.length - 1];
    if ((lastMsg.tool_calls?.length ?? 0) > 0) {
      return 'color_tools';     // 需要调 API
    }
    return 'color_finalize';    // 直接配色
  })

  .addEdge('color_tools', 'color_finalize')
  .addEdge('color_finalize', 'layouter')
  .addEdge('layouter', 'review')
  .addEdge('review', END);

this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
```

画成图：

```
  START
    │
    ▼
  supervisor  ──→  "需要 3 个圆，柔和风格"
    │
    ▼
  designer    ──→  [{ circle, 160 }, { circle, 100 }, { circle, 60 }]
    │
    ▼
  colorist    ──→  AI 决定是否调工具
    │
    ├── 需要调 API ──→ color_tools ──→ color_finalize
    │                                       │
    └── 不需要 ─────→ color_finalize ◀──────┘
                           │
                           ▼
                       layouter  ──→  确定 x, y 坐标
                           │
                           ▼
                        review   ──→  interrupt() 等待人工确认
                           │
                           ▼
                          END
```

## 六、 Controller 和 Module

Controller 的写法和单 Agent 版一样，只是换了个路由前缀：

```typescript
@ApiTags('multi-agent')
@Controller('api')
export class MultiAgentController {
  constructor(private readonly multiAgentService: MultiAgentService) {}

  @Post('multi-draw')
  @HttpCode(200)
  async draw(@Body() body: DrawDto): Promise<any> {
    return await this.multiAgentService.draw(body.text, body.sessionId);
  }

  @Post('multi-draw-resume')
  @HttpCode(200)
  async resumeDraw(@Body() body: ResumeDrawDto): Promise<any> {
    return await this.multiAgentService.resumeDraw(body.sessionId, body.decision);
  }
}
```

注册到 Module 中：

```typescript
@Module({
  controllers: [DrawController, MultiAgentController],
  providers: [DrawService, MultiAgentService],
})
export class DrawModule {}
```

原来的单 Agent 接口（`/api/draw`）还在，两套可以并行使用。

## 七、 前端改造：流水线可视化

多 Agent 的前端多了一个关键特性：**展示协作过程**。用户不仅能看到最终结果，还能看到每个 Agent 各自做了什么。

### 流水线进度条

```html
<div class="pipeline-steps">
  <span class="pipeline-step" id="step-supervisor">Supervisor (主管)</span>
  <span class="pipeline-arrow">→</span>
  <span class="pipeline-step" id="step-designer">Designer (设计师)</span>
  <span class="pipeline-arrow">→</span>
  <span class="pipeline-step" id="step-colorist">Colorist (配色 API)</span>
  <span class="pipeline-arrow">→</span>
  <span class="pipeline-step" id="step-layouter">Layouter (布局师)</span>
  <span class="pipeline-arrow">→</span>
  <span class="pipeline-step" id="step-review">Review (审核)</span>
</div>
```

每个步骤有三个状态：灰色（待执行）、蓝色脉冲（执行中）、绿色（已完成）。

### 展示每个 Agent 的产出

后端通过 `interrupt()` 的 `pipeline` 参数返回每个 Agent 的中间产出：

```typescript
// reviewNode 中
const humanDecision = interrupt({
  message: '多 Agent 协作完成，请确认是否渲染',
  shapes: state.shapes,
  pipeline: {
    designPlan: state.designPlan,        // Supervisor 的方案
    shapeDrafts: state.shapeDrafts,      // Designer 的骨架
    coloredShapes: state.coloredShapes,  // Colorist 的配色
    finalShapes: state.shapes,           // Layouter 的布局
  },
});
```

前端收到后展开显示：

```javascript
function showPipelineOutputs(pipeline) {
  if (pipeline.designPlan) {
    document.getElementById('planContent').textContent = pipeline.designPlan;
  }
  if (pipeline.shapeDrafts) {
    document.getElementById('draftsContent').textContent =
      JSON.stringify(pipeline.shapeDrafts, null, 2);
  }
  if (pipeline.coloredShapes) {
    document.getElementById('coloredContent').textContent =
      JSON.stringify(pipeline.coloredShapes, null, 2);
  }
  if (pipeline.finalShapes) {
    document.getElementById('finalContent').textContent =
      JSON.stringify(pipeline.finalShapes, null, 2);
  }
}
```

### 渲染图形（支持坐标）

和单 Agent 版不同，多 Agent 版的图形自带 `x`, `y` 坐标（Layouter 的产出）：

```javascript
function renderShapes(shapes) {
  layer.destroyChildren();
  shapes.forEach(shape => {
    let node;
    if (shape.type === 'rect') {
      node = new Konva.Rect({
        x: shape.x || 300,        // Layouter 给的坐标
        y: shape.y || 200,
        width: shape.width || 100,
        height: shape.height || 100,
        fill: shape.fill || '#ccc',
      });
    } else if (shape.type === 'circle') {
      node = new Konva.Circle({
        x: shape.x || 400,
        y: shape.y || 250,
        radius: (shape.width || 100) / 2,
        fill: shape.fill || '#ccc',
      });
    }
    if (node) layer.add(node);
  });
  layer.draw();
}
```

## 八、 见证奇迹的时刻

保存代码，重启 NestJS，打开 `multi-agent.html`。

输入：**"画三个不同大小的圆"**

### 后端控制台输出

```
🧠 [Supervisor] 分析用户需求...
📋 [Supervisor] 设计方案: 三个大小递减的圆形，简约风格
✏️ [Designer] 设计图形规格...
📐 [Designer] 图形骨架: [{ circle, 160 }, { circle, 100 }, { circle, 60 }]
🎨 [Colorist] 开始配色...
🔧 [Colorist] 调用 1 个工具
🛠️ [Color Tools] 执行 API 调用...
🌐 [API 请求] 调用 Colormind AI 调色板...
📥 [API 返回] Colormind AI 生成的 5 色调色板（完全由 AI 自由生成）：
  1. #2b3a4e (rgb(43, 58, 78))
  2. #5b8a72 (rgb(91, 138, 114))
  3. #e8c547 (rgb(232, 197, 71))
  4. #d4763e (rgb(212, 118, 62))
  5. #c24141 (rgb(194, 65, 65))
🎨 [Colorist] 根据 API 结果生成最终配色...
🎨 [Colorist] 配色结果: [{ fill: "#e8c547" }, { fill: "#5b8a72" }, { fill: "#c24141" }]
📍 [Layouter] 计算布局...
📍 [Layouter] 最终布局: [{ x: 300, y: 300 }, { x: 550, y: 300 }, { x: 730, y: 300 }]
⏸️ [Review] 等待人工审核...
```

你可以清楚地看到每个 Agent 各做了什么，以及 Colorist 真实调用了 Colormind API。

### 前端展示

1. 流水线进度条从左到右依次亮起
2. 弹出审核面板，展示最终图形配置
3. 点开 Agent 产出详情，能看到每一步的中间结果
4. 画布上出现三个半透明的不同颜色圆形（预览模式）
5. 点击"确认渲染"，圆形变为不透明，完成！

## 九、 原理图解

```
┌─── POST /api/multi-draw ──────────────────────────────────────┐
│                                                                  │
│  [START]                                                         │
│    ↓                                                             │
│  [supervisor]  → designPlan: "3个圆，简约"                        │
│    ↓                                                             │
│  [designer]    → shapeDrafts: [160, 100, 60]                     │
│    ↓                                                             │
│  [colorist]    → AI 决定调用 get_ai_palette                       │
│    ↓                                                             │
│  [color_tools] → 真实请求 colormind.io → 返回 5 色                │
│    ↓                                                             │
│  [color_finalize] → coloredShapes: 3 个带颜色的圆                  │
│    ↓                                                             │
│  [layouter]    → shapes: 3 个圆 + x,y 坐标                       │
│    ↓                                                             │
│  [review]      → interrupt() ⏸️                                  │
│    ↓                                                             │
│  ← 返回 { status: "pending_review", shapes, pipeline }           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌─── POST /api/multi-draw-resume ──────────────────────────────────┐
│                                                                    │
│  Command({ resume: "approve" })                                    │
│    ↓                                                               │
│  [review] 恢复 → shapes 保持 → [END]                               │
│    ↓                                                               │
│  ← 返回 { status: "approved", shapes: [...] }                      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## 十、 小结

### 单 Agent vs 多 Agent

| 维度 | 单 Agent | 多 Agent |
|------|---------|---------|
| prompt 复杂度 | 一个巨长 prompt | 每个 Agent 一个短 prompt |
| 出错率 | 高（顾此失彼） | 低（职责单一） |
| 工具分配 | 所有工具都绑一起 | 只给需要的 Agent |
| 可维护性 | 改 prompt 牵一发动全身 | 改一个 Agent 不影响其他 |
| 调试 | 黑盒，不知道哪步出错 | 每步有独立产出，一目了然 |
| 成本 | 1 次 LLM 调用 | 4+ 次 LLM 调用（更贵） |

### 何时用多 Agent？

- 任务可以拆成 **独立的、顺序的** 子任务 → 用
- 不同子任务需要 **不同工具** → 用
- 单 Agent prompt 超过 500 字还在加规则 → 该拆了
- 简单任务（"画个红色圆"）→ 没必要，单 Agent 足够

### 核心代码文件

| 文件 | 作用 |
|------|------|
| `tool.service.ts` | 3 个真实 API 工具 |
| `multi-agent.service.ts` | 多 Agent 工作流定义 |
| `multi-agent.controller.ts` | API 接口 |
| `draw.module.ts` | 模块注册 |
| `multi-agent.html` | 前端页面 |

### 关键概念

| 概念 | 作用 |
|------|------|
| 共享 State | 多 Agent 的"白板"，通过读写 State 传递信息 |
| 中间产物 | `designPlan` → `shapeDrafts` → `coloredShapes` → `shapes`，流水线的半成品 |
| 工具精确绑定 | 只有 Colorist 绑了工具，其他 Agent 纯推理 |
| 条件边 | Colorist 的工具调用分支，和单 Agent 时一样用 `addConditionalEdges` |
| pipeline 透传 | 通过 `interrupt()` 把所有中间产出返回给前端，实现协作过程可视化 |
