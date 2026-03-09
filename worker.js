// Cloudflare Worker — 腾讯股票接口代理
// 部署方式：在 Cloudflare Dashboard 创建 Worker，粘贴此代码

export default {
  async fetch(request) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

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
  },
};

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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
