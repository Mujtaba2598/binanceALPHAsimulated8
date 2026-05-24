const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = 'halal-unlimited-bot-secret-key-2024';
const ENCRYPTION_KEY = '12345678901234567890123456789012';

const HALAL_ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT', 'XRPUSDT', 'DOTUSDT', 'LINKUSDT', 'MATICUSDT', 'AVAXUSDT'];

// Trading settings
const TRADE_CHECK_INTERVAL_MS = 500;  // Check every 0.5 seconds
const MIN_TRADE_SIZE = 10;            // Minimum $10 per trade

let simulatedBalances = {};

// ========== DATA DIRECTORIES ==========
const DATA_DIR = path.join(__dirname, 'data');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TRADES_DIR)) fs.mkdirSync(TRADES_DIR, { recursive: true });

// ========== OWNER ACCOUNT ==========
const ownerEmail = "mujtabahatif@gmail.com";
const ownerPasswordPlain = "Mujtabah@2598";
const ownerPasswordHash = bcrypt.hashSync(ownerPasswordPlain, 10);

let users = {};
if (fs.existsSync(USERS_FILE)) {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e) { users = {}; }
}

users[ownerEmail] = {
    email: ownerEmail,
    password: ownerPasswordHash,
    isOwner: true,
    isApproved: true,
    isBlocked: false,
    apiKey: "",
    secretKey: "",
    accountType: "simulated",
    createdAt: new Date().toISOString()
};
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log("✅ Owner account created");

if (!fs.existsSync(PENDING_FILE)) fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({}, null, 2));

// ========== HELPER FUNCTIONS ==========
function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE)); } catch(e) { return {}; } }
function writeUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }
function readPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE)); } catch(e) { return {}; } }
function writePending(data) { fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2)); }

function encrypt(text) {
    if (!text) return "";
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decrypt(text) {
    if (!text) return "";
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = parts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: '🕋 Unlimited Halal Bot - No Fixed Profit %' });
});

// ========== AUTHENTICATION ==========
app.post('/api/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    
    const users = readUsers();
    if (users[email]) return res.status(400).json({ success: false, message: 'User already exists' });
    const pending = readPending();
    if (pending[email]) return res.status(400).json({ success: false, message: 'Request already pending' });
    
    pending[email] = { email, password: bcrypt.hashSync(password, 10), requestedAt: new Date().toISOString() };
    writePending(pending);
    res.json({ success: true, message: 'Registration request sent to owner for approval.' });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const users = readUsers();
    const user = users[email];
    
    if (!user) {
        const pending = readPending();
        if (pending[email]) return res.status(401).json({ success: false, message: 'Pending owner approval' });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isApproved && !user.isOwner) return res.status(401).json({ success: false, message: 'Account not approved' });
    if (user.isBlocked) return res.status(401).json({ success: false, message: 'Account blocked' });
    
    const token = jwt.sign({ email, isOwner: user.isOwner }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, isOwner: user.isOwner });
});

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

// ========== REAL BINANCE MARKET DATA ==========
const BINANCE_API = 'https://api.binance.com';

async function getBinanceOrderBook(symbol) {
    try {
        const response = await axios.get(`${BINANCE_API}/api/v3/depth?symbol=${symbol}&limit=5`);
        return {
            bids: response.data.bids.map(b => parseFloat(b[0])),
            asks: response.data.asks.map(a => parseFloat(a[0]))
        };
    } catch (error) {
        return { bids: [50000], asks: [50001] };
    }
}

function getSimulatedBalance(email) {
    if (!simulatedBalances[email]) simulatedBalances[email] = 10000;
    return simulatedBalances[email];
}

function updateSimulatedBalance(email, newBalance) {
    simulatedBalances[email] = newBalance;
}

// ========== SIMULATED API ==========
app.post('/api/set-simulated-keys', authenticate, async (req, res) => {
    const users = readUsers();
    users[req.user.email].apiKey = "simulated_mode";
    users[req.user.email].secretKey = "simulated_mode";
    users[req.user.email].accountType = "simulated";
    writeUsers(users);
    const balance = getSimulatedBalance(req.user.email);
    res.json({ success: true, message: `✅ Simulated mode activated! Balance: $${balance.toFixed(2)}`, balance: balance });
});

app.post('/api/connect-simulated', authenticate, async (req, res) => {
    const balance = getSimulatedBalance(req.user.email);
    res.json({ success: true, balance: balance, message: `✅ Connected! Balance: $${balance.toFixed(2)}` });
});

app.get('/api/get-keys', authenticate, (req, res) => {
    const user = readUsers()[req.user.email];
    res.json({ 
        success: true, 
        apiKey: user?.apiKey === "simulated_mode" ? "" : (user?.apiKey ? decrypt(user.apiKey) : ""),
        secretKey: user?.secretKey === "simulated_mode" ? "" : (user?.secretKey ? decrypt(user.secretKey) : ""),
        accountType: user?.accountType || 'simulated' 
    });
});

app.post('/api/get-balance', authenticate, async (req, res) => {
    const balance = getSimulatedBalance(req.user.email);
    res.json({ success: true, balance: balance });
});

// ========== UNLIMITED CONCURRENT TRADES ENGINE - NO FIXED PROFIT % ==========
const activeSessions = new Map();
let assetIndex = 0;

function nextAsset() {
    const asset = HALAL_ASSETS[assetIndex];
    assetIndex = (assetIndex + 1) % HALAL_ASSETS.length;
    return asset;
}

app.post('/api/start-trading', authenticate, async (req, res) => {
    try {
        const { investmentAmount, targetAmount, timeLimitHours } = req.body;
        
        if (!investmentAmount || investmentAmount < 10) {
            return res.status(400).json({ success: false, message: 'Minimum investment $10' });
        }
        if (!targetAmount || targetAmount <= investmentAmount) {
            return res.status(400).json({ success: false, message: 'Target must be greater than investment' });
        }
        
        const balance = getSimulatedBalance(req.user.email);
        if (balance < investmentAmount) {
            return res.status(400).json({ success: false, message: `Insufficient balance. You have $${balance}, need $${investmentAmount}` });
        }
        
        const sessionId = crypto.randomBytes(8).toString('hex');
        
        const sessionData = {
            userId: req.user.email,
            initialInvestment: investmentAmount,
            targetAmount: targetAmount,
            currentBalance: investmentAmount,
            totalProfit: 0,
            startTime: Date.now(),
            timeLimit: timeLimitHours || 1,
            activeTrades: [],
            completedTrades: [],
            status: 'ACTIVE',
            tradeCount: 0
        };
        
        activeSessions.set(sessionId, sessionData);
        startUnlimitedTrading(sessionId);
        
        const profitNeeded = targetAmount - investmentAmount;
        const requiredReturn = ((targetAmount / investmentAmount) - 1) * 100;
        
        res.json({
            success: true,
            sessionId,
            message: `✅ UNLIMITED TRADING STARTED (NO FIXED PROFIT %)\n💰 Investment: $${investmentAmount}\n🎯 Target: $${targetAmount}\n⏰ Time Limit: ${timeLimitHours || 1} hours\n\n⚡ Bot captures market spread (bid-ask difference) for maximum profit!\n🔄 Auto-compounding: ON\n📈 Profit per trade = market spread (typically 0.01%-0.05%)\n🚀 UNLIMITED concurrent trades - scales with your balance!`
        });
    } catch (error) {
        console.error('Start trading error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

async function startUnlimitedTrading(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.status !== 'ACTIVE') return;
    
    // Check if target reached
    if (session.currentBalance >= session.targetAmount) {
        session.status = 'TARGET_REACHED';
        updateSimulatedBalance(session.userId, session.currentBalance);
        activeSessions.delete(sessionId);
        console.log(`🎯 TARGET REACHED! Final balance: $${session.currentBalance.toFixed(2)} from $${session.initialInvestment}`);
        console.log(`📊 Total trades: ${session.tradeCount}, Total profit: $${session.totalProfit.toFixed(2)}`);
        return;
    }
    
    // Check time limit
    const elapsedHours = (Date.now() - session.startTime) / (1000 * 60 * 60);
    if (elapsedHours >= session.timeLimit) {
        session.status = 'TIME_LIMIT_REACHED';
        updateSimulatedBalance(session.userId, session.currentBalance);
        activeSessions.delete(sessionId);
        console.log(`⏰ Time limit reached. Final balance: $${session.currentBalance.toFixed(2)}`);
        return;
    }
    
    // Process existing trades - CLOSE INSTANTLY using market spread
    for (let i = 0; i < session.activeTrades.length; i++) {
        const trade = session.activeTrades[i];
        
        if (trade.status === 'BUY_ORDER_PLACED') {
            // Buy fills instantly at bid price
            trade.status = 'BUY_FILLED';
            trade.fillPrice = trade.buyPrice;
            trade.filledQuantity = trade.quantity;
            
            // Sell at ask price (capture the spread)
            const orderBook = await getBinanceOrderBook(trade.symbol);
            const askPrice = orderBook.asks[0];
            trade.sellPrice = askPrice;
            trade.status = 'SELL_ORDER_PLACED';
        }
        
        if (trade.status === 'SELL_ORDER_PLACED') {
            // Sell fills instantly - profit realized from spread
            const profit = (trade.sellPrice - trade.fillPrice) * trade.filledQuantity;
            const profitPercent = (profit / trade.investedAmount) * 100;
            session.currentBalance += profit;
            session.totalProfit += profit;
            session.tradeCount++;
            trade.status = 'COMPLETED';
            trade.profit = profit;
            session.completedTrades.push(trade);
            
            console.log(`✅ Trade #${session.tradeCount} | Profit: $${profit.toFixed(4)} (${profitPercent.toFixed(4)}%) | Balance: $${session.currentBalance.toFixed(2)} | Target: $${session.targetAmount}`);
            
            // Save to history
            const historyFile = path.join(TRADES_DIR, session.userId.replace(/[^a-z0-9]/gi, '_') + '.json');
            let history = [];
            if (fs.existsSync(historyFile)) history = JSON.parse(fs.readFileSync(historyFile));
            history.unshift({
                tradeNumber: session.tradeCount,
                symbol: trade.symbol,
                entryPrice: trade.fillPrice,
                exitPrice: trade.sellPrice,
                quantity: trade.filledQuantity,
                investment: trade.investedAmount,
                profit: profit,
                profitPercent: profitPercent.toFixed(4),
                spread: ((trade.sellPrice - trade.fillPrice) / trade.fillPrice * 100).toFixed(4),
                balanceAfter: session.currentBalance,
                timestamp: new Date().toISOString(),
                isHalal: true
            });
            fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 500), null, 2));
            
            session.activeTrades.splice(i, 1);
            i--;
            updateSimulatedBalance(session.userId, session.currentBalance);
        }
    }
    
    // Check target again after processing
    if (session.currentBalance >= session.targetAmount) {
        session.status = 'TARGET_REACHED';
        updateSimulatedBalance(session.userId, session.currentBalance);
        activeSessions.delete(sessionId);
        return;
    }
    
    // Calculate UNLIMITED concurrent trades - use ALL available balance
    const tradeSizePercent = 10; // Use 10% of balance per trade
    let tradeSize = session.currentBalance * (tradeSizePercent / 100);
    tradeSize = Math.max(MIN_TRADE_SIZE, Math.min(tradeSize, session.currentBalance));
    
    // Calculate how many trades we can place (UNLIMITED - limited only by balance)
    let maxPossibleTrades = Math.floor(session.currentBalance / tradeSize);
    let tradesToPlace = maxPossibleTrades;
    
    // Cap at 200 for performance (effectively unlimited for most users)
    if (tradesToPlace > 200) tradesToPlace = 200;
    
    // Place new trades
    let newTradesPlaced = 0;
    for (let i = 0; i < tradesToPlace; i++) {
        if (session.currentBalance < tradeSize) break;
        
        const symbol = nextAsset();
        const orderBook = await getBinanceOrderBook(symbol);
        const bidPrice = orderBook.bids[0];
        const askPrice = orderBook.asks[0];
        
        if (!bidPrice || !askPrice) continue;
        
        const quantity = tradeSize / bidPrice;
        
        let roundedQty = Math.floor(quantity * 10000) / 10000;
        if (symbol === 'BTCUSDT') roundedQty = Math.floor(quantity * 100000) / 100000;
        if (roundedQty < 0.00001) continue;
        
        session.currentBalance -= tradeSize;
        
        const spreadPercent = ((askPrice - bidPrice) / bidPrice) * 100;
        
        session.activeTrades.push({
            symbol: symbol,
            quantity: roundedQty,
            buyPrice: bidPrice,
            sellPrice: askPrice,
            buyOrderId: Date.now() + i,
            status: 'BUY_ORDER_PLACED',
            createdAt: Date.now(),
            investedAmount: tradeSize
        });
        newTradesPlaced++;
        
        console.log(`📈 New order #${newTradesPlaced}: $${tradeSize.toFixed(2)} → ${roundedQty} ${symbol} at bid $${bidPrice.toFixed(2)} | Sell at ask $${askPrice.toFixed(2)} (spread ${spreadPercent.toFixed(4)}%) | Active trades: ${session.activeTrades.length}`);
    }
    
    if (newTradesPlaced > 0) {
        console.log(`📊 Placed ${newTradesPlaced} new orders. Total active: ${session.activeTrades.length} | Remaining: $${session.currentBalance.toFixed(2)} | Progress: ${((session.currentBalance - session.initialInvestment) / (session.targetAmount - session.initialInvestment) * 100).toFixed(1)}%`);
    }
    
    // Run next cycle very quickly for maximum speed
    setTimeout(() => startUnlimitedTrading(sessionId), TRADE_CHECK_INTERVAL_MS);
}

app.post('/api/stop-trading', authenticate, (req, res) => {
    const { sessionId } = req.body;
    if (activeSessions.has(sessionId)) {
        activeSessions.delete(sessionId);
        res.json({ success: true, message: 'Trading stopped' });
    } else {
        res.json({ success: false, message: 'Session not found' });
    }
});

app.post('/api/trade-status', authenticate, (req, res) => {
    const session = activeSessions.get(req.body.sessionId);
    if (!session) return res.json({ success: true, active: false });
    
    const elapsedHours = (Date.now() - session.startTime) / (1000 * 60 * 60);
    const timeRemaining = Math.max(0, session.timeLimit - elapsedHours);
    const progressPercent = ((session.currentBalance - session.initialInvestment) / (session.targetAmount - session.initialInvestment)) * 100;
    
    res.json({
        success: true,
        active: session.status === 'ACTIVE',
        initialInvestment: session.initialInvestment,
        targetAmount: session.targetAmount,
        currentBalance: session.currentBalance,
        totalProfit: session.totalProfit,
        progressPercent: Math.min(100, Math.max(0, progressPercent)).toFixed(1),
        totalTrades: session.tradeCount,
        activeTrades: session.activeTrades.length,
        completedTrades: session.completedTrades.length,
        timeRemaining: timeRemaining.toFixed(2),
        status: session.status
    });
});

app.get('/api/trade-history', authenticate, (req, res) => {
    const file = path.join(TRADES_DIR, req.user.email.replace(/[^a-z0-9]/gi, '_') + '.json');
    if (!fs.existsSync(file)) return res.json({ success: true, trades: [] });
    const trades = JSON.parse(fs.readFileSync(file));
    res.json({ success: true, trades: trades });
});

app.get('/api/halal-assets', authenticate, (req, res) => {
    res.json({ success: true, assets: HALAL_ASSETS });
});

// ========== ADMIN ENDPOINTS ==========
app.get('/api/admin/pending-users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const pending = readPending();
    res.json({ success: true, pending: Object.keys(pending).map(e => ({ email: e, requestedAt: pending[e].requestedAt })) });
});

app.post('/api/admin/approve-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    const users = readUsers();
    users[email] = {
        email, password: pending[email].password, isOwner: false, isApproved: true,
        isBlocked: false, apiKey: "", secretKey: "", createdAt: new Date().toISOString()
    };
    writeUsers(users);
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `User ${email} approved` });
});

app.post('/api/admin/reject-user', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const pending = readPending();
    if (!pending[email]) return res.status(404).json({ success: false });
    delete pending[email];
    writePending(pending);
    res.json({ success: true, message: `User ${email} rejected` });
});

app.post('/api/admin/toggle-block', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { email } = req.body;
    const users = readUsers();
    if (!users[email]) return res.status(404).json({ success: false });
    users[email].isBlocked = !users[email].isBlocked;
    writeUsers(users);
    res.json({ success: true, message: `User ${email} is now ${users[email].isBlocked ? 'BLOCKED' : 'ACTIVE'}` });
});

app.get('/api/admin/users', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const users = readUsers();
    res.json({ success: true, users: Object.keys(users).map(e => ({
        email: e, hasApiKeys: !!users[e].apiKey, isOwner: users[e].isOwner,
        isApproved: users[e].isApproved, isBlocked: users[e].isBlocked
    })) });
});

app.get('/api/admin/user-balances', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const users = readUsers();
    const balances = {};
    for (const [email, u] of Object.entries(users)) {
        balances[email] = { balance: getSimulatedBalance(email), hasKeys: true };
    }
    res.json({ success: true, balances });
});

app.get('/api/admin/all-trades', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const allTrades = {};
    const files = fs.readdirSync(TRADES_DIR);
    for (const file of files) {
        if (file === '.gitkeep') continue;
        const userId = file.replace('.json', '');
        allTrades[userId] = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, file)));
    }
    res.json({ success: true, trades: allTrades });
});

app.post('/api/change-password', authenticate, (req, res) => {
    if (!req.user.isOwner) return res.status(403).json({ success: false });
    const { currentPassword, newPassword } = req.body;
    const users = readUsers();
    const owner = users[req.user.email];
    if (!bcrypt.compareSync(currentPassword, owner.password)) return res.status(401).json({ success: false, message: 'Wrong current password' });
    owner.password = bcrypt.hashSync(newPassword, 10);
    writeUsers(users);
    res.json({ success: true, message: 'Password changed! Please login again.' });
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`🕋 UNLIMITED HALAL BOT - NO FIXED PROFIT %`);
    console.log(`========================================`);
    console.log(`✅ Owner: ${ownerEmail}`);
    console.log(`✅ Password: ${ownerPasswordPlain}`);
    console.log(`✅ ${HALAL_ASSETS.length} Halal Assets`);
    console.log(`✅ NO fixed profit % - captures market spread`);
    console.log(`✅ UNLIMITED concurrent trades`);
    console.log(`✅ Auto-compounding: ON`);
    console.log(`========================================`);
    console.log(`Server on port: ${PORT}`);
});
