前面几篇中，我们的 AI Agent 已经能根据一句话生成图形、记住对话上下文、甚至在服务重启后恢复记忆。但有一个问题一直被忽略：

**AI 说画什么就画什么，用户完全没有反驳的机会。**

想象一下：你说"画一个红色的矩形"，AI 理解成了"画一个红色的圆形"——它直接就渲染到画布上了。你还没来得及说"不对"，画布已经被覆盖了。

在真实的生产环境中，这种"AI 一言堂"的模式是很危险的。比如：
- AI 决定调用一个会扣费的 API
- AI 要往数据库里写入数据
- AI 生成的图形配置不符合预期

我们需要一个机制：**让 AI 先"举手报告"，等人类确认后再执行。** 这就是 **Human-in-the-Loop（人在回路中）**。

## 一、 核心概念：interrupt() 与 Command

LangGraph 提供了一对优雅的 API 来实现这个机制：

### `interrupt()` —— 按下暂停键

在任何节点中调用 `interrupt()`，图的执行会立刻**冻结**在当前位置。就像你打游戏时按下了暂停键：

- 所有状态被 Checkpointer（Redis）自动存档
- `interrupt()` 的参数会通过 `__interrupt__` 字段返回给调用者
- 图将无限期等待，直到你用 `Command` 恢复它

```typescript
import { interrupt } from '@langchain/langgraph';

const reviewNode = async (state) => {
  // 图的执行在这里冻结！
  const decision = interrupt({
    message: '请确认是否渲染以下图形',
    shapes: state.shapes,
  });

  // ⬇️ 以下代码只有在用户 resume 之后才会执行
  if (decision === 'approve') {
    return { shapes: state.shapes };
  } else {
    return { shapes: [] };
  }
};
```

### `Command({ resume })` —— 按下继续键

当人类做出决策后，用 `Command({ resume: value })` 恢复执行。`resume` 的值会成为 `interrupt()` 的返回值：

```typescript
import { Command } from '@langchain/langgraph';

// 用户点击"确认" → resume 的值是 'approve'
await graph.invoke(new Command({ resume: 'approve' }), config);

// 用户点击"拒绝" → resume 的值是 'reject'
await graph.invoke(new Command({ resume: 'reject' }), config);
```

### 一图看懂

```
用户: "画一个红色矩形"
  ↓
[agent] → [extractor] → shapes: [{ type: "rect", fill: "#FF6B6B" }]
  ↓
[review] → interrupt({ shapes: [...] })  ⏸️ 冻结！
  ↓
← 返回给前端: { status: "pending_review", shapes: [...] }
  ↓
前端展示预览，用户点击 ✅ 确认
  ↓
Command({ resume: 'approve' })  ▶️ 恢复！
  ↓
[review] 继续执行 → shapes 不变 → END
  ↓
← 返回给前端: { status: "approved", shapes: [...] }
  ↓
前端正式渲染到画布
```

## 二、 重要前提：Checkpointer 必须存在

`interrupt()` **必须搭配 Checkpointer 使用**。因为暂停时需要把图的状态存档，恢复时需要读档。我们上一篇已经接入了 Redis，所以这个条件已经满足。

如果没有 Checkpointer，调用 `interrupt()` 会报错。

## 三、 后端改造：插入审核节点

### 1. 引入 interrupt 和 Command

在 `draw.service.ts` 顶部追加引入：

```typescript
import { START, END, Annotation, StateGraph, interrupt, Command } from '@langchain/langgraph';
```

### 2. 新增 reviewNode —— 人工审核节点

在 `extractorNode` 之后，新增一个审核节点：

```typescript
// --- 节点 D: 人工审核节点（Human-in-the-Loop 的核心！） ---
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
```

### 3. 修改工作流编排

把 `extractor → END` 改为 `extractor → review → END`：

```diff
  const workflow = new StateGraph(GraphState)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addNode('extractor', extractorNode)
+   .addNode('review', reviewNode)     // 新增审核节点
    .addEdge(START, 'agent')

    .addConditionalEdges('agent', (state) => {
      const lastMsg = state.messages[state.messages.length - 1];
      if ((lastMsg.tool_calls?.length ?? 0) > 0) {
        return 'tools';
      }
      return 'extractor';
    })

    .addEdge('tools', 'agent')
-   .addEdge('extractor', END);
+   // 改动：extractor 完成后走向 review 审核节点，而不是直接 END
+   .addEdge('extractor', 'review')
+   .addEdge('review', END);
```

### 4. 修改 draw() 方法 —— 处理 interrupt 返回

```typescript
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
```

当 `invoke()` 执行到 `interrupt()` 时，它不会抛错，而是正常返回——但返回值中会多一个 `__interrupt__` 字段，里面包含我们传给 `interrupt()` 的参数。我们据此判断：需要前端确认。

### 5. 新增 resumeDraw() 方法 —— 恢复执行

```typescript
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
```

注意：`invoke()` 的第一个参数不再是 state 对象，而是 `new Command({ resume: decision })`。LangGraph 会根据 `thread_id` 找到之前暂停的位置，把 `decision` 注入为 `interrupt()` 的返回值，然后从断点处继续执行。

## 四、 Controller 层：新增恢复接口

在 `draw.controller.ts` 中新增 `/api/draw-resume` 接口：

```typescript
// 👇 新增：恢复执行接口（用户确认或拒绝后调用）
@Post('draw-resume')
@HttpCode(200)
@ApiOperation({ summary: '确认/拒绝图形（Human-in-the-Loop）' })
@ApiBody({ type: ResumeDrawDto })
async resumeDraw(@Body() body: ResumeDrawDto): Promise<DrawResponseDto> {
  if (!body.sessionId || !body.decision) {
    throw new BadRequestException('请提供 sessionId 和 decision');
  }

  try {
    return await this.drawService.resumeDraw(body.sessionId, body.decision);
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

`ResumeDrawDto` 只需要两个字段：

```typescript
export class ResumeDrawDto {
  @ApiProperty({ description: '会话ID', example: 'session-1711234567890' })
  sessionId: string;

  @ApiProperty({
    description: '用户决策：approve（确认）或 reject（拒绝）',
    enum: ['approve', 'reject'],
  })
  decision: 'approve' | 'reject';
}
```

## 五、 前端改造：预览 + 确认/拒绝

前端的逻辑分为两个阶段：

### 阶段一：发送指令，收到"待审核"的响应

```javascript
const response = await fetch('http://localhost:3000/api/draw', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: text, sessionId: sessionId })
});

const data = await response.json();

if (data.status === 'pending_review') {
  // AI 已生成图形方案，展示预览
  reviewContent.textContent = JSON.stringify(data.shapes, null, 2);
  reviewPanel.style.display = 'block';

  // 画布半透明预览（表示"尚未确认"）
  renderShapes(data.shapes);
  layer.opacity(0.5);
  layer.draw();
}
```

### 阶段二：用户点击确认/拒绝

```javascript
// ✅ 确认按钮
approveBtn.addEventListener('click', async () => {
  const response = await fetch('http://localhost:3000/api/draw-resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, decision: 'approve' })
  });

  const data = await response.json();
  if (data.status === 'approved') {
    renderShapes(data.shapes);
    layer.opacity(1);  // 恢复不透明度
    layer.draw();
  }
});

// ❌ 拒绝按钮
rejectBtn.addEventListener('click', async () => {
  const response = await fetch('http://localhost:3000/api/draw-resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, decision: 'reject' })
  });

  const data = await response.json();
  if (data.status === 'rejected') {
    layer.destroyChildren();  // 清空画布
    layer.opacity(1);
    layer.draw();
  }
});
```

画布上的**半透明**效果是一个很细的交互细节——它清晰地告诉用户："这只是预览，还没有最终确认"。

## 六、 见证奇迹的时刻

保存代码，重启 NestJS。打开 `index.html`，输入：**"画一个蓝色的大圆形"**

### 阶段一：AI 生成方案，暂停等待

点击发送后，你会看到：

1. 页面顶部出现蓝色状态条：`⏸️ AI 已生成图形方案，请在下方确认或拒绝`
2. 弹出黄色审核面板，展示 JSON 配置：
```json
[
  {
    "type": "circle",
    "width": 200,
    "height": 200,
    "fill": "#1E90FF"
  }
]
```
3. 画布上出现一个**半透明**的蓝色圆形（预览效果）

此时后端的工作流已经被 `interrupt()` **冻结**，静静等待你的决策。

### 阶段二A：点击 ✅ 确认

圆形的透明度恢复到 100%，审核面板消失，状态条变绿：`✅ 图形已确认并渲染！`

### 阶段二B：点击 ❌ 拒绝

画布被清空，审核面板消失，状态条提示：`🔄 已拒绝，请重新输入指令`

## 七、 原理图解

```
┌─── 第一次 invoke（触发 interrupt） ───────────────────┐
│                                                         │
│  POST /api/draw { text: "画一个蓝色圆形" }               │
│    ↓                                                    │
│  [START] → [agent] → [extractor] → shapes 生成完毕       │
│    ↓                                                    │
│  [review] → interrupt({ shapes: [...] })  ⏸️ 冻结！      │
│    ↓                                                    │
│  ← 返回: {                                              │
│       status: "pending_review",                         │
│       shapes: [{ type: "circle", fill: "#1E90FF" }],    │
│       __interrupt__: [{ value: { shapes: [...] } }]     │
│     }                                                   │
│                                                         │
│  🔒 状态已存入 Redis，等待 resume                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─── 第二次 invoke（用 Command 恢复） ─────────────────────┐
│                                                         │
│  POST /api/draw-resume { decision: "approve" }           │
│    ↓                                                    │
│  invoke(new Command({ resume: "approve" }), config)      │
│    ↓                                                    │
│  🔓 从 Redis 读档，恢复到 interrupt 断点处                │
│    ↓                                                    │
│  [review] → humanDecision = "approve"                    │
│           → return { shapes: state.shapes }  ← 保留      │
│    ↓                                                    │
│  [END]                                                  │
│    ↓                                                    │
│  ← 返回: { status: "approved", shapes: [...] }           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 八、 小结

| 概念 | 作用 | 类比 |
|------|------|------|
| `interrupt(payload)` | 暂停图的执行，payload 返回给调用者 | 游戏中按暂停 |
| `Command({ resume })` | 恢复执行，resume 值注入为 interrupt 返回值 | 按继续键 |
| `__interrupt__` | invoke 返回值中的字段，包含暂停时的 payload | 暂停画面上的提示语 |
| `reviewNode` | 审核节点，夹在 extractor 和 END 之间 | 质检员 |
| 半透明预览 | 前端交互细节，表示"尚未确认" | 水印 / 草稿 |

**核心要点**：

1. **`interrupt()` 必须搭配 Checkpointer**：没有存档机制就无法暂停/恢复
2. **同一个 `thread_id`**：暂停和恢复必须使用同一个会话 ID
3. **`Command({ resume })` 是唯一的恢复方式**：resume 的值就是 interrupt 的返回值
4. **节点会从头重新执行**：恢复时，interrupt 所在的节点会从第一行重新执行，所以 interrupt 之前的代码要保证**幂等性**
5. **前端体验很重要**：半透明预览 + 审核面板，让用户清楚地知道"AI 在等我确认"
