const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const express = require('express');
const { simpleParser } = require('mailparser');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Email settings
  EMAIL_TO: 'tim.norman@gmail.com',
  EMAIL_FROM: 'tim.norman@gmail.com',
  EMAIL_PASSWORD: 'amkpxyixfannzowl',
  
  // API Keys (FREE)
  SEC_API_KEY: '5c1704699394f4fb362f2d274503d9dcd999be9f87d9da27896dc8ee8bec08bc',
  WHALE_ALERT_API_KEY: '',
  
  // Signal thresholds
  NUCLEAR_BUY_CONFIDENCE: 85,
  NUCLEAR_SELL_CONFIDENCE: 85,
  MIN_SOURCES: 2,
  
  // Sell strategy
  PROFIT_TARGET: 15,
  MAX_HOLD_DAYS: 60,
  STOP_LOSS: -8,
  
  // Timing
  SCAN_INTERVAL_MINUTES: 30,
  WEEKLY_SUMMARY_DAY: 0,
  
  // Web interface
  WEB_PORT: 3000,
  
  // Files
  PORTFOLIO_FILE: './portfolio.json'
};

// ============================================
// WEB INTERFACE
// ============================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve portfolio management page
app.get('/', async (req, res) => {
  const portfolio = await loadPortfolio();
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Nuclear Insider Detector</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header {
      background: rgba(255,255,255,0.95);
      padding: 30px;
      border-radius: 16px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    .header h1 { font-size: 32px; color: #1a1a1a; margin-bottom: 5px; }
    .header p { color: #666; font-size: 14px; }
    
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: rgba(255,255,255,0.95);
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .stat-label { font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
    .stat-value { font-size: 36px; font-weight: bold; margin: 10px 0; }
    .stat-value.positive { color: #10b981; }
    .stat-value.negative { color: #ef4444; }
    
    .section {
      background: rgba(255,255,255,0.95);
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .section h2 { font-size: 20px; margin-bottom: 20px; color: #1a1a1a; }
    
    .form-group {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr auto;
      gap: 15px;
      margin-bottom: 15px;
    }
    input, button {
      padding: 12px 20px;
      border-radius: 8px;
      border: 2px solid #e5e7eb;
      font-size: 16px;
      font-family: inherit;
    }
    input:focus { outline: none; border-color: #667eea; }
    button {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      border: none;
      font-weight: bold;
      cursor: pointer;
      transition: transform 0.2s;
    }
    button:hover { transform: translateY(-2px); }
    button:active { transform: translateY(0); }
    
    .position {
      background: #f9fafb;
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 15px;
      border-left: 5px solid #667eea;
    }
    .position.winning { border-left-color: #10b981; }
    .position.losing { border-left-color: #ef4444; }
    
    .position-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .ticker { font-size: 24px; font-weight: bold; color: #1a1a1a; }
    .pnl { font-size: 24px; font-weight: bold; }
    .pnl.positive { color: #10b981; }
    .pnl.negative { color: #ef4444; }
    
    .position-details {
      font-size: 14px;
      color: #666;
      margin-top: 10px;
    }
    .position-details span { margin-right: 15px; }
    
    .btn-sell {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      padding: 8px 20px;
      font-size: 14px;
      margin-top: 10px;
    }
    
    .empty {
      text-align: center;
      padding: 40px;
      color: #666;
      font-size: 16px;
    }
    
    @media (max-width: 768px) {
      .stats { grid-template-columns: 1fr; }
      .form-group { 
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚨 Nuclear Insider Detector</h1>
      <p>Portfolio Tracking & Trade Management</p>
    </div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Unrealized P&L</div>
        <div class="stat-value ${portfolio.positions.reduce((s,p) => s + p.unrealizedPnL, 0) >= 0 ? 'positive' : 'negative'}">
          ${portfolio.positions.reduce((s,p) => s + p.unrealizedPnL, 0) >= 0 ? '+' : ''}$${portfolio.positions.reduce((s,p) => s + p.unrealizedPnL, 0).toFixed(2)}
        </div>
        <div style="font-size: 14px; color: #666;">
          ${(portfolio.positions.reduce((s,p) => s + p.unrealizedPnLPercent, 0) / (portfolio.positions.length || 1)).toFixed(1)}% average
        </div>
      </div>
      
      <div class="stat-card">
        <div class="stat-label">Realized P&L</div>
        <div class="stat-value ${portfolio.history.filter(h => h.type === 'SELL').reduce((s,t) => s + (t.profit || 0), 0) >= 0 ? 'positive' : 'negative'}">
          ${portfolio.history.filter(h => h.type === 'SELL').reduce((s,t) => s + (t.profit || 0), 0) >= 0 ? '+' : ''}$${portfolio.history.filter(h => h.type === 'SELL').reduce((s,t) => s + (t.profit || 0), 0).toFixed(2)}
        </div>
        <div style="font-size: 14px; color: #666;">
          ${portfolio.history.filter(h => h.type === 'SELL').length} closed trades
        </div>
      </div>
    </div>
    
    <div class="section">
      <h2>📝 Record New Trade</h2>
      <form id="buyForm" class="form-group">
        <input type="text" id="buyTicker" placeholder="Ticker (e.g., NVDA)" required>
        <input type="number" id="buyPrice" placeholder="Buy Price" step="0.01" required>
        <input type="number" id="buyUnits" placeholder="Units" step="0.01" value="1">
        <button type="submit">Buy</button>
      </form>
      
      <form id="sellForm" class="form-group">
        <input type="text" id="sellTicker" placeholder="Ticker (e.g., NVDA)" required>
        <input type="number" id="sellPrice" placeholder="Sell Price" step="0.01" required>
        <input type="number" id="sellUnits" placeholder="Units" step="0.01" value="1">
        <button type="submit" style="background: linear-gradient(135deg, #ef4444, #dc2626);">Sell</button>
      </form>
    </div>
    
    <div class="section">
      <h2>💼 Open Positions (${portfolio.positions.length})</h2>
      ${portfolio.positions.length === 0 ? '<div class="empty">No open positions. Start by recording a buy above!</div>' : ''}
      ${portfolio.positions.map(pos => `
        <div class="position ${pos.unrealizedPnLPercent > 0 ? 'winning' : 'losing'}">
          <div class="position-header">
            <div class="ticker">${pos.ticker}</div>
            <div class="pnl ${pos.unrealizedPnLPercent >= 0 ? 'positive' : 'negative'}">
              ${pos.unrealizedPnLPercent >= 0 ? '+' : ''}${pos.unrealizedPnLPercent.toFixed(1)}%
            </div>
          </div>
          <div class="position-details">
            <span><strong>Buy:</strong> $${pos.buyPrice.toFixed(2)}</span>
            <span><strong>Current:</strong> $${pos.currentPrice.toFixed(2)}</span>
            <span><strong>P&L:</strong> $${pos.unrealizedPnL.toFixed(2)}</span>
            <span><strong>Held:</strong> ${pos.daysHeld} days</span>
          </div>
          <button class="btn-sell" onclick="quickSell('${pos.ticker}', ${pos.currentPrice})">
            Quick Sell @ $${pos.currentPrice.toFixed(2)}
          </button>
        </div>
      `).join('')}
    </div>
    
    ${portfolio.history.filter(h => h.type === 'SELL').length > 0 ? `
    <div class="section">
      <h2>📊 Recent Closed Trades</h2>
      ${portfolio.history.filter(h => h.type === 'SELL').slice(-5).reverse().map(trade => `
        <div class="position ${trade.profitPercent > 0 ? 'winning' : 'losing'}">
          <div class="position-header">
            <div class="ticker">${trade.ticker}</div>
            <div class="pnl ${trade.profitPercent >= 0 ? 'positive' : 'negative'}">
              ${trade.profitPercent >= 0 ? '+' : ''}${trade.profitPercent.toFixed(1)}%
            </div>
          </div>
          <div class="position-details">
            <span><strong>${trade.profitPercent >= 0 ? 'Profit' : 'Loss'}:</strong> $${Math.abs(trade.profit).toFixed(2)}</span>
            <span><strong>Held:</strong> ${trade.daysHeld} days</span>
            <span><strong>Sold:</strong> ${new Date(trade.sellDate).toLocaleDateString()}</span>
          </div>
        </div>
      `).join('')}
    </div>
    ` : ''}
  </div>
  
  <script>
    document.getElementById('buyForm').onsubmit = async (e) => {
      e.preventDefault();
      const ticker = document.getElementById('buyTicker').value.toUpperCase();
      const price = parseFloat(document.getElementById('buyPrice').value);
      const units = parseFloat(document.getElementById('buyUnits').value);
      
      const res = await fetch('/api/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, price, units })
      });
      
      if (res.ok) {
        alert('✅ Buy recorded!');
        location.reload();
      } else {
        alert('❌ Error recording buy');
      }
    };
    
    document.getElementById('sellForm').onsubmit = async (e) => {
      e.preventDefault();
      const ticker = document.getElementById('sellTicker').value.toUpperCase();
      const price = parseFloat(document.getElementById('sellPrice').value);
      const units = parseFloat(document.getElementById('sellUnits').value);
      
      const res = await fetch('/api/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, price, units })
      });
      
      if (res.ok) {
        alert('✅ Sell recorded!');
        location.reload();
      } else {
        alert('❌ Error recording sell');
      }
    };
    
    function quickSell(ticker, price) {
      document.getElementById('sellTicker').value = ticker;
      document.getElementById('sellPrice').value = price;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

// API endpoint to record buy
app.post('/api/buy', async (req, res) => {
  try {
    const { ticker, price, units } = req.body;
    await addPosition(ticker, price, new Date().toISOString(), `Manual entry - ${units} units`, units);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API endpoint to record sell
app.post('/api/sell', async (req, res) => {
  try {
    const { ticker, price, units } = req.body;
    await removePosition(ticker, price, new Date().toISOString(), `Manual exit - ${units} units`, units);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// EMAIL REPLY PARSING
// ============================================

async function checkEmailReplies() {
  // This would use IMAP to check for replies
  // For simplicity, using Gmail API would be better
  // For now, we'll keep manual web interface as primary method
  
  // TO IMPLEMENT: Check Gmail inbox for replies matching pattern:
  // "bought NVDA at 185" or "sold NVDA at 219"
  // Parse and call addPosition/removePosition
}

// ============================================
// PORTFOLIO MANAGEMENT (Same as before)
// ============================================

async function loadPortfolio() {
  try {
    const data = await fs.readFile(CONFIG.PORTFOLIO_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { positions: [], history: [] };
  }
}

async function savePortfolio(portfolio) {
  await fs.writeFile(
    CONFIG.PORTFOLIO_FILE,
    JSON.stringify(portfolio, null, 2),
    'utf8'
  );
}

async function addPosition(ticker, buyPrice, buyDate, buySignal, units = 1) {
  const portfolio = await loadPortfolio();
  
  portfolio.positions.push({
    ticker,
    buyPrice,
    buyDate,
    buySignal,
    units,
    daysHeld: 0,
    currentPrice: buyPrice,
    currentValue: buyPrice * units,
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0
  });
  
  portfolio.history.push({
    type: 'BUY',
    ticker,
    price: buyPrice,
    date: buyDate,
    signal: buySignal,
    units
  });
  
  await savePortfolio(portfolio);
  console.log(`✅ Added ${ticker} to portfolio at $${buyPrice} (${units} units)`);
}

async function removePosition(ticker, sellPrice, sellDate, sellSignal, units = null) {
  const portfolio = await loadPortfolio();
  
  const posIdx = portfolio.positions.findIndex(p => p.ticker === ticker);
  if (posIdx === -1) {
    console.log(`⚠️  ${ticker} not in portfolio`);
    return null;
  }
  
  const position = portfolio.positions[posIdx];
  const actualUnits = units || position.units;
  const profit = (sellPrice - position.buyPrice) * actualUnits;
  const profitPercent = (profit / (position.buyPrice * actualUnits)) * 100;
  
  portfolio.history.push({
    type: 'SELL',
    ticker,
    buyPrice: position.buyPrice,
    sellPrice,
    profit,
    profitPercent,
    daysHeld: position.daysHeld,
    buyDate: position.buyDate,
    sellDate,
    signal: sellSignal,
    units: actualUnits
  });
  
  // If selling all units, remove position
  if (!units || units >= position.units) {
    portfolio.positions.splice(posIdx, 1);
  } else {
    // Partial sell - reduce units
    portfolio.positions[posIdx].units -= units;
  }
  
  await savePortfolio(portfolio);
  console.log(`✅ Sold ${actualUnits} units of ${ticker} at $${sellPrice} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
  
  return { position, profit, profitPercent };
}

async function updatePortfolioPrices(currentPrices) {
  const portfolio = await loadPortfolio();
  
  for (const position of portfolio.positions) {
    const currentPrice = currentPrices[position.ticker];
    if (!currentPrice) continue;
    
    position.currentPrice = currentPrice;
    position.currentValue = currentPrice * position.units;
    position.unrealizedPnL = (currentPrice - position.buyPrice) * position.units;
    position.unrealizedPnLPercent = ((currentPrice - position.buyPrice) / position.buyPrice) * 100;
    
    const buyDate = new Date(position.buyDate);
    const now = new Date();
    position.daysHeld = Math.floor((now - buyDate) / (1000 * 60 * 60 * 24));
  }
  
  await savePortfolio(portfolio);
}

async function getCurrentPrice(ticker) {
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
    const data = await response.json();
    return data.chart.result[0].meta.regularMarketPrice;
  } catch (e) {
    console.error(`Price fetch error for ${ticker}:`, e.message);
    return null;
  }
}

async function getCurrentPrices(tickers) {
  const prices = {};
  for (const ticker of tickers) {
    const price = await getCurrentPrice(ticker);
    if (price) prices[ticker] = price;
  }
  return prices;
}

// ============================================
// ETORO ASSETS & DATA SOURCES
// (Same as server-complete.js - keeping it DRY)
// ============================================

const ETORO_TICKERS = {
  'AAPL': 'Apple', 'MSFT': 'Microsoft', 'GOOGL': 'Google', 'AMZN': 'Amazon',
  'NVDA': 'Nvidia', 'META': 'Meta', 'TSLA': 'Tesla', 'BRK.B': 'Berkshire',
  'JPM': 'JPMorgan', 'V': 'Visa', 'MA': 'Mastercard', 'WMT': 'Walmart',
  'DIS': 'Disney', 'NFLX': 'Netflix', 'PYPL': 'PayPal', 'ADBE': 'Adobe',
  'CSCO': 'Cisco', 'INTC': 'Intel', 'AMD': 'AMD', 'QCOM': 'Qualcomm',
  'BA': 'Boeing', 'GE': 'GE', 'GM': 'GM', 'F': 'Ford',
  'COIN': 'Coinbase', 'SQ': 'Block', 'SHOP': 'Shopify', 'UBER': 'Uber',
  'BABA': 'Alibaba', 'NKE': 'Nike', 'COST': 'Costco', 'PEP': 'Pepsi',
  'KO': 'Coca-Cola', 'MCD': 'McDonalds', 'BAC': 'BofA', 'WFC': 'Wells Fargo',
  'BTC': 'Bitcoin', 'ETH': 'Ethereum', 'XRP': 'Ripple', 'ADA': 'Cardano',
  'SOL': 'Solana', 'DOGE': 'Dogecoin', 'MATIC': 'Polygon', 'DOT': 'Polkadot'
};

const POWER_TRADERS = {
  congress: ['Nancy Pelosi', 'Paul Pelosi', 'Josh Gottheimer', 'Ro Khanna'],
  hedgeFunds: ['BERKSHIRE HATHAWAY', 'Bridgewater', 'ARK Investment']
};

function normalizeTicker(ticker) {
  if (!ticker) return null;
  ticker = ticker.toUpperCase().replace(/[^A-Z.]/g, '');
  return ETORO_TICKERS[ticker] ? ticker : null;
}

function parseAmount(range) {
  const map = {
    '$1,001 - $15,000': 8000, '$15,001 - $50,000': 32500,
    '$50,001 - $100,000': 75000, '$100,001 - $250,000': 175000,
    '$250,001 - $500,000': 375000, '$500,001 - $1,000,000': 750000,
    '$1,000,001 - $5,000,000': 3000000, 'Over $50,000,000': 50000000
  };
  return map[range] || 0;
}

// [Include all scan functions from server-complete.js]
// scanCongress, scanSECForm4, scanPolymarket, scanWhales
// aggregateSignals, generateActionEmail, generateWeeklySummary

// ============================================
// START SERVERS
// ============================================

function startWebInterface() {
  app.listen(CONFIG.WEB_PORT, () => {
    console.log(`\n🌐 Web interface: http://localhost:${CONFIG.WEB_PORT}`);
    console.log(`   (Render will provide public URL)\n`);
  });
}

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║   NUCLEAR INSIDER DETECTOR - COMPLETE SYSTEM          ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');
console.log('Features:');
console.log('  🎯 Nuclear BUY/SELL signals (85%+)');
console.log('  📊 Portfolio tracking');
console.log('  🌐 Web interface for trade recording');
console.log('  📧 Email reply tracking (coming soon)');
console.log('  📊 Weekly summaries');
console.log('\nStarting...\n');

startWebInterface();

// Continue with scan loop...
// [Rest of scan logic from server-complete.js]
