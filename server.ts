import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { MarketDataCollection, AccountContext, AIDecision, SystemLog, AppConfig } from './types';
import { DEFAULT_CONFIG, INSTRUMENT_ID } from './constants';
import * as okxService from './services/okxService';
import * as aiService from './services/aiService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors() as any);
app.use(express.json() as any);
app.use(express.static(path.join(__dirname, 'dist')) as any);

// --- Server State ---
let config: AppConfig = { ...DEFAULT_CONFIG };
let isRunning = false;
let marketData: MarketDataCollection | null = null;
let accountData: AccountContext | null = null;
let latestDecision: AIDecision | null = null;
let logs: SystemLog[] = [];
let lastAnalysisTime = 0;

// Helper to add logs
const addLog = (type: SystemLog['type'], message: string) => {
  const log: SystemLog = { 
      id: Date.now().toString() + Math.random(), 
      timestamp: new Date(), 
      type, 
      message 
  };
  logs.push(log);
  // Keep last 200 logs to prevent memory overflow
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(`[${type}] ${message}`);
};

// --- Background Trading Loop ---
const runTradingLoop = async () => {
    // 1. Fetch Data
    try {
        marketData = await okxService.fetchMarketData(config);
        accountData = await okxService.fetchAccountData(config);
    } catch (e: any) {
        if (isRunning) addLog('ERROR', `数据同步失败: ${e.message}`);
        return;
    }

    if (!isRunning) return;

    // 2. AI Analysis Logic
    const now = Date.now();
    // Analyze every 15 seconds (High Frequency for Ultra-Short Term)
    if (now - lastAnalysisTime < 15000) return;

    setTimeout(async () => {
        try {
            lastAnalysisTime = now;
            addLog('INFO', '正在调用云端战神引擎 (超短线模式)...');
            
            if (!marketData || !accountData) return;

            const decision = await aiService.getTradingDecision(config.deepseekApiKey, marketData, accountData);
            latestDecision = decision;
            
            const conf = decision.trading_decision?.confidence || "0%";
            addLog('INFO', `[${decision.stage_analysis.substring(0, 10)}..] 决策: ${decision.action} (置信度 ${conf})`);

            // Find main position for management
            const primaryPosition = accountData.positions.find(p => p.instId === INSTRUMENT_ID);

            // Execute Actions
            if (decision.action === 'UPDATE_TPSL') {
                 if (primaryPosition) {
                    const newSL = decision.trading_decision.stop_loss;
                    const newTP = decision.trading_decision.profit_target;
                    
                    // Robust check: handles string "3000", number 3000, but fails on "0", "", undefined
                    const isValid = (p: string | number | undefined) => {
                        if (p === undefined || p === null || p === '') return false;
                        const val = parseFloat(p.toString());
                        return !isNaN(val) && val > 0;
                    };
                    
                    if (isValid(newSL) || isValid(newTP)) {
                        if (primaryPosition.posSide === 'net') {
                             addLog('WARNING', '单向持仓模式不支持自动更新止损/止盈');
                        } else {
                            try {
                                const res = await okxService.updatePositionTPSL(
                                    INSTRUMENT_ID, 
                                    primaryPosition.posSide, 
                                    primaryPosition.pos, 
                                    isValid(newSL) ? newSL.toString() : undefined,
                                    isValid(newTP) ? newTP.toString() : undefined,
                                    config
                                );
                                addLog('SUCCESS', `云端止损更新: ${res.msg}`);
                            } catch(err: any) {
                                addLog('ERROR', `更新止损失败: ${err.message}`);
                            }
                        }
                    }
                 }
            } else if (decision.action !== 'HOLD') {
                try {
                    const res = await okxService.executeOrder(decision, config);
                    addLog('TRADE', `执行订单: ${decision.action} ${decision.size} 张. 结果: ${res.msg}`);
                } catch(err: any) {
                    addLog('ERROR', `订单执行失败: ${err.message}`);
                }
            }

            // Rolling Logic
            if (decision.action === 'HOLD' && primaryPosition) {
                const uplRatio = parseFloat(primaryPosition.uplRatio) * 100;
                if (uplRatio >= 50) {
                     addLog('SUCCESS', `触发自动滚仓: 收益率 ${uplRatio.toFixed(2)}%`);
                     try {
                         await okxService.addMargin({
                            instId: INSTRUMENT_ID,
                            posSide: primaryPosition.posSide,
                            type: 'add',
                            amt: (parseFloat(primaryPosition.upl) * 0.5).toFixed(2)
                         }, config);
                         addLog('TRADE', '滚仓成功');
                     } catch(e: any) {
                         addLog('ERROR', `滚仓失败: ${e.message}`);
                     }
                }
            }

        } catch (e: any) {
            addLog('ERROR', `策略执行异常: ${e.message}`);
        }
    }, 0);
};

// Start Loop
setInterval(runTradingLoop, 5000);

// --- API Endpoints ---

app.get('/api/status', (req, res) => {
    res.json({
        isRunning,
        config: { ...config, okxSecretKey: '***', okxPassphrase: '***', deepseekApiKey: '***' }, 
        marketData,
        accountData,
        latestDecision,
        logs
    });
});

app.post('/api/config', (req, res) => {
    const newConfig = req.body;
    config = {
        ...config,
        ...newConfig,
        okxSecretKey: newConfig.okxSecretKey === '***' ? config.okxSecretKey : newConfig.okxSecretKey,
        okxPassphrase: newConfig.okxPassphrase === '***' ? config.okxPassphrase : newConfig.okxPassphrase,
        deepseekApiKey: newConfig.deepseekApiKey === '***' ? config.deepseekApiKey : newConfig.deepseekApiKey,
    };
    addLog('INFO', '配置已通过 Web 更新');
    res.json({ success: true });
});

app.post('/api/toggle', (req, res) => {
    const { running } = req.body;
    isRunning = running;
    addLog('INFO', isRunning ? '>>> 策略引擎已启动 <<<' : '>>> 策略引擎已暂停 <<<');
    res.json({ success: true, isRunning });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    addLog('INFO', `系统初始化完成，等待指令...`);
});
