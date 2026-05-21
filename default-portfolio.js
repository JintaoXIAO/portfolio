// 默认持仓数据 — 当 KV 中无数据时作为初始值返回
// 用户首次访问后可在前端 UI 编辑并保存到 KV
export const DEFAULT_PORTFOLIO = [
  { symbol: 'sz159361', name: 'A500ETF',      shares: 394900, targetPct: 23, costPrice: 1.225,   category: '宽基'   },
  { symbol: 'sh512890', name: '红利低波ETF',   shares: 313300, targetPct: 18, costPrice: 1.190,   category: '红利'   },
  { symbol: 'sh588000', name: '科创50ETF',     shares: 181800, targetPct: 12, costPrice: 1.409,   category: '宽基'   },
  { symbol: 'sh513010', name: '港股科技ETF',   shares: 329300, targetPct: 10, costPrice: 0.637,   category: '港美股' },
  { symbol: 'sz159655', name: '标普ETF',       shares: 112000, targetPct:  9, costPrice: 1.667,   category: '港美股' },
  { symbol: 'sh511360', name: '短融ETF',       shares:   1000, targetPct:  5, costPrice: 112.767, category: '债券'   },
  { symbol: 'sh518880', name: '黄金ETF',       shares:   9600, targetPct:  5, costPrice: 10.311,  category: '商品'   },
  { symbol: 'sh513880', name: '日经225ETF',    shares:  47900, targetPct:  4, costPrice: 1.719,   category: '港美股' },
  { symbol: 'sh512400', name: '有色ETF',       shares:  30400, targetPct:  3, costPrice: 1.947,   category: '行业'   },
  { symbol: 'sh563300', name: '中证2000ETF',   shares:  42200, targetPct:  3, costPrice: 1.416,   category: '宽基'   },
  { symbol: 'cash',     name: '现金',          shares: 168570, targetPct:  8, costPrice: null,    category: '现金'   },
];
