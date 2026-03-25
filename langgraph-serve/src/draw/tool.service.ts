/**
 * ============================================================
 * 工具服务 (Tool Service) —— 全部调用真实开放 API
 * ============================================================
 *
 * 三个工具都是真实网络请求，无硬编码数据：
 *   1. generate_color_scheme — 调用 thecolorapi.com 生成配色方案
 *   2. get_ai_palette        — 调用 colormind.io AI 生成调色板
 *   3. resolve_color_name    — 调用 thecolorapi.com 解析颜色名称
 *
 * 以上 API 均免费、无需 API Key。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// ============================================================
// 工具 1: 配色方案生成（The Color API）
// ============================================================
/**
 * 调用 thecolorapi.com/scheme 接口
 *
 * 这是一个真实的 REST API：
 *   GET https://www.thecolorapi.com/scheme?hex=FF6B6B&mode=complement&count=5
 *
 * 返回基于色彩理论的专业配色方案，支持：
 *   - complement（互补色）
 *   - analogic（类似色）
 *   - triad（三角色）
 *   - split-complement（分裂互补色）
 *   - monochrome（同色系）
 *   - quad（四角色）
 */
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

      // 提取配色方案
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
      console.error(`❌ [API 失败] ${error.message}`);
      return `配色方案生成失败：${error.message}`;
    }
  },
  {
    name: 'generate_color_scheme',
    description: '调用 The Color API 生成专业配色方案。给定一个基础颜色和配色模式，返回一组和谐的颜色。当需要为多个图形确定协调的颜色时使用。',
    schema: z.object({
      hex: z.string().describe('基础颜色的十六进制值，如 #FF6B6B 或 FF6B6B'),
      mode: z.enum(['complement', 'analogic', 'triad', 'split-complement', 'monochrome', 'quad'])
        .describe('配色模式：complement(互补), analogic(类似), triad(三角), split-complement(分裂互补), monochrome(同色系), quad(四角)'),
      count: z.number().min(2).max(10).default(5).describe('生成几个颜色，默认 5'),
    }),
  },
);

// ============================================================
// 工具 2: AI 调色板生成（Colormind API）
// ============================================================
/**
 * 调用 colormind.io/api/ 接口
 *
 * Colormind 使用深度学习模型生成调色板，训练数据来自真实的设计作品、
 * 电影海报、艺术品等。它不是简单的色彩数学，而是 AI 审美。
 *
 *   POST http://colormind.io/api/
 *   Body: {"model":"default","input":["N","N","N","N","N"]}
 *
 * 可以锁定某些颜色（传入 [R,G,B]），让 AI 生成与之搭配的其余颜色。
 */
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

      const result = `Colormind AI 生成的 5 色调色板${lockedInfo}：
${palette.map((c: any, i: number) => `  ${i + 1}. ${c.hex} (${c.rgb})`).join('\n')}

建议用法：第 1 色作为背景/最浅色，第 3 色作为主色，第 5 色作为强调/最深色。`;

      console.log(`📥 [API 返回] ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ [API 失败] ${error.message}`);
      return `AI 调色板生成失败：${error.message}`;
    }
  },
  {
    name: 'get_ai_palette',
    description: '调用 Colormind AI 生成 5 色调色板。Colormind 基于深度学习，从真实设计作品中学习配色审美。可以锁定 1-4 个颜色让 AI 生成与之搭配的其余颜色，也可以完全让 AI 自由生成。',
    schema: z.object({
      lockedColors: z.array(z.string()).max(4).optional()
        .describe('要锁定的颜色（十六进制），如 ["#FF6B6B", "#4ECDC4"]。AI 会生成与这些颜色搭配的其余颜色。不传则完全由 AI 自由生成。'),
    }),
  },
);

// ============================================================
// 工具 3: 颜色名称解析（The Color API）
// ============================================================
/**
 * 调用 thecolorapi.com/id 接口
 *
 * 将模糊的颜色描述解析为精确的十六进制值：
 *   - 英文名：coral → #FF7F50
 *   - 中文名（大模型翻译后）：珊瑚色 → coral → #FF7F50
 *   - CSS 命名色：tomato, skyblue, gold 等
 *   - 任意 hex/rgb 值的详细信息查询
 *
 *   GET https://www.thecolorapi.com/id?hex=FF7F50
 */
export const resolveColorTool = tool(
  async ({ hex }) => {
    const cleanHex = hex.replace('#', '');
    const url = `https://www.thecolorapi.com/id?hex=${cleanHex}`;

    console.log(`🌐 [API 请求] 解析颜色 #${cleanHex}: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`API 返回 ${response.status}`);
      }

      const data = await response.json();

      const result = `颜色 #${cleanHex} 的详细信息：
  名称: ${data.name.value}${data.name.exact_match_hex ? '（精确匹配）' : `（最接近: ${data.name.closest_named_hex}）`}
  HEX: ${data.hex.value}
  RGB: ${data.rgb.value}
  HSL: ${data.hsl.value}
  对比色: ${data.contrast.value}
  适合搭配的文字颜色: ${data.contrast.value}`;

      console.log(`📥 [API 返回] ${result}`);
      return result;
    } catch (error) {
      console.error(`❌ [API 失败] ${error.message}`);
      return `颜色解析失败：${error.message}`;
    }
  },
  {
    name: 'resolve_color',
    description: '调用 The Color API 查询一个颜色的详细信息，包括标准名称、RGB/HSL 值、对比色等。当用户给了一个颜色值，需要确认其名称或获取更多信息时使用。也可用于查询某个 hex 颜色的对比色和搭配建议。',
    schema: z.object({
      hex: z.string().describe('颜色的十六进制值，如 FF7F50 或 #FF7F50'),
    }),
  },
);
