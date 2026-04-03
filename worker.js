// Cloudflare Worker — 腾讯股票接口代理 + AI 持仓分析
// 部署方式：在 Cloudflare Dashboard 创建 Worker，粘贴此代码
// AI 功能需要在 Worker Settings > Variables 中添加 AI Binding，变量名设为 AI

const AI_MODEL = '@cf/moonshotai/kimi-k2.5';

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
        {
          role: 'system',
          content: '你是一位专业的投资组合分析师，擅长分析A股和ETF投资组合。请用简洁专业的中文回答，使用 Markdown 格式。不要使用表情符号。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: true,
      max_tokens: 2048,
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

  let prompt = '请分析以下 A股/ETF 投资组合，并给出专业的持仓分析报告。\n\n';

  // 组合概况
  prompt += '## 组合概况\n';
  prompt += `- 总市值：${fmtCNY(totalValue)}\n`;
  prompt += `- 今日盈亏：${fmtCNY(todayPnl)}\n`;
  prompt += `- 持仓盈亏：${fmtCNY(totalPnl)}（${totalPnlPct != null ? totalPnlPct.toFixed(2) + '%' : '无数据'}）\n`;
  prompt += `- 持仓品种：${count} 个\n`;
  prompt += `- 最大偏离度：${maxDeviation.toFixed(2)}%\n\n`;

  // 分类配置
  if (categories && categories.length > 0) {
    prompt += '## 分类配置\n';
    prompt += '| 类别 | 市值 | 目标占比 | 实际占比 | 偏离 |\n';
    prompt += '|------|------|---------|---------|------|\n';
    for (const cat of categories) {
      const dev = cat.deviation > 0 ? `+${cat.deviation.toFixed(2)}%` : `${cat.deviation.toFixed(2)}%`;
      prompt += `| ${cat.name} | ${fmtCNY(cat.marketValue)} | ${cat.targetPct.toFixed(1)}% | ${cat.actualPct.toFixed(1)}% | ${dev} |\n`;
    }
    prompt += '\n';
  }

  // 持仓明细
  if (items && items.length > 0) {
    prompt += '## 持仓明细\n';
    prompt += '| 标的 | 类别 | 市值 | 盈亏% | 目标% | 实际% | 偏离% | 建议 |\n';
    prompt += '|------|------|------|-------|-------|-------|-------|------|\n';
    for (const item of items) {
      if (item.quoteError) continue;
      const pnlStr = item.pnlPct != null ? `${item.pnlPct.toFixed(2)}%` : '-';
      const devStr = item.deviation > 0 ? `+${item.deviation.toFixed(2)}%` : `${item.deviation.toFixed(2)}%`;
      prompt += `| ${item.name} | ${item.category} | ${fmtCNY(item.marketValue)} | ${pnlStr} | ${item.targetPct.toFixed(1)}% | ${item.actualPct.toFixed(1)}% | ${devStr} | ${item.actionText} |\n`;
    }
    prompt += '\n';
  }

  prompt += '## 请从以下维度分析\n';
  prompt += '1. **整体评价**：组合健康度、资产配置是否合理、分散化程度\n';
  prompt += '2. **风险分析**：集中度风险、市场风险、汇率风险（港美股部分）、利率风险（债券部分）\n';
  prompt += '3. **配置建议**：哪些资产类别配置偏高或偏低，应如何调整\n';
  prompt += '4. **重点关注**：偏离度较大或浮亏较多的品种，分析原因和应对策略\n';
  prompt += '5. **操作建议**：给出具体、可执行的调仓建议\n';

  return prompt;
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
