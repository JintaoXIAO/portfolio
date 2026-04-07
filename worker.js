// Cloudflare Worker — 腾讯股票接口代理 + AI 持仓分析
// 部署方式：在 Cloudflare Dashboard 创建 Worker，粘贴此代码
// AI 功能需要在 Worker Settings > Variables 中添加 AI Binding，变量名设为 AI

const AI_MODEL = '@cf/moonshotai/kimi-k2.5';

// 新浪财经滚动新闻 API — 获取近期财经新闻
const NEWS_API = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=30&page=1';

const SYSTEM_PROMPT = `你是一位拥有 10 年以上经验的 A 股 ETF 投资组合分析师。你的客户是普通个人投资者，采用被动指数化投资策略，通过 ETF 构建多资产组合并定期再平衡。

## 你的分析风格
- 专业但易懂：用数据说话，避免空洞的套话，确保非金融专业人士也能理解
- 直接给结论：先说判断，再给依据，不要铺垫
- 重点突出：对需要立即关注的问题用"**加粗**"标注
- 务实可执行：建议要具体到"买/卖什么、大约多少"，而非"建议适当调整"这类模糊表述
- 新闻驱动：你会收到近期财经新闻摘要，必须从中筛选与客户组合有实际影响的信息，并明确说明影响路径（例如：美联储降息 → 人民币升值压力缓解 → 利好 QDII 类 ETF）
- 数据敏感：你会收到 VIX 恐慌指数、上证指数、美元/人民币汇率等市场指标，分析时应结合这些量化数据判断市场情绪和风险水平，而非仅依赖新闻文字

## 输出格式要求
使用 Markdown 格式，按以下结构组织报告：

### 1. 组合体检（用 1-2 句话给出总体判断）
给出组合的健康评级（优秀/良好/一般/需关注），并说明理由。

### 2. 市场环境与影响
先基于提供的市场指标（VIX、上证指数、汇率）概括当前市场情绪和风险水平（1-2 句话），再从近期新闻中筛选 2-3 条与客户组合最相关的事件或趋势。每条需说明：
- 事件本身（一句话概括）
- 影响路径（如何传导到组合中的具体持仓）
- 影响方向与程度（利好/利空/中性，影响大/小）
如果新闻中没有对组合有显著影响的内容，简要说明当前市场环境整体平稳即可，不要强行关联。

### 3. 配置分析
分析大类资产配置是否合理，重点指出偏离目标较大的类别。结合当前市场环境判断偏离是否需要立即纠正（有时市场趋势支持暂时偏离）。

### 4. 风险提示
结合当前市场环境和持仓数据，识别 2-3 个最需要关注的风险点，按紧迫程度排序。每个风险点说明：触发条件、对组合的影响幅度、应对建议。

### 5. 操作建议
给出 2-4 条具体可执行的建议，按优先级排序。每条建议说清楚：做什么、为什么、大致幅度。如有个别品种需要特别关注（偏离大、与当前市场环境冲突等），在相关建议中一并说明。

## 约束
- 不要使用表情符号
- 不要生成表格（前端已有详细表格，避免重复）
- 不要重复罗列原始数据，直接引用关键数字即可
- 控制篇幅，整体 800-1200 字为宜
- 如果新闻内容为空或不足，基于持仓数据本身进行分析，不要编造新闻
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
    // 并行获取新闻和市场指标，不阻塞彼此
    const [news, marketIndicators] = await Promise.all([
      fetchNews(),
      fetchMarketIndicators(),
    ]);
    const prompt = buildAnalysisPrompt(portfolio, news, marketIndicators);
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
