// tool.service.ts (建议新建或写在当前 Service 外部)
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// 定义一个搜索品牌色的工具
export const brandThemeTool = tool(
  async ({ brandName }) => {
    // 品牌色数据库（支持中英文别名）
    const db: Record<string, { color: string; desc: string }> = {
      // Google
      google: { color: '#4285F4', desc: '谷歌蓝' },
      谷歌: { color: '#4285F4', desc: '谷歌蓝' },
      // Alipay
      alipay: { color: '#1677FF', desc: '支付宝蓝' },
      支付宝: { color: '#1677FF', desc: '支付宝蓝' },
      // 可继续添加其他品牌...
    };
    const result = db[brandName.toLowerCase()] || db[brandName];
    return result
      ? `找到品牌 ${brandName} 的颜色是 ${result.color}`
      : `未找到 ${brandName} 的品牌色，请让用户指定颜色`;
  },
  {
    name: 'get_brand_color',
    description: '当用户提到具体品牌名称时，调用此工具获取品牌官方配色',
    schema: z.object({
      brandName: z.string().describe('品牌名称'),
    }),
  },
);

// 这是一个真实请求外部网络的 API 工具！
export const githubTool = tool(
  async ({ username }) => {
    console.log(`🌐 [网络请求] 正在调用 GitHub API 查询用户: ${username}...`);
    try {
      // 真实调用 GitHub 开放接口
      const response = await fetch(`https://api.github.com/users/${username}`);

      if (!response.ok) {
        return `查询失败：未找到 GitHub 用户 ${username}`;
      }

      const data = await response.json();

      // 把请求到的真实 JSON 数据，转化成一段大模型能看懂的白话总结
      const resultStr = `查询成功！用户 ${username} 拥有 ${data.public_repos} 个公开仓库 (public_repos)，以及 ${data.followers} 个粉丝。`;

      console.log(`📥 [API 返回] ${resultStr}`);
      return resultStr;
    } catch (error) {
      return `网络请求发生错误: ${error.message}`;
    }
  },
  {
    name: 'get_github_info',
    // 💡 提示词精髓：告诉大模型，只要遇到 GitHub 相关的词，就触发网络请求
    description:
      '当用户提到 GitHub 用户名，或者想根据某个人的 GitHub 数据（如仓库数量、粉丝数）来画图时，调用此工具获取真实的网络数据。',
    schema: z.object({
      username: z.string().describe('GitHub 用户名（通常是英文）'),
    }),
  },
);
