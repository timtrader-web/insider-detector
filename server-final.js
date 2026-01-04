const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const express = require('express');
const fs = require('fs').promises;

// ============================================
// CONFIGURATION - EDIT THESE 3 VALUES
// ============================================

const CONFIG = {
  EMAIL_TO: 'tim.norman@gmail.com',
  EMAIL_FROM: 'tim.norman@gmail.com',
  EMAIL_PASSWORD: 'amkpxyixfannzowl',
  
  SEC_API_KEY: '5c1704699394f4fb362f2d274503d9dcd999be9f87d9da27896dc8ee8bec08bc',
  
  NUCLEAR_CONFIDENCE: 85,
  MIN_SOURCES: 2,
  SCAN_INTERVAL_MINUTES: 30,
  WEB_PORT: process.env.PORT || 3000,
  
  PROFIT_TARGET: 15,
  MAX_HOLD_DAYS: 60,
  STOP_LOSS: -8
};

// ============================================
// PORTFOLIO STORAGE
// ============================================

let PORTFOLIO = {
  positions: [],
  history: []
};

async function loadPortfolio() {
  try {
    const data = await fs.readFile('./portfolio.json', 'utf8');
    PORTFOLIO = JSON.parse(data);
  } catch (e) {
    PORTFOLIO = { positions: [], history: [] };
  }
  return PORTFOLIO;
}

async function savePortfolio() {
  await fs.writeFile('./portfolio.json', JSON.stringify(PORTFOLIO, null, 2));
}

// ============================================
// ASSETS & HELPERS
// ============================================

const ETORO_TICKERS = {
  'AAPL': 'Apple', 'MSFT': 'Microsoft', 'GOOGL': 'Google', 'AMZN': 'Amazon',
  'NVDA': 'Nvidia', 'META': 'Meta', 'TSLA': 'Tesla', 'JPM': 'JPMorgan',
  'V': 'Visa', 'MA': 'Mastercard', 'DIS': 'Disney', 'NFLX': 'Netflix',
  'PYPL': 'PayPal', 'AMD': 'AMD', 'INTC': 'Intel', 'BA': 'Boeing',
  'COIN': 'Coinbase', 'BTC': 'Bitcoin', 'ETH': 'Ethereum'
};

const POWER_TRADERS = ['Nancy Pelosi', 'Paul Pelosi', 'Josh Gottheimer'];

function normalizeTicker(ticker) {
  if (!ticker) return null;
  ticker = ticker.toUpperCase().replace(/[^A-Z.]/g, '');
  return ETORO_TICKERS[ticker] ? ticker : null;
}

function parseAmount(range) {
  const map = {
    '$1,001 - $15,000': 8000,
    '$15,001 - $50,000': 32500,
    '$50,001 - $100,000': 75000,
    '$100,001 - $250,000': 175000,
    '$250,001 - $500,000': 375000,
    '$500,001 - $1,000,000': 750000,
    '$1,000,001 - $5,000,000': 3000000,
    'Over $50,000,000': 50000000
  };
  return map[range] || 0;
}

// ============================================
// DATA SOURCES
// ============================================

async function scanCongress() {
  try {
    console.log('🏛️  Scanning Congress trades...');
    const response = await fetch('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json');
    const trades = await response.json();
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recent = trades.filter(t => new Date(t.transaction_date) > sevenDaysAgo);
    
    const signals = [];
    for (const trade of recent) {
      const ticker = normalizeTicker(trade.ticker);
      if (!ticker) continue;
      
      const amount = parseAmount(trade.amount);
      if (amount < 15000) continue;
      
      const isPower = POWER_TRADERS.some(name => trade.representative?.includes(name));
      
      signals.push({
        source: 'Congress',
        ticker,
        action: trade.type.includes('Sale') ? 'SELL' : 'BUY',
        confidence: isPower ? 95 : 80,
        amount,
        trader: trade.representative,
        powerTrader: isPower
      });
    }
    
    console.log(`   ✓ Found ${signals.length} Congress signals`);
    return signals;
  } catch (e) {
    console.error('   ❌ Congress error:', e.message);
    return [];
  }
}

async function scanSECForm4() {
  if (!CONFIG.SEC_API_KEY || CONFIG.SEC_API_KEY === 'your-sec-api-key-here') {
    console.log('📋 SEC Form 4: SKIPPED (no API key)');
    return [];
  }
  
  try {
    console.log('📋 Scanning SEC Form 4...');
    const response = await fetch('https://api.sec-api.io/insider-trading', {
      method: 'POST',
      headers: {
        'Authorization': CONFIG.SEC_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: {
          query_string: {
            query: 'transactionDate:[now-7d TO now] AND transactionShares:[5000 TO *]'
          }
        },
        from: 0,
        size: 50
      })
    });
    
    const data = await response.json();
    const transactions = data.transactions || [];
    
    const signals = [];
    const clusterMap = {};
    
    for (const t of transactions) {
      const ticker = normalizeTicker(t.issuer?.tradingSymbol);
      if (!ticker) continue;
      
      const value = (t.transactionShares || 0) * (t.transactionPricePerShare || 0);
      if (value < 100000) continue;
      
      const isBuy = ['P', 'A', 'M'].includes(t.transactionCode);
      const isSell = t.transactionCode === 'S';
      
      if (!isBuy && !isSell) continue;
      
      const isCLevel = t.reportingOwner?.relationship?.isOfficer &&
                      t.reportingOwner?.relationship?.officerTitle?.match(/CEO|CFO|COO|President/i);
      
      signals.push({
        source: 'SEC Form 4',
        ticker,
        action: isBuy ? 'BUY' : 'SELL',
        confidence: isCLevel ? 85 : 75,
        amount: value,
        trader: t.reportingOwner?.name
      });
      
      const key = `${ticker}_${isBuy ? 'BUY' : 'SELL'}`;
      if (!clusterMap[key]) clusterMap[key] = [];
      clusterMap[key].push(t);
    }
    
    // Detect clusters
    for (const [key, trades] of Object.entries(clusterMap)) {
      if (trades.length >= 3) {
        const [ticker, action] = key.split('_');
        signals.push({
          source: 'Insider Cluster',
          ticker,
          action,
          confidence: 90,
          amount: trades.reduce((sum, t) => sum + (t.transactionShares * t.transactionPricePerShare), 0),
          isCluster: true
        });
      }
    }
    
    console.log(`   ✓ Found ${signals.length} SEC signals`);
    return signals;
  } catch (e) {
    console.error('   ❌ SEC error:', e.message);
    return [];
  }
}

async function scanPolymarket() {
  try {
    console.log('📊 Scanning Polymarket...');
    const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&limit=50');
    const markets = await response.json();
    
    const signals = [];
    
    for (const market of markets || []) {
      if (!market.volume || market.volume < 100000) continue;
      
      const title = market.title.toLowerCase();
      
      for (const ticker of Object.keys(ETORO_TICKERS)) {
        const name = ETORO_TICKERS[ticker].toLowerCase();
        if (title.includes(ticker.toLowerCase()) || title.includes(name)) {
          const isBullish = title.match(/reach|hit|above|over|exceed|rise/i);
          const isBearish = title.match(/below|fall|drop|decline|miss/i);
          
          if (isBullish || isBearish) {
            signals.push({
              source: 'Polymarket',
              ticker,
              action: isBullish ? 'BUY' : 'SELL',
              confidence: 70,
              amount: market.volume
            });
          }
        }
      }
    }
    
    console.log(`   ✓ Found ${signals.length} Polymarket signals`);
    return signals;
  } catch (e) {
    console.error('   ❌ Polymarket error:', e.message);
    return [];
  }
}

// ============================================
// SIGNAL AGGREGATION
// ============================================

function aggregateSignals(allSignals) {
  const byTicker = {};
  
  for (const sig of allSignals) {
    if (!byTicker[sig.ticker]) {
      byTicker[sig.ticker] = {
        ticker: sig.ticker,
        buys: [],
        sells: [],
        sources: new Set(),
        powerTraders: []
      };
    }
    
    const asset = byTicker[sig.ticker];
    if (sig.action === 'BUY') asset.buys.push(sig);
    if (sig.action === 'SELL') asset.sells.push(sig);
    asset.sources.add(sig.source);
    if (sig.powerTrader) asset.powerTraders.push(sig.trader);
  }
  
  const nuclear = [];
  
  for (const [ticker, data] of Object.entries(byTicker)) {
    const buyScore = data.buys.reduce((sum, s) => sum + s.confidence, 0);
    const sellScore = data.sells.reduce((sum, s) => sum + s.confidence, 0);
    
    if (data.sources.size < CONFIG.MIN_SOURCES) continue;
    
    const avgConf = (buyScore + sellScore) / (data.buys.length + data.sells.length);
    let finalConf = avgConf;
    if (data.powerTraders.length > 0) finalConf += 10;
    if (data.sources.size >= 3) finalConf += 10;
    finalConf = Math.min(finalConf, 99);
    
    if (finalConf < CONFIG.NUCLEAR_CONFIDENCE) continue;
    
    let action = null;
    const netScore = buyScore - sellScore;
    if (netScore > 50) action = netScore > 100 ? 'STRONG BUY' : 'BUY';
    else if (netScore < -50) action = netScore < -100 ? 'STRONG SELL' : 'SELL';
    
    if (action) {
      nuclear.push({
        ticker,
        action,
        confidence: Math.round(finalConf),
        sources: Array.from(data.sources),
        powerTraders: data.powerTraders,
        buys: data.buys,
        sells: data.sells
      });
    }
  }
  
  return nuclear.sort((a, b) => b.confidence - a.confidence);
}

// ============================================
// EMAIL ALERTS
// ============================================

function generateEmail(signals) {
  const top = signals[0];
  
  let html = `
<html>
<head>
<style>
  body { font-family: -apple-system, sans-serif; background: #000; color: #fff; padding: 20px; }
  .hero { background: linear-gradient(135deg, #00ff88, #7928ca); padding: 60px 40px; border-radius: 16px; text-align: center; margin-bottom: 30px; }
  .action { font-size: 48px; font-weight: 900; }
  .ticker { font-size: 64px; font-weight: 900; margin: 20px 0; }
  .conf { font-size: 24px; margin-top: 10px; }
  .details { background: #1a1a1a; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
  .source { padding: 12px; background: #2a2a2a; margin: 8px 0; border-radius: 6px; }
  .btn { display: inline-block; background: #00ff88; color: #000; padding: 20px 50px; border-radius: 12px; text-decoration: none; font-size: 24px; font-weight: 900; margin: 20px 0; }
</style>
</head>
<body>
  <div class="hero">
    <div class="action">${top.action}</div>
    <div class="ticker">${top.ticker}</div>
    <div class="conf">${top.confidence}% confidence</div>
    <div class="conf">${top.sources.length} sources${top.powerTraders.length > 0 ? ' + Power Traders' : ''}</div>
  </div>
  
  <div class="details">
    <h3>Why This Signal:</h3>
  `;
  
  const allSigs = [...top.buys, ...top.sells].slice(0, 5);
  for (const sig of allSigs) {
    html += `
      <div class="source">
        <strong>${sig.source}:</strong> ${sig.action}
        ${sig.powerTrader ? '⭐ POWER TRADER' : ''}
        ${sig.trader ? `<br><small>${sig.trader}</small>` : ''}
      </div>
    `;
  }
  
  html += `
  </div>
  
  <div style="text-align: center;">
    <a href="https://www.etoro.com/discover/markets/stocks/${top.ticker}" class="btn">
      ${top.action} ON ETORO
    </a>
  </div>
  
  <div style="text-align: center; padding: 20px; opacity: 0.5; font-size: 12px;">
    Reply to this email with: "bought 10 at 185" to track your trade
  </div>
</body>
</html>
  `;
  
  return html;
}

async function sendEmail(subject, html) {
  if (CONFIG.EMAIL_PASSWORD === 'your-app-password-here') {
    console.log('   ⚠️  Email not configured - skipping send');
    return;
  }
  
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: CONFIG.EMAIL_FROM,
        pass: CONFIG.EMAIL_PASSWORD
      }
    });
    
    await transporter.sendMail({
      from: CONFIG.EMAIL_FROM,
      to: CONFIG.EMAIL_TO,
      subject,
      html
    });
    
    console.log('   ✅ Email sent!');
  } catch (e) {
    console.error('   ❌ Email error:', e.message);
  }
}

// ============================================
// MAIN SCAN
// ============================================

async function runScan() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚨 NUCLEAR SCAN: ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    const [congress, sec, poly] = await Promise.all([
      scanCongress(),
      scanSECForm4(),
      scanPolymarket()
    ]);
    
    const all = [...congress, ...sec, ...poly];
    console.log(`\n📊 Total signals collected: ${all.length}`);
    
    if (all.length > 0) {
      const nuclear = aggregateSignals(all);
      
      if (nuclear.length > 0) {
        console.log(`\n🚨 NUCLEAR SIGNALS DETECTED: ${nuclear.length}`);
        nuclear.forEach(n => {
          console.log(`   ${n.action} ${n.ticker} (${n.confidence}%) - ${n.sources.length} sources`);
        });
        
        const subject = `🚨 NUCLEAR: ${nuclear[0].action} ${nuclear[0].ticker} (${nuclear[0].confidence}%)`;
        await sendEmail(subject, generateEmail(nuclear));
      } else {
        console.log('\n✅ No nuclear-level signals (waiting for 85%+ with 2+ sources)');
      }
    } else {
      console.log('\n✅ No signals detected this scan');
    }
    
  } catch (e) {
    console.error('❌ Scan error:', e.message);
  }
  
  console.log(`\n⏰ Next scan in ${CONFIG.SCAN_INTERVAL_MINUTES} minutes\n`);
}

// ============================================
// WEB INTERFACE
// ============================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', async (req, res) => {
  await loadPortfolio();
  
  const totalUnrealized = PORTFOLIO.positions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
  const totalRealized = PORTFOLIO.history.filter(h => h.type === 'SELL').reduce((sum, h) => sum + (h.profit || 0), 0);
  
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Nuclear Insider Detector</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    .header { background: rgba(255,255,255,0.95); padding: 30px; border-radius: 16px; margin-bottom: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-align: center; }
    .header h1 { font-size: 32px; color: #1a1a1a; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
    .stat { background: rgba(255,255,255,0.95); padding: 25px; border-radius: 12px; text-align: center; }
    .stat-value { font-size: 36px; font-weight: bold; margin: 10px 0; }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
    .section { background: rgba(255,255,255,0.95); padding: 30px; border-radius: 12px; margin-bottom: 20px; }
    input, button { padding: 12px 20px; border-radius: 8px; border: 2px solid #e5e7eb; font-size: 16px; margin: 5px; }
    button { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; font-weight: bold; cursor: pointer; }
    .position { background: #f9fafb; padding: 20px; border-radius: 10px; margin: 10px 0; border-left: 5px solid #667eea; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚨 Nuclear Insider Detector</h1>
      <p>System Status: <strong style="color: #10b981;">LIVE</strong></p>
    </div>
    
    <div class="stats">
      <div class="stat">
        <div>Unrealized P&L</div>
        <div class="stat-value ${totalUnrealized >= 0 ? 'positive' : 'negative'}">
          ${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toFixed(2)}
        </div>
      </div>
      <div class="stat">
        <div>Realized P&L</div>
        <div class="stat-value ${totalRealized >= 0 ? 'positive' : 'negative'}">
          ${totalRealized >= 0 ? '+' : ''}$${totalRealized.toFixed(2)}
        </div>
      </div>
    </div>
    
    <div class="section">
      <h2>📝 Record Trade</h2>
      <form method="POST" action="/buy">
        <input type="text" name="ticker" placeholder="Ticker (NVDA)" required>
        <input type="number" name="price" placeholder="Price" step="0.01" required>
        <input type="number" name="units" placeholder="Units" value="1" step="0.01">
        <button type="submit">BUY</button>
      </form>
      <form method="POST" action="/sell">
        <input type="text" name="ticker" placeholder="Ticker (NVDA)" required>
        <input type="number" name="price" placeholder="Price" step="0.01" required>
        <button type="submit" style="background: linear-gradient(135deg, #ef4444, #dc2626);">SELL</button>
      </form>
    </div>
    
    <div class="section">
      <h2>💼 Positions (${PORTFOLIO.positions.length})</h2>
      ${PORTFOLIO.positions.length === 0 ? '<p>No positions yet. Record your first trade above!</p>' : ''}
      ${PORTFOLIO.positions.map(p => `
        <div class="position">
          <strong>${p.ticker}</strong> - ${p.units} units @ $${p.buyPrice?.toFixed(2) || 0}
          <br><small>${new Date(p.buyDate).toLocaleDateString()}</small>
        </div>
      `).join('')}
    </div>
    
    <div style="text-align: center; color: rgba(255,255,255,0.8); padding: 20px;">
      <p>Scanning every ${CONFIG.SCAN_INTERVAL_MINUTES} minutes</p>
      <p>Next alert when 85%+ confidence signal detected</p>
    </div>
  </div>
</body>
</html>
  `;
  
  res.send(html);
});

app.post('/buy', async (req, res) => {
  const { ticker, price, units } = req.body;
  PORTFOLIO.positions.push({
    ticker: ticker.toUpperCase(),
    buyPrice: parseFloat(price),
    buyDate: new Date().toISOString(),
    units: parseFloat(units || 1)
  });
  await savePortfolio();
  res.redirect('/');
});

app.post('/sell', async (req, res) => {
  const { ticker, price } = req.body;
  const idx = PORTFOLIO.positions.findIndex(p => p.ticker === ticker.toUpperCase());
  if (idx >= 0) {
    const pos = PORTFOLIO.positions[idx];
    const profit = (parseFloat(price) - pos.buyPrice) * pos.units;
    PORTFOLIO.history.push({
      type: 'SELL',
      ticker: pos.ticker,
      profit,
      sellDate: new Date().toISOString()
    });
    PORTFOLIO.positions.splice(idx, 1);
    await savePortfolio();
  }
  res.redirect('/');
});

// ============================================
// START EVERYTHING
// ============================================

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║   NUCLEAR INSIDER DETECTOR - COMPLETE SYSTEM          ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');
console.log('Features:');
console.log('  🎯 Nuclear BUY/SELL signals (85%+)');
console.log('  📊 Portfolio tracking');
console.log('  🌐 Web interface for trade recording');
console.log('  📧 Email alerts');
console.log('\nStarting...\n');

// Start web interface
app.listen(CONFIG.WEB_PORT, () => {
  console.log(`🌐 Web interface running on port ${CONFIG.WEB_PORT}`);
  console.log(`   Visit: https://insider-detector.onrender.com\n`);
});

// Load portfolio
loadPortfolio().then(() => {
  console.log(`📊 Portfolio loaded: ${PORTFOLIO.positions.length} positions\n`);
});

// Start scanning after 5 seconds
setTimeout(() => {
  console.log('🚀 Starting scanner...\n');
  runScan(); // Run immediately
  setInterval(runScan, CONFIG.SCAN_INTERVAL_MINUTES * 60 * 1000); // Then every 30 min
}, 5000);
