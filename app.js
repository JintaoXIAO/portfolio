// ========== 配置 ==========
const WORKER_URL = 'https://stock-proxy.xiaojintao.workers.dev';
const DEVIATION_THRESHOLD = 5; // 操作建议阈值 (%)

// ========== 入口 ==========
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showLoading(true);
  try {
    const holdings = await fetchCSV('portfolio.csv');
    const symbols = holdings
      .filter((h) => h.symbol !== 'cash')
      .map((h) => h.symbol)
      .join(',');

    const quotes = symbols ? await fetchQuotes(symbols) : {};
    const portfolio = calculate(holdings, quotes);
    render(portfolio);
  } catch (err) {
    showError('加载失败: ' + err.message);
    console.error(err);
  } finally {
    showLoading(false);
  }
}

// ========== 数据获取 ==========

async function fetchCSV(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('无法加载 portfolio.csv');
  const text = await resp.text();
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');

  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return {
      symbol: values[0].trim(),
      name: values[1].trim(),
      shares: parseFloat(values[2]),
      targetPct: parseFloat(values[3]),
    };
  });
}

async function fetchQuotes(symbols) {
  const resp = await fetch(`${WORKER_URL}?symbols=${symbols}`);
  if (!resp.ok) throw new Error('获取股价失败');
  return resp.json();
}

// ========== 计算逻辑 ==========

function calculate(holdings, quotes) {
  // 第一轮：合并股价，计算市值
  const items = holdings.map((h) => {
    let price, change, changePercent, name;

    if (h.symbol === 'cash') {
      price = 1;
      change = 0;
      changePercent = 0;
      name = h.name;
    } else {
      const q = quotes[h.symbol];
      if (q) {
        price = q.price;
        change = q.change;
        changePercent = q.changePercent;
        name = q.name || h.name;
      } else {
        price = 0;
        change = 0;
        changePercent = 0;
        name = h.name;
      }
    }

    const marketValue = h.shares * price;

    return {
      symbol: h.symbol,
      name,
      shares: h.shares,
      price,
      change,
      changePercent,
      targetPct: h.targetPct,
      marketValue,
    };
  });

  // 总市值
  const totalValue = items.reduce((sum, i) => sum + i.marketValue, 0);

  // 第二轮：计算占比、偏离、操作建议
  for (const item of items) {
    item.actualPct = totalValue > 0 ? (item.marketValue / totalValue) * 100 : 0;
    item.deviation = item.actualPct - item.targetPct;

    // 操作建议
    const absDev = Math.abs(item.deviation);
    if (absDev <= DEVIATION_THRESHOLD) {
      item.action = 'hold';
      item.actionText = '持有';
      item.actionShares = 0;
    } else {
      const targetValue = (item.targetPct / 100) * totalValue;
      const diff = Math.abs(targetValue - item.marketValue);
      const refShares =
        item.symbol === 'cash' ? Math.round(diff) : Math.floor(diff / item.price);

      if (item.deviation > 0) {
        item.action = 'sell';
        item.actionText = `卖出 ~${refShares}${item.symbol === 'cash' ? '元' : '股'}`;
      } else {
        item.action = 'buy';
        item.actionText = `买入 ~${refShares}${item.symbol === 'cash' ? '元' : '股'}`;
      }
      item.actionShares = refShares;
    }
  }

  // 汇总
  const totalTargetPct = items.reduce((s, i) => s + i.targetPct, 0);
  const maxDeviation = Math.max(...items.map((i) => Math.abs(i.deviation)));
  const count = items.length;

  return { items, totalValue, totalTargetPct, maxDeviation, count };
}

// ========== 页面渲染 ==========

function render(portfolio) {
  renderSummary(portfolio);
  renderTable(portfolio.items);
  renderAlerts(portfolio);
}

function renderSummary({ totalValue, count, maxDeviation }) {
  document.getElementById('total-value').textContent = formatCurrency(totalValue);
  document.getElementById('stock-count').textContent = count;
  document.getElementById('max-deviation').textContent = maxDeviation.toFixed(2) + '%';
  document.getElementById('update-time').textContent = formatTime(new Date());

  // 最大偏离度颜色
  const devEl = document.getElementById('max-deviation');
  if (maxDeviation > 10) {
    devEl.className = 'value deviation-danger';
  } else if (maxDeviation > 5) {
    devEl.className = 'value deviation-warn';
  } else {
    devEl.className = 'value';
  }
}

function renderTable(items) {
  const tbody = document.getElementById('holdings-body');
  tbody.innerHTML = '';

  for (const item of items) {
    const tr = document.createElement('tr');
    if (item.symbol === 'cash') tr.classList.add('row-cash');

    // 名称 + 代码
    const tdName = document.createElement('td');
    tdName.innerHTML = `<span class="stock-name">${item.name}</span><span class="stock-symbol">${item.symbol}</span>`;
    tr.appendChild(tdName);

    // 持仓
    tr.appendChild(createTd(item.symbol === 'cash' ? formatCurrency(item.shares) : item.shares.toLocaleString()));

    // 最新价 + 涨跌幅
    const tdPrice = document.createElement('td');
    if (item.symbol === 'cash') {
      tdPrice.textContent = '-';
    } else {
      const priceClass =
        item.changePercent > 0 ? 'price-up' : item.changePercent < 0 ? 'price-down' : 'price-flat';
      const sign = item.changePercent > 0 ? '+' : '';
      tdPrice.innerHTML = `<span class="${priceClass}">${item.price.toFixed(2)} <span class="change-tag">${sign}${item.changePercent.toFixed(2)}%</span></span>`;
    }
    tr.appendChild(tdPrice);

    // 市值
    tr.appendChild(createTd(formatCurrency(item.marketValue)));

    // 目标占比
    tr.appendChild(createTd(item.targetPct.toFixed(1) + '%'));

    // 实际占比
    tr.appendChild(createTd(item.actualPct.toFixed(1) + '%'));

    // 偏离
    const tdDev = document.createElement('td');
    const absDev = Math.abs(item.deviation);
    const devSign = item.deviation > 0 ? '+' : '';
    tdDev.textContent = devSign + item.deviation.toFixed(2) + '%';
    if (absDev > 10) {
      tdDev.className = 'deviation-danger';
    } else if (absDev > 5) {
      tdDev.className = 'deviation-warn';
    } else {
      tdDev.className = 'deviation-normal';
    }
    tr.appendChild(tdDev);

    // 操作建议
    const tdAction = document.createElement('td');
    const actionSpan = document.createElement('span');
    actionSpan.className = `action-tag action-${item.action}`;
    actionSpan.textContent = item.actionText;
    tdAction.appendChild(actionSpan);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }
}

function renderAlerts({ maxDeviation, totalTargetPct }) {
  const container = document.getElementById('alerts');
  container.innerHTML = '';

  if (Math.abs(totalTargetPct - 100) > 0.01) {
    addAlert(
      container,
      'error',
      `配置错误：目标占比合计 ${totalTargetPct.toFixed(1)}%，应为 100%。请检查 portfolio.csv。`
    );
  }

  if (maxDeviation > 5) {
    addAlert(
      container,
      'warning',
      `有标的偏离度超过 ${DEVIATION_THRESHOLD}%，建议检查并调仓。`
    );
  }
}

// ========== 工具函数 ==========

function createTd(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function addAlert(container, type, message) {
  const div = document.createElement('div');
  div.className = `alert alert-${type}`;
  div.textContent = message;
  container.appendChild(div);
}

function formatCurrency(value) {
  return value.toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  });
}

function formatTime(date) {
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function showLoading(show) {
  const el = document.getElementById('loading');
  if (el) el.style.display = show ? 'block' : 'none';
  const main = document.getElementById('main-content');
  if (main) main.style.display = show ? 'none' : 'block';
}

function showError(message) {
  const container = document.getElementById('alerts');
  if (container) {
    addAlert(container, 'error', message);
  }
}
