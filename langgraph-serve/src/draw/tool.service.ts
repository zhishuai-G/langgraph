// tool.service.ts (建议新建或写在当前 Service 外部)
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// 定义一个搜索品牌色的工具
export const brandThemeTool = tool(
  async ({ brandName }) => {
    // 品牌色数据库（支持中英文别名）
    const db: Record<string, { color: string; desc: string }> = {
      // Google
      'google': { color: '#4285F4', desc: '谷歌蓝' },
      '谷歌': { color: '#4285F4', desc: '谷歌蓝' },
      // Alipay
      'alipay': { color: '#1677FF', desc: '支付宝蓝' },
      '支付宝': { color: '#1677FF', desc: '支付宝蓝' },
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