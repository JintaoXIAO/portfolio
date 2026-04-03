// Cloudflare Worker — 腾讯股票接口代理 + AI 持仓分析
// 部署方式：在 Cloudflare Dashboard 创建 Worker，粘贴此代码
// AI 功能需要在 Worker Settings > Variables 中添加 AI Binding，变量名设为 AI

const AI_MODEL = '@cf/moonshotai/kimi-k2.5';

const SYSTEM_PROMPT = `你是一位拥有 10 年以上经验的 A 股 ETF 投资组合分析师。你的客户是普通个人投资者，采用被动指数化投资策略，通过 ETF 构建多资产组合并定期再平衡。

## 你的分析风格
- 专业但易懂：用数据说话，避免空洞的套话，确保非金融专业人士也能理解
- 直接给结论：先说判断，再给依据，不要铺垫
- 重点突出：对需要立即关注的问题用"**加粗**"标注
- 务实可执行：建议要具体到"买/卖什么、大约多少"，而非"建议适当调整"这类模糊表述

## 输出格式要求
使用 Markdown 格式，按以下结构组织报告：

### 1. 组合体检（用 1-2 句话给出总体判断）
给出组合的健康评级（优秀/良好/一般/需关注），并说明理由。

### 2. 配置分析
分析大类资产配置是否合理，重点指出偏离目标较大的类别。与常见的资产配置框架对比（如股债比例、国内外分散等）。

### 3. 风险提示
识别当前组合的主要风险点（集中度、单一市场敞口、汇率、利率等），按重要性排序，每个风险点简要说明影响和程度。

### 4. 持仓点评
只点评需要关注的个别品种（偏离大、浮亏多、或有特殊情况的），不需要逐一点评每个持仓。正常的品种一笔带过即可。

### 5. 操作建议
给出 2-4 条具体可执行的建议，按优先级排序。每条建议说清楚：做什么、为什么、大致幅度。

## 约束
- 不要使用表情符号
- 不要生成表格（前端已有详细表格，避免重复）
- 不要重复罗列原始数据，直接引用关键数字即可
- 控制篇幅，整体 800-1200 字为宜
- 在报告末尾加一句简短的风险免责声明`;

export default {
  async fetch(request, env) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // 路由分发
    if (url.pathname === '/ai/analyze' && request.method === 'POST') {
      return handleAIAnalyze(request, env);
    }

    // 默认路由：股票行情代理（兼容旧接口）
    return handleQuotes(request);
  },
};

// ========== 股票行情代理 ==========

async function handleQuotes(request) {
  const url = new URL(request.url);
  const symbols = url.searchParams.get('symbols');

  if (!symbols) {
    return jsonResponse({ error: '缺少 symbols 参数，格式：?symbols=sh600519,sz000001' }, 400);
  }

  try {
    const resp = await fetch(`https://qt.gtimg.cn/q=${symbols}`, {
      headers: { 'Referer': 'https://finance.qq.com' },
    });

    const buffer = await resp.arrayBuffer();
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(buffer);
    const stocks = parseQuotes(text);

    return jsonResponse(stocks);
  } catch (err) {
    return jsonResponse({ error: '获取股票数据失败: ' + err.message }, 500);
  }
}

/**
 * 解析腾讯接口返回的原始文本
 * 格式示例：v_sh600519="1~贵州茅台~600519~1800.00~..."
 * 波浪线分隔，index 1=名称, 3=当前价, 31=涨跌额, 32=涨跌幅
 */
function parseQuotes(raw) {
  const result = {};
  const lines = raw.split(';').filter((l) => l.trim());

  for (const line of lines) {
    const match = line.match(/v_(\w+)="(.*)"/);
    if (!match) continue;

    const symbol = match[1];
    const fields = match[2].split('~');

    if (fields.length < 33) continue;

    result[symbol] = {
      name: fields[1],
      price: parseFloat(fields[3]),
      change: parseFloat(fields[31]),
      changePercent: parseFloat(fields[32]),
    };
  }

  return result;
}

// ========== AI 持仓分析 ==========

async function handleAIAnalyze(request, env) {
  // 检查 AI binding 是否可用
  if (!env || !env.AI) {
    return jsonResponse(
      { error: 'AI 功能未配置。请在 Cloudflare Dashboard Worker Settings 中添加 AI Binding（变量名: AI）。' },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体格式错误，需要 JSON' }, 400);
  }

  const { portfolio } = body;
  if (!portfolio) {
    return jsonResponse({ error: '缺少 portfolio 数据' }, 400);
  }

  try {
    const prompt = buildAnalysisPrompt(portfolio);
    const stream = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      stream: true,
      max_tokens: 4096,
    });

    // 返回 SSE 流
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...corsHeaders(),
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'AI 分析失败: ' + err.message }, 500);
  }
}

/**
 * 构建分析 prompt，将持仓数据结构化为文本
 */
function buildAnalysisPrompt(portfolio) {
  const {
    totalValue, todayPnl, totalPnl, totalPnlPct,
    count, maxDeviation, categories, items,
  } = portfolio;

  const lines = [];

  lines.push('请根据以下数据分析我的 ETF 投资组合。');
  lines.push('');

  // 组合概况 — 紧凑格式，节省 token
  lines.push('## 组合概况');
  lines.push(`总市值 ${fmtCNY(totalValue)}，${count} 个品种，最大偏离 ${maxDeviation.toFixed(2)}%`);
  const pnlPctStr = totalPnlPct != null ? `(${totalPnlPct >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%)` : '';
  lines.push(`持仓盈亏 ${fmtCNY(totalPnl)} ${pnlPctStr}，今日盈亏 ${fmtCNY(todayPnl)}`);
  lines.push('');

  // 分类配置 — 只输出关键字段
  if (categories && categories.length > 0) {
    lines.push('## 分类配置');
    for (const cat of categories) {
      const devSign = cat.deviation >= 0 ? '+' : '';
      lines.push(`- ${cat.name}：${fmtCNY(cat.marketValue)}，目标 ${cat.targetPct.toFixed(1)}% → 实际 ${cat.actualPct.toFixed(1)}%（偏离 ${devSign}${cat.deviation.toFixed(2)}%）`);
    }
    lines.push('');
  }

  // 持仓明细 — 只列关键信息
  if (items && items.length > 0) {
    lines.push('## 持仓明细');
    for (const item of items) {
      if (item.quoteError) continue;
      const parts = [`${item.name}（${item.category}）`];
      parts.push(`市值 ${fmtCNY(item.marketValue)}`);
      if (item.pnlPct != null) {
        parts.push(`盈亏 ${item.pnlPct >= 0 ? '+' : ''}${item.pnlPct.toFixed(2)}%`);
      }
      const devSign = item.deviation >= 0 ? '+' : '';
      parts.push(`目标 ${item.targetPct.toFixed(1)}% → 实际 ${item.actualPct.toFixed(1)}%（偏离 ${devSign}${item.deviation.toFixed(2)}%）`);
      if (item.actionText && item.actionText !== '持有') {
        parts.push(`系统建议: ${item.actionText}`);
      }
      lines.push(`- ${parts.join('，')}`);
    }
    lines.push('');
  }

  lines.push('请按系统提示中的输出格式生成分析报告。');

  return lines.join('\n');
}

/**
 * 简单格式化人民币金额（在 Worker 端，不依赖 Intl）
 */
function fmtCNY(value) {
  if (value == null || isNaN(value)) return '¥0.00';
  const abs = Math.abs(value);
  let str;
  if (abs >= 1e8) {
    str = (value / 1e8).toFixed(2) + '亿';
  } else if (abs >= 1e4) {
    str = (value / 1e4).toFixed(2) + '万';
  } else {
    str = value.toFixed(2);
  }
  return '¥' + str;
}

// ========== 通用工具 ==========

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
    },
  });
}
