export const INSTRUMENT_ID = "ETH-USDT-SWAP";
// OKX V5 规范: ETH-USDT-SWAP 1张合约 = 0.1 ETH
// 注意: 实际交易前请核对 OKX 文档，部分币种为 0.01 或 10 USD
export const CONTRACT_VAL_ETH = 0.1;

export const DEFAULT_CONFIG = {
  okxApiKey: "",
  okxSecretKey: "",
  okxPassphrase: "",
  deepseekApiKey: "", 
  isSimulation: true, 
};

// 10U 战神策略阶段定义
export const STRATEGY_STAGES = {
  STAGE_1: {
    name: "起步期 (高风险搏杀)", 
    max_equity: 20,
    leverage: 100, 
    risk_factor: 0.8, // 初始开仓使用 80% 余额
    allow_dca: true,  // 允许补仓
    max_pos_ratio: 3.0, // 最大允许持仓名义价值是本金的 3 倍 (10U本金 -> 可持仓30U名义价值，约0.01 ETH)
  },
  STAGE_2: {
    name: "滚仓期 (资金积累)",
    max_equity: 80,
    leverage: 50,
    risk_factor: 0.5, 
    allow_dca: true,
    max_pos_ratio: 2.0, // 风控收紧
  },
  STAGE_3: {
    name: "稳健期 (模式转型)",
    min_equity: 80,
    leverage: 30,
    allow_dca: false, // 稳健期一般不建议逆势补仓，错了就认赔
    max_pos_ratio: 1.5,
  }
};

export const MOCK_TICKER = {
  instId: INSTRUMENT_ID,
  last: "3250.50",
  lastSz: "1.2",
  askPx: "3250.60",
  bidPx: "3250.40",
  open24h: "3100.00",
  high24h: "3300.00",
  low24h: "3050.00",
  volCcy24h: "500000000",
  ts: Date.now().toString(),
};
