上一篇中，我们用 `MemorySaver` 给 AI Agent 装上了"海马体"，实现了多轮对话。但有一个致命的问题：

**服务一重启，AI 就彻底失忆了。**

因为 `MemorySaver` 是把状态存在 Node.js 进程的内存中的。进程一关，内存一清，所有对话历史和画布状态全部灰飞烟灭。用户昨天花了 20 轮对话精心调整出来的图形看板？抱歉，今天服务器一更新，全没了。

这在开发阶段问题不大，但要上生产就完全不能接受了。今天，我们要把"海马体"从短暂的内存升级成**永久的硬盘**——用 **Redis** 作为持久化存储，让 AI 的记忆跨越服务重启、甚至跨越机器。

## 一、 为什么选 Redis？

在持久化存储方案中，LangGraph 官方提供了多种 Checkpointer 实现。我们选 Redis 的理由很简单：

| 特性 | MemorySaver | Redis |
|------|-------------|-------|
| 数据持久化 | ❌ 进程重启即丢失 | ✅ 数据持久化到磁盘 |
| 多实例共享 | ❌ 仅当前进程 | ✅ 多个服务实例共享同一份记忆 |
| 读写速度 | 🚀 内存级 | 🚀 亚毫秒级（同样是内存操作） |
| TTL 过期清理 | ❌ 手动管理 | ✅ 自动过期 |
| 生产就绪 | ❌ | ✅ |

简单来说：**Redis 既有内存的速度，又有硬盘的持久**。数据存在 Redis 中，即使你的 NestJS 服务重启了，AI 照样能"读档"继续上一轮的对话。

## 二、 环境准备：启动 Redis

### 方式一：Docker 一键启动（推荐）

`@langchain/langgraph-checkpoint-redis` 要求 Redis 支持 **RedisJSON** 和 **RediSearch** 模块。最简单的方式是使用 **Redis Stack**：

```bash
docker run -d --name redis-stack \
  -p 6379:6379 \
  -p 8001:8001 \
  redis/redis-stack:latest
```

这一条命令会启动一个包含所有必要模块的 Redis 实例。端口 `6379` 是 Redis 服务端口，`8001` 是 Redis Insight 管理界面（可选，方便可视化查看数据）。

> **Redis 8.0+** 已经内置了这些模块，如果你已有 Redis 8.0+ 实例，可以直接使用。

### 方式二：Homebrew 安装（macOS）

如果你的 Mac 上已经装了 Homebrew：

```bash
# 1. 添加 Redis Stack 源并安装
brew tap redis-stack/redis-stack
brew install redis-stack
```

安装完成后，启动 Redis Stack 服务：

```bash
# 2. 后台启动 Redis Stack（--daemonize yes 表示在后台运行）
redis-stack-server --daemonize yes
```

验证 Redis 是否启动成功：

```bash
# 3. 验证连接，返回 PONG 表示成功
redis-cli ping
# 期望输出：PONG
```

不用的时候，可以关闭 Redis 服务：

```bash
# 关闭 Redis
redis-cli shutdown
```

## 三、 安装依赖

在你的 NestJS 项目中，安装 LangGraph 官方提供的 Redis Checkpointer 包：

```bash
npm install @langchain/langgraph-checkpoint-redis
```

## 四、 代码改造：一行代码的质变

这是今天最让人爽的部分——**改动量极小**。因为 LangGraph 做到了存储层和业务逻辑的完美解耦，换存储方案几乎只需要替换 Checkpointer 的实例化方式。

打开 `draw.service.ts`，我们只需要改**两个地方**：

### 改动一：替换 import 和实例化

```diff
- import { MemorySaver } from '@langchain/langgraph';
+ import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';

  @Injectable()
  export class DrawService {
    private agentApp: any;
    private tools = [brandThemeTool, weatherTool, githubTool];
    private aliyun: any;
    private readonly logger = new Logger(DrawService.name);
-   private checkpointer = new MemorySaver();
+   private checkpointer: RedisSaver;
```

### 改动二：异步初始化 RedisSaver

因为 `RedisSaver` 需要连接 Redis 并创建索引，它的初始化是**异步的**（`MemorySaver` 则是同步的）。所以我们需要把初始化逻辑改成异步：

```typescript
@Injectable()
export class DrawService {
  private agentApp: any;
  private tools = [brandThemeTool, weatherTool, githubTool];
  private aliyun: any;
  private readonly logger = new Logger(DrawService.name);
  private checkpointer: RedisSaver;

  constructor(private configService: ConfigService) {
    this.initAliyun();
    // 注意：不能在 constructor 里直接 await，改用 init() 方法
    this.init();
  }

  // 🔑 新增：异步初始化方法
  private async init() {
    // 从 Redis URL 创建 Checkpointer（内部会自动连接 Redis 并创建必要的索引）
    const redisUrl = this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.checkpointer = await RedisSaver.fromUrl(redisUrl, {
      // TTL 配置：会话数据 24 小时后自动过期清理
      defaultTTL: 1440, // 单位是分钟，1440 分钟 = 24 小时
      refreshOnRead: true, // 每次读取时自动续期，活跃会话永不过期
    });
    this.logger.log('✅ Redis Checkpointer 初始化成功');

    // Graph 的编译依赖 checkpointer，所以放到这里
    this.initGraph();
  }
  
  // ...其他代码不变
}
```

### 完整的改造后代码

改动真的很少，我把关键差异标注出来了：

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
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis'; // 👈 换成 Redis！

// 状态定义、Schema 等完全不变...
const GraphState = Annotation.Root({
  userInput: Annotation<string>({ reducer: (cur, next) => next, default: () => '' }),
  messages: Annotation<any[]>({ reducer: (cur, next) => cur.concat(next), default: () => [] }),
  shapes: Annotation<any[]>({ reducer: (cur, next) => next, default: () => [] }),
  errorLog: Annotation<string | null>({ reducer: (cur, next) => next, default: () => null }),
  retryCount: Annotation<number>({ reducer: (cur, next) => next, default: () => 0 }),
});

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
  // 👇 类型从 MemorySaver 换成 RedisSaver
  private checkpointer: RedisSaver;

  constructor(private configService: ConfigService) {
    this.initAliyun();
    // 👇 异步初始化（constructor 不能 await，所以单独抽方法）
    this.init();
  }

  // 👇 新增：异步初始化
  private async init() {
    const redisUrl = this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.checkpointer = await RedisSaver.fromUrl(redisUrl, {
      defaultTTL: 1440,     // 24 小时后过期
      refreshOnRead: true,  // 读取时续期
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
    // ... 这里面的所有代码完全不变！
    // agent 节点、tool 节点、extractor 节点、工作流编排 —— 一个字都不用改

    // 唯一的关键一行，也不需要改：
    this.agentApp = workflow.compile({ checkpointer: this.checkpointer });
  }

  // draw() 方法也完全不变！
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

### 配置 Redis 连接地址

在项目根目录的 `.env` 文件中，添加 Redis 连接地址：

```env
REDIS_URL=redis://localhost:6379
```

## 五、 对比：到底改了什么？

让我们用一张对照表来看看代码的变化：

| 改动点 | MemorySaver（原来） | RedisSaver（现在） |
|--------|---------------------|---------------------|
| import | `import { MemorySaver } from '@langchain/langgraph'` | `import { RedisSaver } from '@langchain/langgraph-checkpoint-redis'` |
| 声明 | `private checkpointer = new MemorySaver()` | `private checkpointer: RedisSaver` |
| 初始化 | 同步，直接 `new` | 异步，`await RedisSaver.fromUrl(redisUrl)` |
| Graph 编译 | `workflow.compile({ checkpointer })` | **完全一样** ✅ |
| 调用方式 | `invoke({ ... }, { configurable: { thread_id } })` | **完全一样** ✅ |
| 节点代码 | agent / tools / extractor | **完全一样** ✅ |

**总结：只改了 3 行代码（import + 声明 + 初始化），业务逻辑一行没动。** 这就是 LangGraph 抽象层设计的威力。

## 六、 见证奇迹的时刻：重启不丢记忆！

确保 Redis 已运行，然后重启 NestJS 服务：

```bash
npm run start:dev
```

控制台应该会打印：`✅ Redis Checkpointer 初始化成功`

### 测试流程

**第一轮**：发送 `{ "text": "画一个红色的矩形" }`

```json
{
  "success": true,
  "shapes": [{ "type": "rect", "width": 200, "height": 100, "fill": "#FF6B6B" }]
}
```

**现在，重启 NestJS 服务！**（`Ctrl+C` 然后 `npm run start:dev`）

**第二轮**（重启后）：发送 `{ "text": "把它的颜色改成蓝色" }`

```json
{
  "success": true,
  "shapes": [{ "type": "rect", "width": 200, "height": 100, "fill": "#1E90FF" }]
}
```

✅ **服务重启了，但 AI 依然记得画布上是一个矩形！** 这个"它"被正确理解了，因为上一轮的 `state`（包括 `shapes` 和 `messages`）已经持久化在 Redis 中。

如果你启动了 Redis Insight（`http://localhost:8001`），还可以在管理界面中直接看到存储的 checkpoint 数据。

## 七、 进阶：RedisSaver 的 TTL 自动清理

注意我们初始化时传入的 TTL 配置：

```typescript
this.checkpointer = await RedisSaver.fromUrl(redisUrl, {
  defaultTTL: 1440,     // 24 小时后过期
  refreshOnRead: true,  // 每次读取时自动续期
});
```

这两个参数非常优雅地解决了"数据堆积"问题：

- **`defaultTTL: 1440`**：每条会话数据默认 24 小时后自动删除。不活跃的会话不会永远占用 Redis 内存。
- **`refreshOnRead: true`**：如果某个会话在 24 小时内被再次使用（读取），TTL 会重新计时。这意味着**只要用户还在活跃使用，记忆就永远不会过期**。

这就像图书馆的借阅制度：书借出去后 30 天内没人续借就自动回收，但只要有人在看（续借），就可以一直保留。

## 八、 番外：ShallowRedisSaver——更轻量的选择

如果你的场景不需要保留完整的对话历史（比如只关心"最新状态"），LangGraph 还提供了 `ShallowRedisSaver`：

```typescript
import { ShallowRedisSaver } from '@langchain/langgraph-checkpoint-redis/shallow';

const shallowSaver = await ShallowRedisSaver.fromUrl('redis://localhost:6379');
```

| 特性 | RedisSaver | ShallowRedisSaver |
|------|-----------|-------------------|
| 存储量 | 保留全部 checkpoint 历史 | **只保留最新一个** |
| 回溯能力 | ✅ 可以回到任意历史状态 | ❌ 只有最新状态 |
| 内存占用 | 较大（随对话轮数增长） | **极小（恒定）** |
| 适用场景 | 需要时间旅行/回溯的复杂 Agent | 只需"最近记忆"的简单场景 |

对于我们的画布 Agent 来说，`RedisSaver` 是更好的选择——万一用户说"还是把颜色改回上上次的"，有完整历史才能支持。

## 九、 小结

| 概念 | 作用 |
|------|------|
| `@langchain/langgraph-checkpoint-redis` | LangGraph 官方 Redis 持久化包 |
| `RedisSaver.fromUrl()` | 异步创建 Redis Checkpointer 实例 |
| `defaultTTL` | 会话数据的默认过期时间（分钟） |
| `refreshOnRead` | 读取时自动续期，活跃会话不过期 |
| `ShallowRedisSaver` | 轻量版，只保留最新 checkpoint |

**核心要点**：

1. **改动极小**：只需替换 import、声明和初始化方式，业务代码零改动
2. **LangGraph 的抽象设计很优雅**：`Checkpointer` 接口统一，切换存储方案就像换电池
3. **TTL 机制很重要**：生产环境一定要配置 TTL，避免 Redis 内存无限增长
4. **Redis 需要 RedisJSON + RediSearch 模块**：建议直接使用 Redis Stack 或 Redis 8.0+
