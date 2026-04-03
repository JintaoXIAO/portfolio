// ========== 配置 ==========
const WORKER_URL = 'https://stock-proxy.xiaojintao.workers.dev';
const DEVIATION_THRESHOLD = 5; // 操作建议阈值 (%)
const REFRESH_INTERVAL = 15000; // 自动刷新间隔 (ms)
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

// ========== 入口 ==========
document.addEventListener('DOMContentLoaded', init);

async function init() {
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
}

async function loadAndRender(isRefresh = false) {
  if (!cachedHoldings) {
    cachedHoldings = await fetchCSV('portfolio.csv');
  }
  const holdings = cachedHoldings;
  const symbols = holdings
    .filter((h) => !isCash(h.symbol))
    .map((h) => h.symbol)
    .join(',');
  const quotes = symbols ? await fetchQuotes(symbols) : {};
  currentPortfolio = calculate(holdings, quotes);
  render(currentPortfolio);
}

// ========== 数据获取 ==========

async function fetchCSV(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('无法加载 portfolio.csv');
  const text = await resp.text();
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim());

  return lines
    .slice(1)
    .map((line) => {
      const values = line.split(',');
      return {
        symbol: (values[0] || '').trim(),
        name: (values[1] || '').trim(),
        shares: parseFloat(values[2]) || 0,
        targetPct: parseFloat(values[3]) || 0,
        costPrice: values[4] && values[4].trim() ? parseFloat(values[4]) : null,
        category: (values[5] || '其他').trim(),
      };
    })
    .filter((h) => h.symbol);
}

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

// ========== 自动刷新 ==========

function setupAutoRefresh() {
  checkAndToggleRefresh();
  updateMarketStatusDisplay();

  // 每分钟检查是否需要开/关自动刷新
  setInterval(() => {
    checkAndToggleRefresh();
  }, 60000);

  // 每秒更新倒计时
  countdownTimer = setInterval(() => {
    updateMarketStatusDisplay();
  }, 1000);
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
  if (status.shouldRefresh && refreshTimer) {
    const remaining = Math.max(
      0,
      Math.ceil((nextRefreshAt - Date.now()) / 1000)
    );
    el.textContent = `${status.text} · ${remaining}s 后刷新`;
    el.className = 'market-status market-open';
  } else {
    el.textContent = status.text;
    el.className = 'market-status market-closed';
  }
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
