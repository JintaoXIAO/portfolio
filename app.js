// ========== 配置 ==========
const WORKER_URL = 'https://stock-proxy.xiaojintao.workers.dev';
const DEVIATION_THRESHOLD = 5; // 操作建议阈值 (%)
const REFRESH_INTERVAL = 5 * 60 * 1000; // 自动刷新间隔 (5分钟)
const LOT_SIZE = 100; // ETF 最小交易单位

const CATEGORY_COLORS = {
  '宽基': '#58a6ff',
  '红利': '#f85149',
  '港美股': '#3fb950',
  '债券': '#d29922',
  '商品': '#db6d28',
  '行业': '#bc8cff',
  '现金': '#8b949e',
};
const DEFAULT_COLOR = '#56d4dd';

// ========== 全局状态 ==========
let currentPortfolio = null;
let cachedHoldings = null;
let sortColumn = null;
let sortAscending = true;
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = 0;
let isRefreshing = false;
let lastRefreshTime = null;
let aiAbortController = null;
let isAIAnalyzing = false;

// ========== 入口 ==========
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 先初始化 Clerk，让登录态尽早就绪
  await setupClerk();

  showLoading(true);
  try {
    await loadAndRender();
  } catch (err) {
    showError('加载失败: ' + err.message);
    console.error(err);
  } finally {
    showLoading(false);
  }
  setupSorting();
  setupRebalancer();
  setupAutoRefresh();
  setupAIAnalyzer();
  setupEditors();
}

async function loadAndRender(isRefresh = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  updateRefreshButton();
  try {
    if (!cachedHoldings) {
      cachedHoldings = await loadHoldings();
    }
    const holdings = cachedHoldings;
    const symbols = holdings
      .filter((h) => !isCash(h.symbol))
      .map((h) => h.symbol)
      .join(',');
    const quotes = symbols ? await fetchQuotes(symbols) : {};
    currentPortfolio = calculate(holdings, quotes);
    lastRefreshTime = new Date();
    render(currentPortfolio);
  } finally {
    isRefreshing = false;
    updateRefreshButton();
  }
}

// ========== 数据获取 ==========

/**
 * 加载持仓数据
 * 已登录: 从 /api/portfolio 拉取该用户的持仓
 * 未登录: /api/portfolio 也会返回 demo 数据（worker 端处理）
 * 兜底: worker 完全不可用时，前端内置一份硬编码兜底数据
 */
async function loadHoldings() {
  try {
    const token = await getAuthToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(`${WORKER_URL}/api/portfolio`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data.portfolio) && data.portfolio.length > 0) {
        return data.portfolio;
      }
    }
  } catch (err) {
    console.warn('从 Worker 加载持仓失败，使用前端兜底数据:', err.message);
  }
  return FALLBACK_HOLDINGS;
}

// Worker 完全不可用时使用的硬编码兜底（仅作最后保障）
// 跟 default-portfolio.js 一致，但不能引用所以这里复制一份
const FALLBACK_HOLDINGS = [
  { symbol: 'sh510300', name: '沪深300ETF',  shares: 100000, targetPct: 25, costPrice: 4.250,  category: '宽基' },
  { symbol: 'sh510500', name: '中证500ETF',  shares:  50000, targetPct: 15, costPrice: 6.180,  category: '宽基' },
  { symbol: 'sh515050', name: '中证A50ETF',  shares:  60000, targetPct: 10, costPrice: 1.520,  category: '宽基' },
  { symbol: 'sh588000', name: '科创50ETF',   shares:  40000, targetPct:  8, costPrice: 1.380,  category: '成长' },
  { symbol: 'sh513100', name: '纳指ETF',     shares:  20000, targetPct: 10, costPrice: 1.860,  category: '海外' },
  { symbol: 'sh513500', name: '标普500ETF',  shares:  15000, targetPct:  7, costPrice: 2.140,  category: '海外' },
  { symbol: 'sh513010', name: '港股科技ETF', shares:  80000, targetPct:  6, costPrice: 0.620,  category: '港股' },
  { symbol: 'sh518880', name: '黄金ETF',     shares:   5000, targetPct:  5, costPrice: 8.500,  category: '商品' },
  { symbol: 'sh511360', name: '短融ETF',     shares:    500, targetPct:  6, costPrice: 110.50, category: '债券' },
  { symbol: 'sh511260', name: '十年国债ETF', shares:    600, targetPct:  3, costPrice: 122.80, category: '债券' },
  { symbol: 'cash',     name: '现金',        shares:  50000, targetPct:  5, costPrice: null,   category: '现金' },
];

async function fetchQuotes(symbols) {
  const resp = await fetch(`${WORKER_URL}?symbols=${symbols}`);
  if (!resp.ok) throw new Error('获取股价失败');
  return resp.json();
}

// ========== 计算逻辑 ==========

function calculate(holdings, quotes) {
  // 第一轮：合并数据，计算市值
  const items = holdings.map((h) => {
    let price, change, changePercent, name, quoteError;

    if (isCash(h.symbol)) {
      price = 1;
      change = 0;
      changePercent = 0;
      name = h.name;
      quoteError = false;
    } else {
      const q = quotes[h.symbol];
      if (q && q.price > 0) {
        price = q.price;
        change = q.change;
        changePercent = q.changePercent;
        name = q.name || h.name;
        quoteError = false;
      } else {
        price = 0;
        change = 0;
        changePercent = 0;
        name = h.name;
        quoteError = true;
      }
    }

    const marketValue = h.shares * price;

    // 持仓盈亏
    let pnl = null;
    let pnlPct = null;
    if (!isCash(h.symbol) && h.costPrice != null && h.costPrice > 0 && price > 0) {
      pnl = (price - h.costPrice) * h.shares;
      pnlPct = ((price - h.costPrice) / h.costPrice) * 100;
    }

    return {
      symbol: h.symbol,
      name,
      shares: h.shares,
      price,
      change,
      changePercent,
      targetPct: h.targetPct,
      costPrice: h.costPrice,
      category: h.category,
      marketValue,
      isCash: isCash(h.symbol),
      quoteError,
      pnl,
      pnlPct,
    };
  });

  // 报价异常的品种不参与市值计算
  const validItems = items.filter((i) => !i.quoteError);
  const errorItems = items.filter((i) => i.quoteError);
  const totalValue = validItems.reduce((sum, i) => sum + i.marketValue, 0);

  // 今日盈亏
  const todayPnl = validItems
    .filter((i) => !i.isCash)
    .reduce((sum, i) => sum + i.shares * i.change, 0);

  // 总持仓盈亏
  const totalPnl = validItems
    .filter((i) => i.pnl !== null)
    .reduce((sum, i) => sum + i.pnl, 0);
  const totalCost = validItems
    .filter((i) => !i.isCash && i.costPrice != null && i.costPrice > 0)
    .reduce((sum, i) => sum + i.costPrice * i.shares, 0);
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;

  // 第二轮：计算占比、偏离、操作建议
  for (const item of items) {
    if (item.quoteError) {
      item.actualPct = 0;
      item.deviation = 0;
      item.action = 'error';
      item.actionText = '报价异常';
      item.actionShares = 0;
      continue;
    }

    item.actualPct = totalValue > 0 ? (item.marketValue / totalValue) * 100 : 0;
    item.deviation = item.actualPct - item.targetPct;

    const absDev = Math.abs(item.deviation);
    if (absDev <= DEVIATION_THRESHOLD) {
      item.action = 'hold';
      item.actionText = '持有';
      item.actionShares = 0;
    } else {
      const targetValue = (item.targetPct / 100) * totalValue;
      const diff = Math.abs(targetValue - item.marketValue);

      if (item.isCash) {
        if (item.deviation > 0) {
          item.action = 'sell';
          item.actionText = `转出 ~${formatCurrency(diff)}`;
        } else {
          item.action = 'buy';
          item.actionText = `转入 ~${formatCurrency(diff)}`;
        }
        item.actionShares = 0;
      } else {
        const refShares = Math.floor(diff / item.price);
        if (item.deviation > 0) {
          item.action = 'sell';
          item.actionText = `卖出 ~${refShares}股`;
        } else {
          item.action = 'buy';
          item.actionText = `买入 ~${refShares}股`;
        }
        item.actionShares = refShares;
      }
    }
  }

  // 资产分类聚合
  const categoryMap = {};
  for (const item of validItems) {
    const cat = item.category || '其他';
    if (!categoryMap[cat]) {
      categoryMap[cat] = { name: cat, marketValue: 0, targetPct: 0, items: [] };
    }
    categoryMap[cat].marketValue += item.marketValue;
    categoryMap[cat].targetPct += item.targetPct;
    categoryMap[cat].items.push(item);
  }
  for (const cat of Object.values(categoryMap)) {
    cat.actualPct = totalValue > 0 ? (cat.marketValue / totalValue) * 100 : 0;
    cat.deviation = cat.actualPct - cat.targetPct;
  }
  const categories = Object.values(categoryMap).sort(
    (a, b) => b.marketValue - a.marketValue
  );

  // 汇总
  const totalTargetPct = items.reduce((s, i) => s + i.targetPct, 0);
  const maxDeviation =
    validItems.length > 0
      ? Math.max(...validItems.map((i) => Math.abs(i.deviation)))
      : 0;
  const count = items.length;

  return {
    items,
    totalValue,
    totalTargetPct,
    maxDeviation,
    count,
    todayPnl,
    totalPnl,
    totalPnlPct,
    totalCost,
    categories,
    errorItems,
  };
}

// ========== 增量调仓计算 ==========

function calculateRebalance(portfolio, newCash) {
  if (!portfolio || newCash <= 0) return null;

  const newTotal = portfolio.totalValue + newCash;
  const allocations = [];

  for (const item of portfolio.items) {
    if (item.quoteError || item.isCash) continue;

    const targetValue = (item.targetPct / 100) * newTotal;
    const gap = targetValue - item.marketValue;

    if (gap > 0 && item.price > 0) {
      const lots = Math.floor(gap / item.price / LOT_SIZE);
      const buyShares = lots * LOT_SIZE;
      const buyAmount = buyShares * item.price;

      if (buyShares > 0) {
        allocations.push({
          symbol: item.symbol,
          name: item.name,
          price: item.price,
          buyShares,
          buyAmount,
          targetPct: item.targetPct,
        });
      }
    }
  }

  const totalBuyAmount = allocations.reduce((s, a) => s + a.buyAmount, 0);
  const remainingCash = newCash - totalBuyAmount;

  return { allocations, totalBuyAmount, remainingCash, newTotal };
}

// ========== 页面渲染 ==========

function render(portfolio) {
  renderSummary(portfolio);
  renderPieCharts(portfolio);
  renderCategoryTable(portfolio.categories);
  renderTable(portfolio.items);
  renderAlerts(portfolio);
}

function renderSummary({ totalValue, count, maxDeviation, todayPnl, totalPnl, totalPnlPct }) {
  document.getElementById('total-value').textContent = formatCurrency(totalValue);
  document.getElementById('stock-count').textContent = count;
  document.getElementById('update-time').textContent = formatTime(new Date());

  // 最大偏离
  const devEl = document.getElementById('max-deviation');
  devEl.textContent = maxDeviation.toFixed(2) + '%';
  if (maxDeviation > 10) {
    devEl.className = 'value deviation-danger';
  } else if (maxDeviation > 5) {
    devEl.className = 'value deviation-warn';
  } else {
    devEl.className = 'value';
  }

  // 今日盈亏
  const todayEl = document.getElementById('today-pnl');
  const todaySign = todayPnl >= 0 ? '+' : '';
  todayEl.textContent = todaySign + formatCurrency(todayPnl);
  todayEl.className =
    'value ' + (todayPnl > 0 ? 'pnl-up' : todayPnl < 0 ? 'pnl-down' : '');

  // 总盈亏
  const totalPnlEl = document.getElementById('total-pnl');
  const pnlSign = totalPnl >= 0 ? '+' : '';
  let pnlText = pnlSign + formatCurrency(totalPnl);
  if (totalPnlPct !== null) {
    pnlText += ` (${pnlSign}${totalPnlPct.toFixed(2)}%)`;
  }
  totalPnlEl.textContent = pnlText;
  totalPnlEl.className =
    'value ' + (totalPnl > 0 ? 'pnl-up' : totalPnl < 0 ? 'pnl-down' : '');
}

// ========== 饼图 ==========

function renderPieCharts(portfolio) {
  const validItems = portfolio.items.filter((i) => !i.quoteError);

  renderDonut(
    'target-pie',
    validItems.map((i) => ({
      label: i.name,
      value: i.targetPct,
      color: getCategoryColor(i.category),
    })),
    '目标'
  );

  renderDonut(
    'actual-pie',
    validItems.map((i) => ({
      label: i.name,
      value: i.actualPct,
      color: getCategoryColor(i.category),
    })),
    formatCurrencyShort(portfolio.totalValue)
  );

  // 图例
  renderLegend('target-legend', validItems, 'targetPct');
  renderLegend('actual-legend', validItems, 'actualPct');
}

function renderDonut(containerId, data, centerText) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 75;
  const innerR = 48;
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total <= 0) {
    container.innerHTML = '<div class="pie-empty">无数据</div>';
    return;
  }

  let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;

  let currentAngle = -Math.PI / 2; // 从12点方向开始
  for (const d of data) {
    if (d.value <= 0) continue;
    const sliceAngle = (d.value / total) * 2 * Math.PI;
    const endAngle = currentAngle + sliceAngle;

    // 处理接近360度的情况
    const path =
      sliceAngle >= 2 * Math.PI - 0.001
        ? createFullCirclePath(cx, cy, outerR, innerR)
        : createArcPath(cx, cy, outerR, innerR, currentAngle, endAngle);

    svg += `<path d="${path}" fill="${d.color}" opacity="0.85">`;
    svg += `<title>${d.label}: ${d.value.toFixed(1)}%</title>`;
    svg += `</path>`;

    currentAngle = endAngle;
  }

  // 中心文字
  svg += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="var(--text-primary)" font-size="13" font-weight="700">${centerText}</text>`;
  svg += `<text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="var(--text-secondary)" font-size="10">${containerId.includes('target') ? '目标配置' : '实际配置'}</text>`;
  svg += '</svg>';

  container.innerHTML = svg;
}

function renderLegend(containerId, items, pctField) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const sorted = [...items].sort((a, b) => b[pctField] - a[pctField]);
  container.innerHTML = sorted
    .filter((i) => i[pctField] > 0)
    .map(
      (i) =>
        `<div class="legend-item"><span class="legend-dot" style="background:${getCategoryColor(i.category)}"></span><span class="legend-label">${i.name}</span><span class="legend-value">${i[pctField].toFixed(1)}%</span></div>`
    )
    .join('');
}

function polarToCartesian(cx, cy, r, angle) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function createArcPath(cx, cy, outerR, innerR, startAngle, endAngle) {
  const s1 = polarToCartesian(cx, cy, outerR, startAngle);
  const e1 = polarToCartesian(cx, cy, outerR, endAngle);
  const s2 = polarToCartesian(cx, cy, innerR, endAngle);
  const e2 = polarToCartesian(cx, cy, innerR, startAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${s1.x} ${s1.y}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y}`,
    `L ${s2.x} ${s2.y}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y}`,
    'Z',
  ].join(' ');
}

function createFullCirclePath(cx, cy, outerR, innerR) {
  return [
    `M ${cx} ${cy - outerR}`,
    `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy + outerR}`,
    `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy - outerR}`,
    `M ${cx} ${cy - innerR}`,
    `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy + innerR}`,
    `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy - innerR}`,
    'Z',
  ].join(' ');
}

function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || DEFAULT_COLOR;
}

// ========== 资产分类表 ==========

function renderCategoryTable(categories) {
  const tbody = document.getElementById('category-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const cat of categories) {
    const tr = document.createElement('tr');

    // 颜色标记 + 类别名
    const tdName = document.createElement('td');
    tdName.style.textAlign = 'left';
    tdName.innerHTML = `<span class="legend-dot" style="background:${getCategoryColor(cat.name)}"></span> ${cat.name}`;
    tr.appendChild(tdName);

    tr.appendChild(createTd(formatCurrency(cat.marketValue)));
    tr.appendChild(createTd(cat.targetPct.toFixed(1) + '%'));
    tr.appendChild(createTd(cat.actualPct.toFixed(1) + '%'));

    // 偏离
    const tdDev = document.createElement('td');
    const devSign = cat.deviation > 0 ? '+' : '';
    tdDev.textContent = devSign + cat.deviation.toFixed(2) + '%';
    const absDev = Math.abs(cat.deviation);
    if (absDev > 10) {
      tdDev.className = 'deviation-danger';
    } else if (absDev > 5) {
      tdDev.className = 'deviation-warn';
    } else {
      tdDev.className = 'deviation-normal';
    }
    tr.appendChild(tdDev);

    tbody.appendChild(tr);
  }
}

// ========== 持仓明细表 ==========

function renderTable(items) {
  const tbody = document.getElementById('holdings-body');
  tbody.innerHTML = '';

  const sorted = getSortedItems(items);

  for (const item of sorted) {
    const tr = document.createElement('tr');
    if (item.quoteError) tr.classList.add('row-error');

    // 名称 + 代码
    const tdName = document.createElement('td');
    if (item.isCash) {
      tdName.innerHTML = `<span class="stock-name">${item.name}</span><span class="stock-symbol">现金</span>`;
    } else {
      tdName.innerHTML = `<span class="stock-name">${item.name}</span><span class="stock-symbol">${item.symbol}</span>`;
    }
    tr.appendChild(tdName);

    // 持仓
    if (item.isCash) {
      tr.appendChild(createTd(formatCurrency(item.shares)));
    } else {
      tr.appendChild(createTd(item.shares.toLocaleString()));
    }

    // 最新价 + 涨跌幅
    const tdPrice = document.createElement('td');
    if (item.isCash) {
      tdPrice.innerHTML = '<span class="price-flat">-</span>';
    } else if (item.quoteError) {
      tdPrice.innerHTML = '<span class="price-flat">报价异常</span>';
    } else {
      const priceClass =
        item.changePercent > 0
          ? 'price-up'
          : item.changePercent < 0
            ? 'price-down'
            : 'price-flat';
      const sign = item.changePercent > 0 ? '+' : '';
      tdPrice.innerHTML = `<span class="${priceClass}">${item.price.toFixed(3)} <span class="change-tag">${sign}${item.changePercent.toFixed(2)}%</span></span>`;
    }
    tr.appendChild(tdPrice);

    // 市值
    tr.appendChild(createTd(item.quoteError ? '-' : formatCurrency(item.marketValue)));

    // 盈亏
    const tdPnl = document.createElement('td');
    if (item.isCash || item.quoteError || item.pnl === null) {
      tdPnl.textContent = '-';
      tdPnl.className = 'price-flat';
    } else {
      const pSign = item.pnl >= 0 ? '+' : '';
      tdPnl.innerHTML = `<span class="${item.pnl > 0 ? 'pnl-up' : item.pnl < 0 ? 'pnl-down' : ''}">${pSign}${formatCurrency(item.pnl)}<span class="change-tag">${pSign}${item.pnlPct.toFixed(2)}%</span></span>`;
    }
    tr.appendChild(tdPnl);

    // 目标占比
    tr.appendChild(createTd(item.targetPct.toFixed(1) + '%'));

    // 实际占比
    tr.appendChild(
      createTd(item.quoteError ? '-' : item.actualPct.toFixed(1) + '%')
    );

    // 偏离
    const tdDev = document.createElement('td');
    if (item.quoteError) {
      tdDev.textContent = '-';
    } else {
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

  // 汇总行
  renderTableFooter();
}

function renderTableFooter() {
  const tfoot = document.getElementById('holdings-foot');
  if (!tfoot || !currentPortfolio) return;
  tfoot.innerHTML = '';

  const p = currentPortfolio;
  const tr = document.createElement('tr');
  tr.className = 'row-total';

  const tdLabel = document.createElement('td');
  tdLabel.textContent = '合计';
  tdLabel.style.textAlign = 'left';
  tr.appendChild(tdLabel);

  tr.appendChild(createTd('')); // 持仓
  tr.appendChild(createTd('')); // 最新价
  tr.appendChild(createTd(formatCurrency(p.totalValue))); // 市值

  // 总盈亏
  const tdPnl = document.createElement('td');
  if (p.totalPnlPct !== null) {
    const s = p.totalPnl >= 0 ? '+' : '';
    tdPnl.innerHTML = `<span class="${p.totalPnl > 0 ? 'pnl-up' : p.totalPnl < 0 ? 'pnl-down' : ''}">${s}${formatCurrency(p.totalPnl)}<span class="change-tag">${s}${p.totalPnlPct.toFixed(2)}%</span></span>`;
  } else {
    tdPnl.textContent = '-';
  }
  tr.appendChild(tdPnl);

  tr.appendChild(createTd(p.totalTargetPct.toFixed(1) + '%')); // 目标
  tr.appendChild(createTd('100.0%')); // 实际
  tr.appendChild(createTd('')); // 偏离
  tr.appendChild(createTd('')); // 操作

  tfoot.appendChild(tr);
}

// ========== 排序 ==========

function setupSorting() {
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortColumn === col) {
        sortAscending = !sortAscending;
      } else {
        sortColumn = col;
        sortAscending = col === 'name'; // 文本默认升序，数值默认降序
      }
      if (currentPortfolio) {
        renderTable(currentPortfolio.items);
      }
      updateSortIndicators();
    });
  });
}

function getSortedItems(items) {
  if (!sortColumn) return items;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let va = a[sortColumn];
    let vb = b[sortColumn];
    if (va == null) va = sortColumn === 'name' ? '' : -Infinity;
    if (vb == null) vb = sortColumn === 'name' ? '' : -Infinity;

    let result;
    if (typeof va === 'string' && typeof vb === 'string') {
      result = va.localeCompare(vb, 'zh');
    } else {
      result = va - vb;
    }
    return sortAscending ? result : -result;
  });
  return sorted;
}

function updateSortIndicators() {
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortColumn) {
      th.classList.add(sortAscending ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ========== 警告 ==========

function renderAlerts({ maxDeviation, totalTargetPct, errorItems }) {
  const container = document.getElementById('alerts');
  container.innerHTML = '';

  if (errorItems.length > 0) {
    const names = errorItems.map((i) => i.name).join('、');
    addAlert(
      container,
      'error',
      `报价异常：${names} 无法获取实时价格，已从计算中排除。请检查代码或网络。`
    );
  }

  if (Math.abs(totalTargetPct - 100) > 0.01) {
    addAlert(
      container,
      'error',
      `配置错误：目标占比合计 ${totalTargetPct.toFixed(1)}%，应为 100%。请打开"编辑持仓"调整。`
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

// ========== 自动刷新 & 手动刷新 ==========

function setupAutoRefresh() {
  checkAndToggleRefresh();
  updateMarketStatusDisplay();

  // 每分钟检查是否需要开/关自动刷新
  setInterval(() => {
    checkAndToggleRefresh();
  }, 60000);

  // 每秒更新状态显示
  countdownTimer = setInterval(() => {
    updateMarketStatusDisplay();
  }, 1000);

  // 浮动刷新按钮
  setupRefreshButton();
}

function setupRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (isRefreshing) return;
    try {
      await loadAndRender(true);
      // 重置自动刷新计时
      if (refreshTimer) {
        startRefreshTimer();
      }
    } catch (err) {
      console.error('手动刷新失败:', err);
    }
  });
}

function updateRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  if (isRefreshing) {
    btn.classList.add('refreshing');
    btn.title = '刷新中...';
  } else {
    btn.classList.remove('refreshing');
    btn.title = '点击刷新';
  }
}

function checkAndToggleRefresh() {
  const status = getMarketStatus();
  if (status.shouldRefresh && !refreshTimer) {
    startRefreshTimer();
  } else if (!status.shouldRefresh && refreshTimer) {
    stopRefreshTimer();
  }
}

function startRefreshTimer() {
  stopRefreshTimer();
  nextRefreshAt = Date.now() + REFRESH_INTERVAL;

  refreshTimer = setInterval(async () => {
    try {
      await loadAndRender(true);
    } catch (err) {
      console.error('自动刷新失败:', err);
    }
    nextRefreshAt = Date.now() + REFRESH_INTERVAL;
  }, REFRESH_INTERVAL);
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function getMarketStatus() {
  const str = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
  const bj = new Date(str);
  const day = bj.getDay();
  const t = bj.getHours() * 60 + bj.getMinutes();

  if (day === 0 || day === 6) {
    return { isOpen: false, text: '周末休市', shouldRefresh: false };
  }
  if (t >= 555 && t <= 695) {
    // 9:15 - 11:35
    return { isOpen: true, text: '交易中', shouldRefresh: true };
  }
  if (t > 695 && t < 775) {
    // 11:35 - 12:55
    return { isOpen: false, text: '午间休市', shouldRefresh: false };
  }
  if (t >= 775 && t <= 910) {
    // 12:55 - 15:10
    return { isOpen: true, text: '交易中', shouldRefresh: true };
  }
  if (t < 555) {
    return { isOpen: false, text: '未开盘', shouldRefresh: false };
  }
  return { isOpen: false, text: '已收盘', shouldRefresh: false };
}

function updateMarketStatusDisplay() {
  const el = document.getElementById('market-status');
  if (!el) return;

  const status = getMarketStatus();
  let text = status.text;

  if (status.shouldRefresh && refreshTimer) {
    const remaining = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    const countdown = min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
    text += ` · ${countdown}后刷新`;
    el.className = 'market-status market-open';
  } else {
    el.className = 'market-status market-closed';
  }

  if (lastRefreshTime) {
    const ago = Math.floor((Date.now() - lastRefreshTime.getTime()) / 1000);
    let agoText;
    if (ago < 60) {
      agoText = `${ago}秒前更新`;
    } else if (ago < 3600) {
      agoText = `${Math.floor(ago / 60)}分钟前更新`;
    } else {
      agoText = formatTime(lastRefreshTime) + ' 更新';
    }
    text += ` · ${agoText}`;
  }

  el.textContent = text;
}

// ========== 增量调仓 ==========

function setupRebalancer() {
  const btn = document.getElementById('calc-rebalance-btn');
  const input = document.getElementById('new-cash-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    const amount = parseFloat(input.value);
    if (!amount || amount <= 0) {
      input.classList.add('input-error');
      setTimeout(() => input.classList.remove('input-error'), 1000);
      return;
    }
    if (!currentPortfolio) return;

    const result = calculateRebalance(currentPortfolio, amount);
    renderRebalanceResult(result, amount);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btn.click();
  });
}

function renderRebalanceResult(result, inputAmount) {
  const container = document.getElementById('rebalance-result');
  if (!container || !result) return;

  if (result.allocations.length === 0) {
    container.innerHTML =
      '<div class="alert alert-info">当前所有持仓均不需要增配，资金将留作现金。</div>';
    return;
  }

  let html = '<table><thead><tr>';
  html += '<th style="text-align:left">标的</th>';
  html += '<th>买入股数</th><th>买入金额</th><th>目标占比</th>';
  html += '</tr></thead><tbody>';

  for (const a of result.allocations) {
    html += '<tr>';
    html += `<td style="text-align:left"><span class="stock-name">${a.name}</span></td>`;
    html += `<td>${a.buyShares.toLocaleString()}</td>`;
    html += `<td>${formatCurrency(a.buyAmount)}</td>`;
    html += `<td>${a.targetPct.toFixed(1)}%</td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';

  html += '<div class="rebalance-summary">';
  html += `<span>投入: ${formatCurrency(inputAmount)}</span>`;
  html += `<span>买入合计: ${formatCurrency(result.totalBuyAmount)}</span>`;
  html += `<span>剩余现金: ${formatCurrency(result.remainingCash)}</span>`;
  html += '</div>';
  html += `<div class="rebalance-note">* 按 ${LOT_SIZE} 股整手计算，余额留作现金</div>`;

  container.innerHTML = html;
}

// ========== 工具函数 ==========

function isCash(symbol) {
  return symbol.toLowerCase() === 'cash';
}

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

function formatCurrencyShort(value) {
  if (value >= 1e8) return (value / 1e8).toFixed(2) + '亿';
  if (value >= 1e4) return (value / 1e4).toFixed(1) + '万';
  return formatCurrency(value);
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

// ========== AI 持仓分析 ==========

function setupAIAnalyzer() {
  const btn = document.getElementById('ai-analyze-btn');
  const stopBtn = document.getElementById('ai-stop-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (isAIAnalyzing) return;
    if (!currentUserId) {
      // 未登录直接打开登录窗
      if (window.Clerk) window.Clerk.openSignIn({ redirectUrl: window.location.href });
      return;
    }
    if (!currentPortfolio) {
      showError('请先加载持仓数据');
      return;
    }
    startAIAnalysis();
  });

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      stopAIAnalysis();
    });
  }
}

async function startAIAnalysis() {
  const btn = document.getElementById('ai-analyze-btn');
  const stopBtn = document.getElementById('ai-stop-btn');
  const resultDiv = document.getElementById('ai-result');
  const contentDiv = document.getElementById('ai-content');

  if (!btn || !resultDiv || !contentDiv) return;

  // 准备 UI
  isAIAnalyzing = true;
  btn.disabled = true;
  btn.classList.add('ai-btn-loading');
  btn.innerHTML = `<span class="ai-spinner"></span>分析中...`;
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  resultDiv.style.display = 'block';
  contentDiv.innerHTML = '<div class="ai-typing">AI 正在分析您的持仓数据...</div>';

  // 准备发送的数据
  const portfolio = preparePortfolioForAI(currentPortfolio);

  // 创建 AbortController 用于取消请求
  aiAbortController = new AbortController();

  try {
    const token = await getAuthToken();
    if (!token) {
      throw new Error('请先登录后再使用 AI 分析');
    }
    const resp = await fetch(`${WORKER_URL}/ai/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ portfolio }),
      signal: aiAbortController.signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: '请求失败' }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }

    // 读取 SSE 流
    await readSSEStream(resp.body, contentDiv);
  } catch (err) {
    if (err.name === 'AbortError') {
      appendToContent(contentDiv, '\n\n---\n*分析已停止*');
    } else {
      contentDiv.innerHTML = `<div class="ai-error">分析失败: ${err.message}</div>`;
    }
  } finally {
    finishAIAnalysis();
  }
}

function stopAIAnalysis() {
  if (aiAbortController) {
    aiAbortController.abort();
    aiAbortController = null;
  }
}

function finishAIAnalysis() {
  isAIAnalyzing = false;
  aiAbortController = null;

  const btn = document.getElementById('ai-analyze-btn');
  const stopBtn = document.getElementById('ai-stop-btn');

  if (btn) {
    btn.disabled = false;
    btn.classList.remove('ai-btn-loading');
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93"/><path d="M8.24 9.93A4 4 0 0 1 12 2"/><path d="M12 18v4"/><path d="M8 22h8"/><circle cx="12" cy="14" r="4"/></svg>重新分析`;
  }
  if (stopBtn) stopBtn.style.display = 'none';
}

/**
 * 读取 SSE 流并实时渲染内容
 *
 * 兼容推理模型（如 Kimi K2.6）的两段式输出：
 *   1. reasoning_content（思维链）：渲染到可折叠的"思考过程"区块
 *   2. content（最终回答）：渲染到主内容区
 * 当 content 开始流入时，自动折叠思考区块。
 */
async function readSSEStream(body, contentDiv) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let reasoningText = '';
  let answerText = '';
  let buffer = '';
  let collapsedOnce = false;
  let finishReason = null;

  // 构建容器：思考区块 + 答案区块
  contentDiv.innerHTML = `
    <details class="ai-thinking" open>
      <summary>
        <span class="ai-thinking-icon"></span>
        <span class="ai-thinking-label">正在思考...</span>
      </summary>
      <div class="ai-thinking-body"></div>
    </details>
    <div class="ai-answer"></div>
  `;
  const thinkingEl = contentDiv.querySelector('.ai-thinking');
  const thinkingBody = contentDiv.querySelector('.ai-thinking-body');
  const thinkingLabel = contentDiv.querySelector('.ai-thinking-label');
  const answerEl = contentDiv.querySelector('.ai-answer');

  function handleToken(tok) {
    if (!tok) return;
    if (tok.type === 'reasoning') {
      reasoningText += tok.text;
      thinkingBody.textContent = reasoningText;
      thinkingBody.scrollTop = thinkingBody.scrollHeight;
    } else if (tok.type === 'content') {
      if (!collapsedOnce) {
        collapsedOnce = true;
        thinkingEl.open = false;
        thinkingLabel.textContent = '查看思考过程';
        thinkingEl.classList.add('ai-thinking-done');
      }
      answerText += tok.text;
      renderMarkdown(answerEl, answerText);
    } else if (tok.type === 'finish') {
      finishReason = tok.reason;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      handleToken(extractToken(line));
    }
  }

  // 处理缓冲区残留
  handleToken(extractToken(buffer));

  // 流结束兜底
  if (!answerText && !reasoningText) {
    contentDiv.innerHTML = '<div class="ai-error">AI 未返回任何内容，请重试。</div>';
    return;
  }

  // 如果只有思考没有正式回答（异常情况），把思考当成答案展示
  if (!answerText && reasoningText) {
    thinkingEl.remove();
    answerEl.textContent = reasoningText;
    return;
  }

  // 没有思考过程的情况，移除空的思考区块
  if (!reasoningText) {
    thinkingEl.remove();
  } else if (!collapsedOnce) {
    thinkingLabel.textContent = '思考过程';
  }

  // 被 max_tokens 截断时给出提示
  if (finishReason === 'length') {
    const warning = document.createElement('div');
    warning.className = 'ai-truncated-warning';
    warning.innerHTML = '⚠️ 回答因长度限制被截断，可重新分析或在 worker.js 中增加 <code>max_tokens</code>。';
    answerEl.appendChild(warning);
  }
}

/**
 * 从 SSE 行中提取文本 token
 * 返回 { type: 'reasoning' | 'content' | 'finish', text?: string, reason?: string } 或 null
 *
 * 兼容三种格式：
 *   旧格式: {"response": "text"} -> 视为 content
 *   OpenAI 兼容: {"choices": [{"delta": {"content": "text"}}]}
 *   推理模型: {"choices": [{"delta": {"reasoning_content": "text"}}]}
 *   结束信号: {"choices": [{"finish_reason": "stop|length|..."}]}
 */
function extractToken(line) {
  const trimmed = (line || '').trim();
  if (!trimmed || trimmed === 'data: [DONE]') return null;
  if (!trimmed.startsWith('data: ')) return null;

  try {
    const data = JSON.parse(trimmed.slice(6));

    // 旧格式
    if (data.response) return { type: 'content', text: data.response };

    const choice = data.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (delta.content) return { type: 'content', text: delta.content };
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) return { type: 'reasoning', text: reasoning };
    }

    // 结束原因（length = 被 max_tokens 截断）
    if (choice?.finish_reason) {
      return { type: 'finish', reason: choice.finish_reason };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 简易 Markdown 渲染（支持标题、加粗、列表、表格、引用块、分隔线、段落）
 */
function renderMarkdown(container, text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  let listType = '';
  let inTable = false;
  let tableRows = [];
  let inBlockquote = false;
  let blockquoteLines = [];

  function flushList() {
    if (inList) { html += `</${listType}>`; inList = false; }
  }

  function flushTable() {
    if (!inTable) return;
    inTable = false;
    if (tableRows.length === 0) return;

    html += '<div class="ai-table-wrapper"><table class="ai-table">';

    // 第一行为表头
    html += '<thead><tr>';
    for (const cell of tableRows[0]) {
      html += `<th>${inlineFormat(cell)}</th>`;
    }
    html += '</tr></thead>';

    // 跳过分隔行（第二行 ---），剩余为表体
    html += '<tbody>';
    for (let i = 2; i < tableRows.length; i++) {
      html += '<tr>';
      for (let j = 0; j < tableRows[i].length; j++) {
        html += `<td>${inlineFormat(tableRows[i][j])}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    tableRows = [];
  }

  function flushBlockquote() {
    if (!inBlockquote) return;
    inBlockquote = false;
    html += '<blockquote class="ai-blockquote">';
    html += blockquoteLines.map((l) => `<p>${inlineFormat(l)}</p>`).join('');
    html += '</blockquote>';
    blockquoteLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 表格行检测：包含 | 且非分隔行单独出现
    const isTableRow = /^\|(.+)\|$/.test(line.trim());
    const isTableSep = /^\|[\s:|-]+\|$/.test(line.trim());

    if (isTableRow || isTableSep) {
      flushList();
      flushBlockquote();
      if (!inTable) inTable = true;

      if (!isTableSep) {
        const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
        tableRows.push(cells);
      } else {
        // 分隔行占位，用于区分表头和表体
        tableRows.push(null);
      }
      continue;
    } else if (inTable) {
      flushTable();
    }

    // 引用块
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      flushList();
      flushTable();
      inBlockquote = true;
      blockquoteLines.push(bqMatch[1]);
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // 水平线
    if (/^---+$/.test(line.trim())) {
      flushList();
      html += '<hr>';
      continue;
    }

    // 标题
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      html += `<h${level + 2}>${inlineFormat(headingMatch[2])}</h${level + 2}>`;
      continue;
    }

    // 有序列表
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        flushList();
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      html += `<li>${inlineFormat(olMatch[1])}</li>`;
      continue;
    }

    // 无序列表
    const ulMatch = line.match(/^[-*]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        flushList();
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      html += `<li>${inlineFormat(ulMatch[1])}</li>`;
      continue;
    }

    // 非列表行 -> 关闭列表
    if (inList && line.trim() === '') {
      flushList();
    }

    // 空行
    if (line.trim() === '') {
      continue;
    }

    // 普通段落
    flushList();
    html += `<p>${inlineFormat(line)}</p>`;
  }

  flushList();
  flushTable();
  flushBlockquote();

  container.innerHTML = html;
}

/**
 * 内联格式化：加粗、斜体、代码
 */
function inlineFormat(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function appendToContent(contentDiv, text) {
  const current = contentDiv.textContent || '';
  renderMarkdown(contentDiv, current + text);
}

/**
 * 将 currentPortfolio 精简为适合发送给 AI 的格式
 */
function preparePortfolioForAI(portfolio) {
  return {
    totalValue: portfolio.totalValue,
    todayPnl: portfolio.todayPnl,
    totalPnl: portfolio.totalPnl,
    totalPnlPct: portfolio.totalPnlPct,
    totalCost: portfolio.totalCost,
    count: portfolio.count,
    maxDeviation: portfolio.maxDeviation,
    categories: portfolio.categories.map((cat) => ({
      name: cat.name,
      marketValue: cat.marketValue,
      targetPct: cat.targetPct,
      actualPct: cat.actualPct,
      deviation: cat.deviation,
    })),
    items: portfolio.items
      .filter((i) => !i.quoteError)
      .map((i) => ({
        name: i.name,
        symbol: i.symbol,
        category: i.category,
        shares: i.shares,
        price: i.price,
        marketValue: i.marketValue,
        targetPct: i.targetPct,
        actualPct: i.actualPct,
        deviation: i.deviation,
        pnl: i.pnl,
        pnlPct: i.pnlPct,
        costPrice: i.costPrice,
        changePercent: i.changePercent,
        isCash: i.isCash,
        actionText: i.actionText,
      })),
  };
}

// ========== 持仓 / Prompt 编辑器 ==========

function setupEditors() {
  // 模态框关闭按钮
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  // 点击遮罩关闭
  document.querySelectorAll('.modal-mask').forEach((mask) => {
    mask.addEventListener('click', () => {
      const modal = mask.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });
  // ESC 关闭最上层模态
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal:not([hidden])');
      if (open) closeModal(open.id);
    }
  });

  setupPortfolioEditor();
  setupPromptEditor();
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

// ----- 持仓编辑器 -----

function setupPortfolioEditor() {
  const btn = document.getElementById('edit-portfolio-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    renderPortfolioEditTable(cachedHoldings || []);
    document.getElementById('portfolio-edit-error').hidden = true;
    openModal('portfolio-modal');
  });

  document.getElementById('add-holding-btn').addEventListener('click', () => {
    appendPortfolioEditRow({ symbol: '', name: '', shares: 0, targetPct: 0, costPrice: null, category: '' });
    updateTargetPctTotal();
  });

  document.getElementById('save-portfolio-btn').addEventListener('click', savePortfolioFromEditor);
}

function renderPortfolioEditTable(holdings) {
  const tbody = document.getElementById('portfolio-edit-body');
  tbody.innerHTML = '';
  holdings.forEach((h) => appendPortfolioEditRow(h));
  updateTargetPctTotal();
}

function appendPortfolioEditRow(h) {
  const tbody = document.getElementById('portfolio-edit-body');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="cell-input" data-field="symbol" value="${escapeAttr(h.symbol || '')}" placeholder="sh600519" /></td>
    <td><input type="text" class="cell-input" data-field="name" value="${escapeAttr(h.name || '')}" placeholder="名称" /></td>
    <td><input type="number" class="cell-input" data-field="shares" value="${h.shares ?? 0}" min="0" step="100" /></td>
    <td><input type="number" class="cell-input cell-target" data-field="targetPct" value="${h.targetPct ?? 0}" min="0" max="100" step="0.1" /></td>
    <td><input type="number" class="cell-input" data-field="costPrice" value="${h.costPrice ?? ''}" min="0" step="0.001" placeholder="可选" /></td>
    <td><input type="text" class="cell-input" data-field="category" value="${escapeAttr(h.category || '')}" placeholder="分类" /></td>
    <td><button class="row-delete" title="删除该行">×</button></td>
  `;
  tr.querySelector('.row-delete').addEventListener('click', () => {
    tr.remove();
    updateTargetPctTotal();
  });
  tr.querySelector('.cell-target').addEventListener('input', updateTargetPctTotal);
  tbody.appendChild(tr);
}

function updateTargetPctTotal() {
  const inputs = document.querySelectorAll('#portfolio-edit-body .cell-target');
  let total = 0;
  inputs.forEach((i) => { total += parseFloat(i.value) || 0; });
  const el = document.getElementById('target-pct-total');
  el.textContent = total.toFixed(2) + '%';
  el.style.color = Math.abs(total - 100) > 0.5 ? '#f85149' : '#3fb950';
}

function collectPortfolioFromEditor() {
  const rows = document.querySelectorAll('#portfolio-edit-body tr');
  const list = [];
  for (const tr of rows) {
    const obj = {};
    tr.querySelectorAll('.cell-input').forEach((input) => {
      const f = input.dataset.field;
      const v = input.value.trim();
      if (f === 'shares' || f === 'targetPct') {
        obj[f] = parseFloat(v) || 0;
      } else if (f === 'costPrice') {
        obj[f] = v ? parseFloat(v) : null;
      } else {
        obj[f] = v;
      }
    });
    list.push(obj);
  }
  return list;
}

async function savePortfolioFromEditor() {
  const errEl = document.getElementById('portfolio-edit-error');
  errEl.hidden = true;

  const portfolio = collectPortfolioFromEditor();

  // 客户端先做基本校验
  if (portfolio.length === 0) {
    showEditorError(errEl, '至少需要一行持仓');
    return;
  }
  for (let i = 0; i < portfolio.length; i++) {
    const h = portfolio[i];
    if (!h.symbol) { showEditorError(errEl, `第 ${i + 1} 行缺少代码`); return; }
    if (!h.name) { showEditorError(errEl, `第 ${i + 1} 行缺少名称`); return; }
    if (!h.category) { showEditorError(errEl, `第 ${i + 1} 行缺少分类`); return; }
  }
  const total = portfolio.reduce((s, h) => s + (h.targetPct || 0), 0);
  if (Math.abs(total - 100) > 0.5) {
    showEditorError(errEl, `目标占比合计为 ${total.toFixed(2)}%，应为 100%`);
    return;
  }

  const btn = document.getElementById('save-portfolio-btn');
  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    await authedRequest(`${WORKER_URL}/api/portfolio`, {
      method: 'PUT',
      body: JSON.stringify({ portfolio }),
    });
    cachedHoldings = portfolio;
    closeModal('portfolio-modal');
    await loadAndRender(true);
  } catch (err) {
    showEditorError(errEl, '保存失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

// ----- Prompt 编辑器 -----

function setupPromptEditor() {
  const btn = document.getElementById('edit-prompt-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const errEl = document.getElementById('prompt-edit-error');
    errEl.hidden = true;
    const ta = document.getElementById('prompt-textarea');
    ta.value = '加载中...';
    ta.disabled = true;
    openModal('prompt-modal');
    try {
      const token = await getAuthToken();
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(`${WORKER_URL}/api/prompt`, { headers });
      const data = await resp.json();
      ta.value = data.prompt || '';
    } catch (err) {
      ta.value = '';
      showEditorError(errEl, '加载失败: ' + err.message);
    } finally {
      ta.disabled = false;
    }
  });

  document.getElementById('save-prompt-btn').addEventListener('click', savePromptFromEditor);
  document.getElementById('reset-prompt-btn').addEventListener('click', resetPrompt);
}

async function savePromptFromEditor() {
  const errEl = document.getElementById('prompt-edit-error');
  errEl.hidden = true;
  const ta = document.getElementById('prompt-textarea');
  const prompt = ta.value.trim();

  if (!prompt) {
    showEditorError(errEl, 'Prompt 不能为空');
    return;
  }

  const btn = document.getElementById('save-prompt-btn');
  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    await authedRequest(`${WORKER_URL}/api/prompt`, {
      method: 'PUT',
      body: JSON.stringify({ prompt }),
    });
    closeModal('prompt-modal');
  } catch (err) {
    showEditorError(errEl, '保存失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function resetPrompt() {
  if (!confirm('确定要重置为内置默认 Prompt 吗？该操作会删除你保存在云端的版本。')) return;
  const errEl = document.getElementById('prompt-edit-error');
  errEl.hidden = true;

  try {
    await authedRequest(`${WORKER_URL}/api/prompt`, {
      method: 'PUT',
      body: JSON.stringify({ reset: true }),
    });
    // 重新加载（带 token）
    const token = await getAuthToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(`${WORKER_URL}/api/prompt`, { headers });
    const data = await resp.json();
    document.getElementById('prompt-textarea').value = data.prompt || '';
  } catch (err) {
    showEditorError(errEl, '重置失败: ' + err.message);
  }
}

// ----- Clerk 认证 -----

/**
 * 等待 Clerk SDK 加载完成
 * Clerk 通过 <script async> 加载，window.Clerk 异步出现
 */
function waitForClerk() {
  return new Promise((resolve, reject) => {
    if (window.Clerk) return resolve(window.Clerk);
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.Clerk) {
        clearInterval(timer);
        resolve(window.Clerk);
      } else if (Date.now() - start > 15000) {
        clearInterval(timer);
        reject(new Error('Clerk SDK 加载超时（请检查网络是否能访问 clerk.accounts.dev）'));
      }
    }, 50);
  });
}

/**
 * 初始化 Clerk，渲染顶部登录区
 * 由 init() 在页面启动时调用
 */
async function setupClerk() {
  const authArea = document.getElementById('auth-area');
  const banner = document.getElementById('demo-banner');

  try {
    const clerk = await waitForClerk();
    await clerk.load();

    const renderAuth = () => {
      authArea.innerHTML = '';

      if (clerk.user) {
        // 已登录：显示用户按钮 + 邮箱
        const wrap = document.createElement('div');
        wrap.className = 'auth-user';
        wrap.innerHTML = `
          <span class="auth-email">${escapeAttr(clerk.user.primaryEmailAddress?.emailAddress || clerk.user.username || '已登录')}</span>
          <div id="clerk-user-button"></div>
        `;
        authArea.appendChild(wrap);
        clerk.mountUserButton(wrap.querySelector('#clerk-user-button'), {
          afterSignOutUrl: window.location.href,
        });
        if (banner) banner.hidden = true;
      } else {
        // 未登录：显示登录按钮
        const btn = document.createElement('button');
        btn.className = 'auth-login-btn';
        btn.textContent = '登录 / 注册';
        btn.addEventListener('click', () => {
          clerk.openSignIn({ redirectUrl: window.location.href });
        });
        authArea.appendChild(btn);
        if (banner) banner.hidden = false;
      }
    };

    renderAuth();

    // 登录态变化时重渲染
    clerk.addListener(({ user }) => {
      const wasLoggedIn = !!currentUserId;
      currentUserId = user?.id || null;
      renderAuth();
      updateEditButtonsVisibility();
      // 登录状态变化后重载持仓数据
      if ((!!currentUserId) !== wasLoggedIn) {
        cachedHoldings = null;
        loadAndRender(true).catch((e) => console.error(e));
      }
    });

    currentUserId = clerk.user?.id || null;
    updateEditButtonsVisibility();
  } catch (err) {
    console.error('[clerk] 初始化失败:', err);
    authArea.innerHTML = '<div class="auth-error">登录服务不可用</div>';
    if (banner) banner.hidden = false;
    updateEditButtonsVisibility();
  }

  // demo banner 上的"登录"链接
  document.getElementById('demo-login-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.Clerk) window.Clerk.openSignIn({ redirectUrl: window.location.href });
  });
}

/**
 * 未登录时隐藏编辑按钮 + 给 AI 按钮加锁标记
 */
function updateEditButtonsVisibility() {
  const loggedIn = !!currentUserId;
  const editPortfolio = document.getElementById('edit-portfolio-btn');
  const editPrompt = document.getElementById('edit-prompt-btn');
  if (editPortfolio) editPortfolio.style.display = loggedIn ? '' : 'none';
  if (editPrompt) editPrompt.style.display = loggedIn ? '' : 'none';

  const aiBtn = document.getElementById('ai-analyze-btn');
  if (aiBtn) {
    if (!loggedIn) {
      aiBtn.title = '登录后可使用 AI 分析';
      aiBtn.classList.add('ai-btn-locked');
    } else {
      aiBtn.title = '';
      aiBtn.classList.remove('ai-btn-locked');
    }
  }
}

/**
 * 获取当前 Clerk session token；未登录返回 null
 */
async function getAuthToken() {
  if (!window.Clerk?.session) return null;
  try {
    return await window.Clerk.session.getToken();
  } catch {
    return null;
  }
}

let currentUserId = null;

/**
 * 带 Clerk JWT 的 fetch 包装
 * 401 时引导用户登录后重试一次
 */
async function authedRequest(url, options = {}) {
  let token = await getAuthToken();
  if (!token) {
    if (window.Clerk) {
      window.Clerk.openSignIn({ redirectUrl: window.location.href });
    }
    throw new Error('请先登录');
  }

  let resp = await doRequest(url, options, token);
  if (resp.status === 401) {
    // token 可能过期，强制刷新一次
    token = await getAuthToken();
    if (!token) throw new Error('登录已失效，请重新登录');
    resp = await doRequest(url, options, token);
  }

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

function doRequest(url, options, token) {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

// ----- 工具 -----

function showEditorError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
