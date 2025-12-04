
import { AIDecision, MarketDataCollection, AccountContext } from "../types";
import { CONTRACT_VAL_ETH, STRATEGY_STAGES, INSTRUMENT_ID } from "../constants";

// --- Technical Indicator Helpers ---

const calcRSI = (prices: number[], period: number = 7): number => {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const calcEMA = (prices: number[], period: number): number => {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
};

const calcMACD = (prices: number[]) => {
  const shortPeriod = 12;
  const longPeriod = 26;
  
  if (prices.length < longPeriod) return { macd: 0, signal: 0, hist: 0 };
  
  const ema12 = calcEMA(prices.slice(-shortPeriod), shortPeriod);
  const ema26 = calcEMA(prices.slice(-longPeriod), longPeriod);
  
  const macdLine = ema12 - ema26;
  const signalLine = macdLine * 0.8; 
  
  return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
};

// --- DeepSeek API Helper ---
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

const callDeepSeek = async (apiKey: string, messages: any[]) => {
    // 1. Clean and Validate API Key
    const cleanKey = apiKey ? apiKey.trim() : "";
    if (!cleanKey) throw new Error("API Key 为空");

    // Check for non-ASCII characters (e.g., Chinese, Full-width spaces)
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(cleanKey)) {
        throw new Error("API Key 包含非法字符(中文或特殊符号)，请检查是否有复制多余内容");
    }

    try {
        const response = await fetch(DEEPSEEK_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${cleanKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat", // 使用 deepseek-chat (V3) 模型
                messages: messages,
                stream: false,
                temperature: 1.0, // 增加一定的创造性，防止死板
                max_tokens: 4096,
                response_format: { type: 'json_object' } // 强制 JSON 输出
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`DeepSeek API Error: ${response.status} - ${errText}`);
        }

        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e: any) {
        throw new Error(e.message || "DeepSeek 请求失败");
    }
};

// --- Test Connection Function ---
export const testConnection = async (apiKey: string): Promise<string> => {
  if (!apiKey) throw new Error("API Key 为空");
  try {
    // 必须在提示词中包含 "JSON" 字样，否则 deepseek 会报 400 错误
    const content = await callDeepSeek(apiKey, [
        { role: "user", content: "Please respond with a JSON object containing the message 'OK'." }
    ]);
    return content || "无响应内容";
  } catch (e: any) {
    throw new Error(e.message || "连接失败");
  }
};

// --- Main Decision Function ---

export const getTradingDecision = async (
  apiKey: string,
  marketData: MarketDataCollection,
  accountData: AccountContext
): Promise<AIDecision> => {
  if (!apiKey) throw new Error("请输入 DeepSeek API Key");

  // 1. Data Prep
  const currentPrice = parseFloat(marketData.ticker?.last || "0");
  const totalEquity = parseFloat(accountData.balance.totalEq);
  const availableEquity = parseFloat(accountData.balance.availEq);
  
  // Find primary position for analysis
  const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);

  // Prepare Candle Arrays (Close prices)
  const closes15m = marketData.candles15m.map(c => parseFloat(c.c));
  
  // Calculate Indicators
  const rsiValue = calcRSI(closes15m, 7);
  const ema20 = calcEMA(closes15m, 20);
  const ema50 = calcEMA(closes15m, 50);
  const macd = calcMACD(closes15m);
  
  // Determine Stage
  let stageName = "";
  let currentStageParams = null;
  
  if (totalEquity < 20) {
      stageName = STRATEGY_STAGES.STAGE_1.name;
      currentStageParams = STRATEGY_STAGES.STAGE_1;
  } else if (totalEquity < 80) {
      stageName = STRATEGY_STAGES.STAGE_2.name;
      currentStageParams = STRATEGY_STAGES.STAGE_2;
  } else {
      stageName = STRATEGY_STAGES.STAGE_3.name;
      currentStageParams = STRATEGY_STAGES.STAGE_3;
  }

  // Position Info
  const hasPosition = !!primaryPosition && parseFloat(primaryPosition.pos) > 0;
  const uplRatio = hasPosition ? parseFloat(primaryPosition!.uplRatio) * 100 : 0;
  
  let positionStr = "当前无持仓 (Empty)";
  if (hasPosition) {
      const p = primaryPosition!;
      positionStr = `
      持有 ${p.posSide} ${p.pos}张
      开仓均价: ${p.avgPx}
      当前未结盈亏: ${p.upl} U (${uplRatio.toFixed(2)}%)
      当前止损价 (SL): ${p.slTriggerPx || "未设置"}
      当前止盈价 (TP): ${p.tpTriggerPx || "未设置"}
      `;
  }

  // 2. Construct Prompt
  const systemPrompt = `
你是一名专注于ETH合约的 **超短线战神策略交易员** (高杠杆/极速反应/严格止损)。
你的任务是进行 **实时全网热点扫描** 并结合技术指标做出最及时的交易决策。

**当前账户状态**:
- **阶段**: ${stageName} (目标: 活下去, 积累资金)
- **可用余额**: ${availableEquity.toFixed(2)} USDT
- **当前持仓**: ${positionStr}

**核心决策指令 (CRITICAL)**:

1. **时事热点与全网扫描 (Real-time Web Search Logic)**:
   - **最高优先级**: 请模拟全网搜索，重点关注 **过去 6小时内** 发生的突发事件（如SEC监管消息、巨鲸转账、重要协议漏洞、马斯克言论等）。
     - 如果过去6小时有重大利好：即使技术面微跌，也可激进做多。
     - 如果过去6小时有重大利空：必须立即考虑做空或清仓。
   - **辅助优先级**: 回顾 **过去 24小时** 的宏观情绪变化。
   - **输出要求**: 在 'hot_events_overview' 字段中，必须列出具体的“6小时内热点”和“24小时内热点”及其对盘面的影响。

2. **超短线交易逻辑 (Scalping Logic)**:
   - **响应速度**: 市场瞬息万变，如果发现盈利回撤或趋势反转，不要犹豫，立即平仓或反手。
   - **做多 (LONG)**: 若热点偏多且价格在 EMA20 之上或 RSI 超卖反弹。
   - **做空 (SHORT)**: 若热点偏空且价格跌破 EMA20 或 RSI 超买回落。
   - **当前技术面**: 价格 ${currentPrice}, EMA20 ${ema20.toFixed(2)}, RSI ${rsiValue.toFixed(2)}。

3. **仓位管理 (Dynamic Sizing)**:
   - **动态计算**: 基于可用余额的 ${currentStageParams.risk_factor * 100}% * 置信度。
   - **最小门槛**: 开仓名义价值 (Value) 必须 > 100 USDT。如果机会一般导致仓位过小，直接 HOLD。
   - **ALL-IN 模式**: 如果是 Stage 1 且置信度 > 90% (如有重磅利好)，允许适当提高风险系数。

4. **利润保护与移动止损**:
   - 超短线交易必须快速止盈。
   - 收益 > 10%: 考虑上移止损至保本。
   - 收益 > 20%: 必须执行移动止损。
   - 操作指令: 返回 Action: **UPDATE_TPSL** 来调整当前持仓的保护价。

**实时数据**:
- 现价: ${currentPrice.toFixed(2)}
- 资金费率: ${marketData.fundingRate}

**技术指标 (15m)**:
- RSI(7): ${rsiValue.toFixed(2)}
- EMA20: ${ema20.toFixed(2)}
- MACD: ${macd.macd.toFixed(4)}

请生成纯净的 JSON 格式交易决策。
`;

  const responseSchema = `
  {
    "stage_analysis": "简述阶段策略...",
    "hot_events_overview": "【6小时热点】... 【24小时热点】...",
    "market_assessment": "多空趋势判断 (Bullish/Bearish)...",
    "eth_analysis": "技术面及逻辑分析...", 
    "trading_decision": {
      "action": "BUY|SELL|HOLD|CLOSE|UPDATE_TPSL",
      "confidence": "0-100%",
      "position_size": "动态计算",
      "leverage": "${currentStageParams.leverage}",
      "profit_target": "价格",
      "stop_loss": "价格",
      "invalidation_condition": "失效条件"
    },
    "reasoning": "决策理由"
  }
  `;

  try {
    const text = await callDeepSeek(apiKey, [
        { role: "system", content: systemPrompt + "\n请严格按照以下 JSON 格式输出，不要包含 Markdown 标记:\n" + responseSchema },
        { role: "user", content: "现在开始全网扫描，并给出基于最新热点的交易决策。" }
    ]);

    if (!text) throw new Error("AI 返回为空");

    // Parse JSON (Handle potential markdown wrappers from generic LLMs)
    let decision: AIDecision;
    try {
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        decision = JSON.parse(cleanText);
    } catch (e) {
        console.error("JSON Parse Failed:", text);
        throw new Error("AI 返回格式错误 (无法解析 JSON)");
    }

    // --- Post-Processing & Validation ---
    
    // 1. Normalize Action
    decision.action = decision.trading_decision.action.toUpperCase() as any;
    
    // 2. Parse basic fields
    const leverage = parseFloat(decision.trading_decision.leverage);
    const confidence = parseFloat(decision.trading_decision.confidence) || 50;
    const safeLeverage = isNaN(leverage) ? currentStageParams.leverage : leverage;
    
    // 3. Robust Sizing Logic (Fix for 51008 Insufficient Balance & Min Size)
    // 无论 AI 返回什么 size，我们都基于代码逻辑重新计算安全值。
    
    // Step A: 计算目标保证金 (Target Margin)
    // 逻辑: 可用余额 * 阶段风险系数 * 置信度
    let targetMargin = availableEquity * currentStageParams.risk_factor * (confidence / 100);
    
    // Step B: 安全缓冲 (Safety Buffer)
    // 预留 10% 余额用于防止滑点和手续费
    const maxSafeMargin = availableEquity * 0.90;
    
    // 取最小值
    let finalMargin = Math.min(targetMargin, maxSafeMargin);

    // Step C: 最小开仓价值检查 (Min Notional Value Check)
    // 设定最小名义价值为 100 USDT，防止仓位过小无法覆盖手续费
    const MIN_OPEN_VALUE = 100;
    let positionValue = finalMargin * safeLeverage;

    // 如果计算出的价值小于 100 U，但账户余额允许开更大的仓位（且置信度足够），尝试放大到 100 U
    if (positionValue < MIN_OPEN_VALUE && availableEquity * 0.9 * safeLeverage > MIN_OPEN_VALUE) {
        // 如果置信度还可以 (>40%)，则勉强提升到最小门槛
        if (confidence >= 40) {
             finalMargin = MIN_OPEN_VALUE / safeLeverage;
             positionValue = MIN_OPEN_VALUE;
             console.log(`[AI] 仓位自动修正: 提升至最小名义价值 ${MIN_OPEN_VALUE} USDT`);
        }
    }

    // 4. Calculate Contract Size
    if (decision.action === 'BUY' || decision.action === 'SELL') {
        
        // 最终检查: 如果价值仍低于最小门槛，强制取消开单
        if (positionValue < MIN_OPEN_VALUE) {
             console.warn(`[AI] 计算出的仓位价值 (${positionValue.toFixed(2)} U) 低于最小门槛 (${MIN_OPEN_VALUE} U)，且不满足提升条件。转为 HOLD。`);
             decision.action = 'HOLD';
             decision.size = "0";
             decision.reasoning += ` [系统修正: 仓位价值 ${positionValue.toFixed(2)}U 过小，不足以支付手续费或满足交易所限制，已取消]`;
        } else {
            // Contracts = Value / (Price * ContractVal)
            const numContractsRaw = positionValue / (CONTRACT_VAL_ETH * currentPrice);
            
            // 使用 floor 向下取整到 2 位小数 (部分币种要求整数，这里保留2位兼容性较好，配合Min Value检查通常没问题)
            const numContracts = Math.floor(numContractsRaw * 100) / 100;
            
            // Double Check Contracts
            if (numContracts < 0.01) {
                decision.action = 'HOLD';
                decision.size = "0";
                decision.reasoning += " [系统修正: 合约数量不足 0.01 张]";
            } else {
                decision.size = numContracts.toFixed(2);
                decision.leverage = safeLeverage.toString();
                console.log(`[AI Sizing] Avail: ${availableEquity}, Margin: ${finalMargin.toFixed(2)}, Lev: ${safeLeverage}, Value: ${positionValue.toFixed(2)}, Contracts: ${decision.size}`);
            }
        }
    } else {
        decision.size = "0";
        decision.leverage = safeLeverage.toString();
    }

    return decision;

  } catch (error: any) {
    console.error("AI Decision Error:", error);
    return {
        stage_analysis: "AI Error",
        market_assessment: "Unknown",
        hot_events_overview: "N/A",
        eth_analysis: "N/A",
        trading_decision: {
            action: 'hold' as any,
            confidence: "0%",
            position_size: "0",
            leverage: "0",
            profit_target: "0",
            stop_loss: "0",
            invalidation_condition: "Error"
        },
        reasoning: "System Error: " + error.message,
        action: 'HOLD',
        size: "0",
        leverage: "0"
    };
  }
};
