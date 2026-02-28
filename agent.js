import { START, END, Annotation, StateGraph } from "@langchain/langgraph";
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import 'dotenv/config'; 

// 1. 准备工作：写一个休眠函数，防止请求太快被服务器拉黑
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 初始化模型客户端（必须开启 compatible 兼容模式）
const aliyun = createOpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY, 
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  compatibility: 'compatible', 
});

// 2. 定义状态：加一个 retryCount 用来记数，防止代码陷入无限死循环
const GraphState = Annotation.Root({
  shapes: Annotation({ reducer: (cur, next) => cur.concat(next), default: () => [] }),
  errorLog: Annotation({ reducer: (cur, next) => next, default: () => null }),
  retryCount: Annotation({ reducer: (cur, next) => next, default: () => 0 }), 
});

// 3. 核心生成节点
const generateNode = async (state) => {
  console.log(`\n⚙️ [生成器] 第 ${state.retryCount + 1} 次请求大模型...`);

  let prompt = "请为前端渲染引擎生成一个矩形的 JSON 配置。要求：颜色红色，宽度 100。";

  // 如果状态里有错误信息，说明上一次生成的不对，给模型加上纠错提示
  if (state.errorLog) {
    prompt += `\n\n⚠️注意：上一次生成失败了，原因：${state.errorLog}。\n请严格按照要求重新生成！`;
    console.log(`⏳ 触发限流保护，暂停 2 秒...`);
    await sleep(2000); 
  }

  // 调用 AI，并强制要求返回符合 Zod 格式的 JSON
  const { object } = await generateObject({
    model: aliyun.chat('qwen-plus', { structuredOutputs: false }), // 用 .chat 避开 404 问题
    mode: 'json',
    maxRetries: 0, // 告诉 SDK 报错了直接抛出来，不要在后台偷偷重试
    prompt: prompt,
    schema: z.object({
      shapes: z.array(
        z.object({
          type: z.string().describe("图形类型"),
          width: z.number().describe("宽度"),
          // 直接在 Zod 里写死限制，大模型就不敢乱猜了
          height: z.number().min(50).max(70).describe("高度必须在 50 到 70 之间"), 
          fill: z.string().describe("颜色")
        })
      )
    }),
  });

  return { shapes: object.shapes, errorLog: null };
};

// 4. 数据检查节点
const validateNode = async (state) => {
  console.log("🔍 [校验器] 检查拿到的数据...");
  const latestShape = state.shapes[state.shapes.length - 1];

  // 检查高度是不是数字，且是不是在 50-90 之间
  if (!latestShape || typeof latestShape.height !== 'number' || latestShape.height < 50 || latestShape.height > 70) {
    console.log("❌ [校验器] 数据不合格，打回重做！")
    return { 
      errorLog: `高度不符合要求，你生成的是 ${latestShape?.height}，必须在 50-90 之间。`,
      retryCount: state.retryCount + 1 
    };
  }

  console.log("✅ [校验器] 数据完美通过！");
  return {};
};

// 5. 把节点连起来，组成工作流
const workflow = new StateGraph(GraphState);
workflow.addNode("generator", generateNode);
workflow.addNode("validator", validateNode);

workflow.addEdge(START, "generator");
workflow.addEdge("generator", "validator");

// 判断是打回重做，还是结束流程
workflow.addConditionalEdges("validator", (state) => {
  if (state.errorLog) {
    // 如果重试超过 3 次，就强行结束，防止把 API 额度跑光
    if (state.retryCount >= 3) {
       console.log("🚨 连续失败 3 次，强制停止。");
       return END;
    }
    return "generator";
  }
  return END;
});

const app = workflow.compile();

// 6. 运行代码
async function run() {
  console.log("🚀 开始运行 Agent...");
  const finalState = await app.invoke({ shapes: [], errorLog: null, retryCount: 0 });
  console.log("\n🎉 最终拿到的可用数据:", JSON.stringify(finalState.shapes, null, 2));
}

run();