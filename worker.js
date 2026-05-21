// Cloudflare Worker — 腾讯股票接口代理 + AI 持仓分析 + 持仓/Prompt KV 存储
// 部署: bun run deploy
//
// 必需的 binding（已在 wrangler.toml 配置）:
//   - AI:           Workers AI（用于持仓分析）
//   - PORTFOLIO_KV: KV namespace（用于存储持仓与 prompt）
//
// 必需的 secret（用 wrangler secret put EDIT_PASSWORD 设置）:
//   - EDIT_PASSWORD: 写入持仓/prompt 时校验的密码

import { SYSTEM_PROMPT as DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { DEFAULT_PORTFOLIO } from './default-portfolio.js';

const AI_MODEL = '@cf/moonshotai/kimi-k2.6';

// 新浪财经滚动新闻 API — 获取近期财经新闻
const NEWS_API = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=30&page=1';

// KV 中的 key 名
const KV_KEY_PORTFOLIO = 'portfolio';
const KV_KEY_PROMPT    = 'system_prompt';

export default {
  async fetch(request, env) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // === 路由分发 ===

    // AI 分析
    if (path === '/ai/analyze' && method === 'POST') {
      return handleAIAnalyze(request, env);
    }

    // 持仓 CRUD
    if (path === '/api/portfolio') {
      if (method === 'GET') return handleGetPortfolio(env);
      if (method === 'PUT') return handlePutPortfolio(request, env);
    }

    // Prompt CRUD
    if (path === '/api/prompt') {
      if (method === 'GET') return handleGetPrompt(env);
      if (method === 'PUT') return handlePutPrompt(request, env);
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

// ========== 新闻获取 ==========

/**
 * 从新浪财经滚动新闻 API 获取近期财经新闻标题
 * 失败时返回空数组，不影响主流程
 */
async function fetchNews() {
  try {
    const resp = await fetch(NEWS_API);
    const json = await resp.json();
    const items = json.result?.data || [];

    return items
      .map((item) => (item.title || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch (err) {
    console.error('获取新闻失败:', err.message);
    return [];
  }
}

// ========== 市场指标获取 ==========

/**
 * 并行获取 VIX、上证指数、美元/人民币汇率
 * 任意一项失败不影响其他，返回尽可能多的数据
 */
async function fetchMarketIndicators() {
  const indicators = {};

  const [quotesResult, fxResult] = await Promise.allSettled([
    // VIX + 上证指数 — 复用腾讯接口
    (async () => {
      const resp = await fetch('https://qt.gtimg.cn/q=sh000001,usVIX', {
        headers: { 'Referer': 'https://finance.qq.com' },
      });
      const buffer = await resp.arrayBuffer();
      const decoder = new TextDecoder('gbk');
      return decoder.decode(buffer);
    })(),
    // 美元/人民币汇率 — 免费汇率 API
    (async () => {
      const resp = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      return resp.json();
    })(),
  ]);

  // 解析上证指数 + VIX
  if (quotesResult.status === 'fulfilled') {
    const text = quotesResult.value;
    const lines = text.split(';').filter((l) => l.trim());
    for (const line of lines) {
      const match = line.match(/v_(\w+)="(.*)"/);
      if (!match) continue;
      const symbol = match[1];
      const fields = match[2].split('~');
      if (fields.length < 33) continue;

      if (symbol === 'sh000001') {
        indicators.sse = {
          name: '上证指数',
          price: parseFloat(fields[3]),
          changePercent: parseFloat(fields[32]),
        };
      } else if (symbol === 'usVIX') {
        indicators.vix = {
          name: 'VIX 恐慌指数',
          price: parseFloat(fields[3]),
          changePercent: parseFloat(fields[32]),
        };
      }
    }
  }

  // 解析汇率
  if (fxResult.status === 'fulfilled') {
    const cny = fxResult.value?.rates?.CNY;
    if (cny) {
      indicators.usdcny = {
        name: '美元/人民币',
        price: cny,
      };
    }
  }

  return indicators;
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
    // 并行获取新闻、市场指标、KV 中的 system prompt
    const [news, marketIndicators, systemPrompt] = await Promise.all([
      fetchNews(),
      fetchMarketIndicators(),
      readSystemPrompt(env),
    ]);
    const prompt = buildAnalysisPrompt(portfolio, news, marketIndicators);
    const stream = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      stream: true,
      // 推理模型的思维链也消耗 max_tokens 配额，需要给足空间
      // 经验：思维链通常 2-4k，正文 1-2k，给 8k 留出充裕余地
      max_tokens: 8192,
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
function buildAnalysisPrompt(portfolio, news = [], market = {}) {
  const {
    totalValue, todayPnl, totalPnl, totalPnlPct,
    count, maxDeviation, categories, items,
  } = portfolio;

  const lines = [];

  lines.push('请根据以下持仓数据和近期新闻，分析我的 ETF 投资组合。');
  lines.push('');

  // 分析日期
  lines.push(`分析日期：${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // 市场指标
  const hasMarket = market.sse || market.vix || market.usdcny;
  if (hasMarket) {
    lines.push('## 市场指标');
    if (market.sse) {
      const sign = market.sse.changePercent >= 0 ? '+' : '';
      lines.push(`- 上证指数：${market.sse.price.toFixed(2)}（${sign}${market.sse.changePercent.toFixed(2)}%）`);
    }
    if (market.vix) {
      const level = market.vix.price > 30 ? '极度恐慌' : market.vix.price > 20 ? '恐慌' : market.vix.price > 15 ? '谨慎' : '贪婪';
      lines.push(`- VIX 恐慌指数：${market.vix.price.toFixed(2)}（${level}）`);
    }
    if (market.usdcny) {
      lines.push(`- 美元/人民币：${market.usdcny.price.toFixed(4)}`);
    }
    lines.push('');
  }

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

  // 近期财经新闻
  if (news.length > 0) {
    lines.push('## 近期财经新闻');
    for (const headline of news) {
      lines.push(`- ${headline}`);
    }
    lines.push('');
  } else {
    lines.push('## 近期财经新闻');
    lines.push('（未获取到近期新闻，请基于持仓数据本身进行分析）');
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

// ========== KV 存储：持仓与 Prompt ==========

/**
 * 从 KV 读取持仓数据，无值则返回默认值
 */
async function readPortfolio(env) {
  if (!env?.PORTFOLIO_KV) return DEFAULT_PORTFOLIO;
  try {
    const raw = await env.PORTFOLIO_KV.get(KV_KEY_PORTFOLIO);
    if (!raw) return DEFAULT_PORTFOLIO;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_PORTFOLIO;
    return parsed;
  } catch {
    return DEFAULT_PORTFOLIO;
  }
}

/**
 * 从 KV 读取 system prompt，无值则返回默认值
 */
async function readSystemPrompt(env) {
  if (!env?.PORTFOLIO_KV) return DEFAULT_SYSTEM_PROMPT;
  try {
    const raw = await env.PORTFOLIO_KV.get(KV_KEY_PROMPT);
    return raw && raw.trim() ? raw : DEFAULT_SYSTEM_PROMPT;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

/**
 * 校验请求中的密码（X-Edit-Password 头）
 * 未配置 EDIT_PASSWORD secret 时拒绝所有写入
 */
function checkAuth(request, env) {
  const expected = env?.EDIT_PASSWORD;
  if (!expected) {
    return { ok: false, status: 503, error: '服务端未配置 EDIT_PASSWORD，无法执行写操作' };
  }
  const got = request.headers.get('X-Edit-Password') || '';
  if (got !== expected) {
    return { ok: false, status: 401, error: '密码错误' };
  }
  return { ok: true };
}

/**
 * GET /api/portfolio — 返回持仓数据
 */
async function handleGetPortfolio(env) {
  const data = await readPortfolio(env);
  return jsonResponse({
    portfolio: data,
    isDefault: !(env?.PORTFOLIO_KV && (await env.PORTFOLIO_KV.get(KV_KEY_PORTFOLIO))),
  });
}

/**
 * PUT /api/portfolio — 写入持仓数据（需要密码）
 * Body: { portfolio: [...] }
 */
async function handlePutPortfolio(request, env) {
  const auth = checkAuth(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env?.PORTFOLIO_KV) {
    return jsonResponse({ error: '服务端未绑定 KV namespace' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体不是合法的 JSON' }, 400);
  }

  const { portfolio } = body;
  const validation = validatePortfolio(portfolio);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400);
  }

  await env.PORTFOLIO_KV.put(KV_KEY_PORTFOLIO, JSON.stringify(portfolio));
  return jsonResponse({ success: true, count: portfolio.length });
}

/**
 * GET /api/prompt — 返回当前 system prompt
 */
async function handleGetPrompt(env) {
  const text = await readSystemPrompt(env);
  const isDefault = !(env?.PORTFOLIO_KV && (await env.PORTFOLIO_KV.get(KV_KEY_PROMPT)));
  return jsonResponse({ prompt: text, isDefault });
}

/**
 * PUT /api/prompt — 写入 system prompt（需要密码）
 * Body: { prompt: "..." } 或 { reset: true } 重置为默认
 */
async function handlePutPrompt(request, env) {
  const auth = checkAuth(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  if (!env?.PORTFOLIO_KV) {
    return jsonResponse({ error: '服务端未绑定 KV namespace' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '请求体不是合法的 JSON' }, 400);
  }

  if (body.reset === true) {
    await env.PORTFOLIO_KV.delete(KV_KEY_PROMPT);
    return jsonResponse({ success: true, reset: true });
  }

  const { prompt } = body;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return jsonResponse({ error: 'prompt 必须是非空字符串' }, 400);
  }
  if (prompt.length > 50000) {
    return jsonResponse({ error: 'prompt 过长（最大 50000 字符）' }, 400);
  }

  await env.PORTFOLIO_KV.put(KV_KEY_PROMPT, prompt);
  return jsonResponse({ success: true, length: prompt.length });
}

/**
 * 校验持仓数据格式
 */
function validatePortfolio(portfolio) {
  if (!Array.isArray(portfolio)) {
    return { ok: false, error: 'portfolio 必须是数组' };
  }
  if (portfolio.length === 0) {
    return { ok: false, error: 'portfolio 不能为空' };
  }
  if (portfolio.length > 100) {
    return { ok: false, error: '持仓项不能超过 100 条' };
  }

  let totalTarget = 0;
  for (let i = 0; i < portfolio.length; i++) {
    const h = portfolio[i];
    if (!h || typeof h !== 'object') {
      return { ok: false, error: `第 ${i + 1} 项不是对象` };
    }
    if (typeof h.symbol !== 'string' || !h.symbol.trim()) {
      return { ok: false, error: `第 ${i + 1} 项缺少 symbol` };
    }
    if (typeof h.name !== 'string' || !h.name.trim()) {
      return { ok: false, error: `第 ${i + 1} 项缺少 name` };
    }
    if (typeof h.shares !== 'number' || h.shares < 0 || !isFinite(h.shares)) {
      return { ok: false, error: `第 ${i + 1} 项的 shares 不合法` };
    }
    if (typeof h.targetPct !== 'number' || h.targetPct < 0 || h.targetPct > 100) {
      return { ok: false, error: `第 ${i + 1} 项的 targetPct 不合法` };
    }
    if (h.costPrice != null && (typeof h.costPrice !== 'number' || h.costPrice < 0)) {
      return { ok: false, error: `第 ${i + 1} 项的 costPrice 不合法` };
    }
    totalTarget += h.targetPct;
  }

  // 允许 ±0.5% 误差
  if (Math.abs(totalTarget - 100) > 0.5) {
    return { ok: false, error: `目标占比合计为 ${totalTarget.toFixed(2)}%，应为 100%` };
  }

  return { ok: true };
}

// ========== 通用工具 ==========

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Password',
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
