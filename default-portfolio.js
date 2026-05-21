// 默认持仓数据 — 仅用于未登录用户的 demo 展示
// 数据完全虚构，仅作为新用户首次登录后的初始示例
// 用户首次保存编辑后会写入自己的 KV，互不影响
export const DEFAULT_PORTFOLIO = [
  { symbol: 'sh510300', name: '沪深300ETF',     shares: 100000, targetPct: 25, costPrice: 4.250,  category: '宽基'   },
  { symbol: 'sh510500', name: '中证500ETF',     shares:  50000, targetPct: 15, costPrice: 6.180,  category: '宽基'   },
  { symbol: 'sh515050', name: '中证A50ETF',     shares:  60000, targetPct: 10, costPrice: 1.520,  category: '宽基'   },
  { symbol: 'sh588000', name: '科创50ETF',      shares:  40000, targetPct:  8, costPrice: 1.380,  category: '成长'   },
  { symbol: 'sh513100', name: '纳指ETF',        shares:  20000, targetPct: 10, costPrice: 1.860,  category: '海外'   },
  { symbol: 'sh513500', name: '标普500ETF',     shares:  15000, targetPct:  7, costPrice: 2.140,  category: '海外'   },
  { symbol: 'sh513010', name: '港股科技ETF',    shares:  80000, targetPct:  6, costPrice: 0.620,  category: '港股'   },
  { symbol: 'sh518880', name: '黄金ETF',        shares:   5000, targetPct:  5, costPrice: 8.500,  category: '商品'   },
  { symbol: 'sh511360', name: '短融ETF',        shares:    500, targetPct:  6, costPrice: 110.50, category: '债券'   },
  { symbol: 'sh511260', name: '十年国债ETF',    shares:    600, targetPct:  3, costPrice: 122.80, category: '债券'   },
  { symbol: 'cash',     name: '现金',           shares:  50000, targetPct:  5, costPrice: null,   category: '现金'   },
];
