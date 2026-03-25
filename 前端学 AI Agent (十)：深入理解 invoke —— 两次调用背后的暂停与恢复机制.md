上一篇我们实现了 Human-in-the-Loop，让 AI 学会了"举手报告"。但如果你跟着做完后，心里可能还有一个疑问：

**`invoke()` 到底是怎么工作的？为什么调两次就能实现"暂停-恢复"？**

这篇文章不讲新功能，专门把 `invoke()` 和 `interrupt()` 的底层逻辑**拆干净**。

## 一、 先搞清楚 invoke() 的返回值

很多人以为 `invoke()` 返回的是"最后一个节点的输出"。**这是错的。**

`invoke()` 返回的是**整个 state 在那个时刻的快照**。

### 什么是 state？

回顾一下我们的状态定义：

```typescript
const GraphState = Annotation.Root({
  userInput: Annotation<string>(...),
  messages: Annotation<any[]>(...),
  shapes: Annotation<any[]>(...),
  errorLog: Annotation<string | null>(...),
  retryCount: Annotation<number>(...),
});
```

state 就像一张**共享白板**，所有节点都往上面写东西：

```
[agent 节点]     → 往 messages 里写入 AI 的回复
[extractor 节点] → 往 shapes 里写入图形配置
[review 节点]    → 读取 shapes，决定保留还是清空
```

`invoke()` 返回的就是这张白板在流程结束时的**最终状态**。

### 正常结束 vs interrupt 暂停

```typescript
// 正常结束（没有 interrupt）
const finalState = await agentApp.invoke({ userInput: "画一个圆" }, config);
// finalState = {
//   userInput: "画一个圆",
//   messages: [HumanMessage, AIMessage, ...],   ← agent 写的
//   shapes: [{ type: "circle", ... }],           ← extractor 写的
//   errorLog: null,
//   retryCount: 0,
// }

// interrupt 暂停
const finalState = await agentApp.invoke({ userInput: "画一个圆" }, config);
// finalState = {
//   userInput: "画一个圆",
//   messages: [HumanMessage, AIMessage, ...],   ← agent 写的
//   shapes: [{ type: "circle", ... }],           ← extractor 写的
//   errorLog: null,
//   retryCount: 0,
//
//   __interrupt__: [                             ← 多了这个！
//     {
//       value: {                                  ← interrupt() 的参数
//         message: "请确认是否渲染以下图形",
//         shapes: [{ type: "circle", ... }]
//       }
//     }
//   ]
// }
```

区别只有一个：暂停时多了 `__interrupt__` 字段。state 里的其他数据（messages、shapes 等）都是正常的——因为 agent 和 extractor 已经执行完了。

## 二、 interrupt() 到底干了什么？

来看 `reviewNode` 里的这行代码：

```typescript
const humanDecision = interrupt({
  message: '请确认是否渲染以下图形',
  shapes: state.shapes,
});
```

### 第一次执行（没有 resume 值）

`interrupt()` 内部做了这么一件事——**抛异常**：

```typescript
// interrupt 内部的伪代码
function interrupt(payload) {
  if (!当前有resume值) {
    throw new NodeInterrupt(payload);  // 💥 抛异常！
  }
  return resume的值;
}
```

抛异常意味着什么？意味着 `humanDecision` **永远不会被赋值**，`interrupt()` 后面的所有代码**全部跳过**：

```typescript
const reviewNode = async (state) => {
  console.log('⏸️ 暂停等待人工审核...');       // ✅ 执行了

  const humanDecision = interrupt({            // 💥 抛异常！
    message: '请确认',
    shapes: state.shapes,
  });
  // ─── 以下代码全部不执行 ───
  console.log('收到决策:', humanDecision);      // ❌ 跳过
  if (humanDecision === 'approve') {            // ❌ 跳过
    return { shapes: state.shapes };            // ❌ 跳过
  }
};
```

### LangGraph 在外层做了什么？

LangGraph 的运行时会**捕获**这个 `NodeInterrupt` 异常：

```typescript
// LangGraph 运行时的伪代码
async function executeNode(node, state) {
  try {
    const result = await node(state);
    return result;
  } catch (error) {
    if (error instanceof NodeInterrupt) {
      // 1. 把当前 state 存入 Redis（存档）
      await checkpointer.put(threadId, state);

      // 2. 记录：在哪个节点暂停的、interrupt 的参数是什么
      await checkpointer.putInterruptInfo(threadId, {
        node: 'review',
        value: error.payload,  // { message: '请确认', shapes: [...] }
      });

      // 3. 让 invoke() 返回，把 interrupt 信息塞进 __interrupt__
      return { ...state, __interrupt__: [{ value: error.payload }] };
    }
    throw error;  // 其他异常正常抛出
  }
}
```

所以整条链路是：

```
interrupt(payload)
  → 抛出 NodeInterrupt 异常
  → LangGraph 捕获异常
  → 存档到 Redis
  → invoke() 返回（带 __interrupt__）
  → 你的 draw() 方法拿到返回值
  → 检查 __interrupt__ → 返回 pending_review 给前端
```

## 三、 两次 invoke 的完整对比

### 第一次 invoke：触发暂停

```typescript
// draw() 方法中
const finalState = await this.agentApp.invoke(
  { userInput: "画一个红色矩形", messages: [new HumanMessage("画一个红色矩形")] },
  { configurable: { thread_id: "session-123" } }
);
```

invoke 内部执行流程：

```
1. 检查第一个参数 → 是普通对象 → "新任务"模式
2. 用 thread_id 查 Redis → 没有存档 → 从 START 开始
3. 执行 [agent] → state.messages 更新 → 存档到 Redis
4. 执行 [extractor] → state.shapes 更新 → 存档到 Redis
5. 执行 [review] → interrupt() 抛异常！
6. 捕获异常 → 存档到 Redis（记录暂停位置）
7. 返回 finalState（带 __interrupt__）
```

### 第二次 invoke：恢复执行

```typescript
// resumeDraw() 方法中
const finalState = await this.agentApp.invoke(
  new Command({ resume: 'approve' }),
  { configurable: { thread_id: "session-123" } }
);
```

invoke 内部执行流程：

```
1. 检查第一个参数 → 是 Command 对象 → "恢复"模式
2. 用 thread_id 查 Redis → 找到存档！
   → state: { userInput: "画一个红色矩形", shapes: [...], ... }
   → 暂停位置: review 节点
   → resume 值: 'approve'
3. 不执行 agent（已经执行过了）
4. 不执行 extractor（已经执行过了）
5. 重新执行 [review]（从第一行开始）：
   → interrupt() 检测到有 resume 值 → 不抛异常，直接返回 'approve'
   → humanDecision = 'approve'
   → return { shapes: state.shapes }
6. 执行 [END] → 流程正常结束
7. 返回 finalState（没有 __interrupt__，正常的 state）
```

### 关键区别一览

| | 第一次 invoke | 第二次 invoke |
|---|---|---|
| **参数** | 普通 state 对象 | `new Command({ resume })` |
| **LangGraph 理解为** | 新任务 | 恢复旧任务 |
| **从哪里开始** | START（第一个节点） | 暂停处（review 节点） |
| **interrupt() 行为** | 抛异常，函数中断 | 正常返回 resume 的值 |
| **返回值** | state + `__interrupt__` | 纯 state（流程走完了） |
| **Redis 操作** | 每个节点执行完都写入 | 读取存档 + 最终结果写入 |

## 四、 invoke 的第一个参数决定一切

这是理解整个机制的**钥匙**：

```typescript
// 情况 A：传普通对象 → 新任务
await agentApp.invoke(
  { userInput: "画一个圆", messages: [...] },    // ← 普通对象
  config
);
// LangGraph：这是一个新请求，从 START 开始执行

// 情况 B：传 Command → 恢复旧任务
await agentApp.invoke(
  new Command({ resume: 'approve' }),             // ← Command 对象
  config
);
// LangGraph：这是恢复请求，从 Redis 读档，从断点继续
```

LangGraph 内部用 `instanceof` 判断：

```typescript
// LangGraph 内部伪代码
async invoke(input, config) {
  const threadId = config.configurable.thread_id;

  if (input instanceof Command) {
    // 恢复模式
    const savedState = await this.checkpointer.get(threadId);  // 从 Redis 读档
    const resumeValue = input.resume;                           // 拿到 resume 值
    // 重新执行被暂停的节点，这次 interrupt() 会直接返回 resumeValue
  } else {
    // 新任务模式
    const initialState = input;                                 // 用传入的数据初始化 state
    // 从 START 节点开始执行
  }
}
```

## 五、 Redis 在整个过程中的角色

Redis 就像游戏里的**存档系统**：

```
第一次 invoke：
  [agent] 执行完 → 自动存档 ①
  [extractor] 执行完 → 自动存档 ②
  [review] interrupt → 自动存档 ③（标记暂停位置）

  （此时 Redis 里有 3 个存档点）

第二次 invoke：
  读取存档 ③ → 恢复到 review 节点
  [review] 正常结束 → 自动存档 ④
  [END] → 流程结束
```

这也是为什么 `interrupt()` 必须搭配 Checkpointer——没有存档系统，就没法暂停/恢复。我们用的 `RedisSaver` 就是一个基于 Redis 的存档系统。

你在代码里只写了两行：

```typescript
// 创建存档系统
this.checkpointer = await RedisSaver.fromUrl(redisUrl, { ... });

// 把存档系统注入给图
this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
```

之后所有的存档/读档操作，LangGraph 在每个节点执行前后**自动完成**。

## 六、 小结

| 概念 | 本质 |
|------|------|
| `invoke(state对象)` | 创建新任务，从 START 开始执行 |
| `invoke(Command)` | 恢复旧任务，从断点继续执行 |
| `interrupt(payload)` | 第一次：抛异常中断节点；第二次：直接返回 resume 值 |
| `__interrupt__` | invoke 返回值中的特殊字段，携带 interrupt 的 payload |
| `Command({ resume })` | resume 的值会成为 interrupt() 的返回值 |
| `thread_id` | 两次 invoke 的关联钥匙，Redis 通过它找存档 |
| `checkpointer` | 存档系统，LangGraph 自动调用，你不需要手动读写 |

**一句话总结**：第一次 invoke 正常执行到 interrupt 时暂停并存档，第二次 invoke 用 Command 告诉 LangGraph "恢复"，LangGraph 从 Redis 读档后继续执行，interrupt 不再抛异常而是直接返回 resume 的值。
