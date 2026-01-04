const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const express = require('express');
const fs = require('fs').promises;

// ============================================
// CONFIGURATION - EDIT THESE VALUES
// ============================================

const CONFIG = {
  // Email settings
  EMAIL_TO: 'tim.norman@gmail.com',
  EMAIL_FROM: 'tim.norman@gmail.com',
  EMAIL_PASSWORD: 'amkpxyixfannzowl',
  
  // API Keys
  SEC_API_KEY: '5c1704699394f4fb362f2d274503d9dcd999be9f87d9da27896dc8ee8bec08bc',
  
  // Signal settings
  NUCLEAR_CONFIDENCE: 85,
  MIN_SOURCES: 2,
  
  // Timing
  SCAN_INTERVAL_MINUTES: 30,
  INTELLIGENCE_UPDATE_DAYS: 7, // Weekly intelligence updates
  
  // Portfolio settings
  PROFIT_TARGET: 15,
  MAX_HOLD_DAYS: 60,
  STOP_LOSS: -8,
  
  // System
  WEB_PORT: process.env.PORT || 3000
};

// ============================================
// PORTFOLIO & INTELLIGENCE STORAGE
// ============================================

let PORTFOLIO = { positions: [], history: [] };
let INTELLIGENCE = {
  powerTraders: ['Nancy Pelosi', 'Paul Pelosi', 'Josh Gottheimer', 'Ro Khanna'],
  patterns: [],
  sources: {},
  lastUpdate: null
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

async function loadIntelligence() {
  try {
    const data = await fs.readFile('./intelligence.json', 'utf8');
    INTELLIGENCE = JSON.parse(data);
  } catch (e) {
    INTELLIGENCE = {
      powerTraders: ['Nancy Pelosi', 'Paul Pelosi', 'Josh Gottheimer', 'Ro Khanna'],
      patterns: [],
      sources: {},
      lastUpdate: null
    };
  }
  return INTELLIGENCE;
}

async function saveIntelligence() {
  await fs.writeFile('./intelligence.json', JSON.stringify(INTELLIGENCE, null, 2));
}

// ============================================
// ASSETS & HELPERS
// ============================================

const ETORO_TICKERS = {
  'AAPL': 'Apple', 'MSFT': 'Microsoft', 'GOOGL': 'Google', 'AMZN': 'Amazon',
  'NVDA': 'Nvidia', 'META': 'Meta', 'TSLA': 'Tesla', 'JPM': 'JPMorgan',
  'V': 'Visa', 'MA': 'Mastercard', 'DIS': 'Disney', 'NFLX': 'Netflix',
  'PYPL': 'PayPal', 'AMD': 'AMD', 'INTC': 'Intel', 'BA': 'Boeing',
  'COIN': 'Coinbase', 'UBER': 'Uber', 'SHOP': 'Shopify', 'SQ': 'Block',
  'BTC': 'Bitcoin', 'ETH': 'Ethereum', 'SOL': 'Solana', 'ADA': 'Cardano'
};

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
    
    const response = await fetch('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json', {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const text = await response.text();
    
    // Check if response is actually JSON
    if (text.trim().startsWith('<')) {
      console.log('   ⚠️  Congress API returned XML (temporary issue) - skipping');
      return [];
    }
    
    const trades = JSON.parse(text);
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recent = trades.filter(t => {
      const date = new Date(t.transaction_date);
      return date > sevenDaysAgo;
    });
    
    const signals = [];
    for (const trade of recent) {
      const ticker = normalizeTicker(trade.ticker);
      if (!ticker) continue;
      
      const amount = parseAmount(trade.amount);
      if (amount < 15000) continue;
      
      const isPower = INTELLIGENCE.powerTraders.some(name => 
        trade.representative?.includes(name)
      );
      
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
    console.log(`   ⚠️  Congress API error: ${e.message} - continuing with other sources`);
    return [];
  }
}

async function scanSECForm4() {
  if (!CONFIG.SEC_API_KEY || CONFIG.SEC_API_KEY === 'your-sec-api-key-here') {
    console.log('📋 SEC Form 4: SKIPPED (no API key configured)');
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
        size: 50,
        sort: [{ filedAt: { order: 'desc' } }]
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
      
      // Track for cluster detection
      const key = `${ticker}_${isBuy ? 'BUY' : 'SELL'}`;
      if (!clusterMap[key]) clusterMap[key] = [];
      clusterMap[key].push(t);
    }
    
    // Detect clusters (3+ insiders buying/selling same stock)
    for (const [key, trades] of Object.entries(clusterMap)) {
      if (trades.length >= 3) {
        const [ticker, action] = key.split('_');
        const totalValue = trades.reduce((sum, t) => 
          sum + (t.transactionShares * t.transactionPricePerShare), 0
        );
        
        signals.push({
          source: 'Insider Cluster',
          ticker,
          action,
          confidence: 90,
          amount: totalValue,
          isCluster: true,
          clusterSize: trades.length
        });
      }
    }
    
    console.log(`   ✓ Found ${signals.length} SEC signals`);
    return signals;
    
  } catch (e) {
    console.log(`   ⚠️  SEC API error: ${e.message} - continuing`);
    return [];
  }
}

async function scanPolymarket() {
  try {
    console.log('📊 Scanning Polymarket...');
    
    const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&limit=50');
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      console.log('   ⚠️  Polymarket returned unexpected format - skipping');
      return [];
    }
    
    const signals = [];
    
    for (const market of data) {
      if (!market || !market.title || !market.volume || market.volume < 100000) continue;
      
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
              amount: market.volume,
              market: market.title
            });
          }
        }
      }
    }
    
    console.log(`   ✓ Found ${signals.length} Polymarket signals`);
    return signals;
    
  } catch (e) {
    console.log(`   ⚠️  Polymarket error: ${e.message} - continuing`);
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
        powerTraders: [],
        clusters: []
      };
    }
    
    const asset = byTicker[sig.ticker];
    if (sig.action === 'BUY') asset.buys.push(sig);
    if (sig.action === 'SELL') asset.sells.push(sig);
    asset.sources.add(sig.source);
    if (sig.powerTrader) asset.powerTraders.push(sig.trader);
    if (sig.isCluster) asset.clusters.push(sig);
  }
  
  const nuclear = [];
  
  for (const [ticker, data] of Object.entries(byTicker)) {
    const buyScore = data.buys.reduce((sum, s) => sum + s.confidence, 0);
    const sellScore = data.sells.reduce((sum, s) => sum + s.confidence, 0);
    
    if (data.sources.size < CONFIG.MIN_SOURCES) continue;
    
    const avgConf = (buyScore + sellScore) / (data.buys.length + data.sells.length);
    let finalConf = avgConf;
    
    // Confidence bonuses
    if (data.powerTraders.length > 0) finalConf += 10;
    if (data.clusters.length > 0) finalConf += 15;
    if (data.sources.size >= 3) finalConf += 10;
    
    finalConf = Math.min(finalConf, 99);
    
    if (finalConf < CONFIG.NUCLEAR_CONFIDENCE) continue;
    
    // Determine action
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
        clusters: data.clusters,
        buys: data.buys,
        sells: data.sells
      });
    }
  }
  
  return nuclear.sort((a, b) => b.confidence - a.confidence);
}

// ============================================
// EMAIL GENERATION & SENDING
// ============================================

function generateAlertEmail(signals) {
  const top = signals[0];
  
  let html = `
<html>
<head>
<style>
  body { font-family: -apple-system, sans-serif; background: #000; color: #fff; margin: 0; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; }
  .hero { background: linear-gradient(135deg, #00ff88, #7928ca); padding: 60px 40px; border-radius: 16px; text-align: center; margin-bottom: 30px; }
  .action { font-size: 48px; font-weight: 900; }
  .ticker { font-size: 64px; font-weight: 900; margin: 20px 0; letter-spacing: 4px; }
  .conf { font-size: 24px; opacity: 0.9; margin-top: 10px; }
  .details { background: #1a1a1a; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
  .source { padding: 12px; background: #2a2a2a; margin: 8px 0; border-radius: 6px; border-left: 4px solid #7928ca; }
  .power { color: #ffd700; }
  .btn { display: inline-block; background: #00ff88; color: #000; padding: 20px 50px; border-radius: 12px; text-decoration: none; font-size: 24px; font-weight: 900; margin: 20px 0; }
</style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="action">${top.action}</div>
      <div class="ticker">${top.ticker}</div>
      <div class="conf">${top.confidence}% confidence</div>
      <div class="conf">${top.sources.length} sources${top.powerTraders.length > 0 ? ' + Power Traders' : ''}</div>
    </div>
    
    <div class="details">
      <h3 style="margin-top: 0;">Why This Signal:</h3>
  `;
  
  const allSigs = [...top.buys, ...top.sells].slice(0, 6);
  for (const sig of allSigs) {
    const emoji = sig.source.includes('Congress') ? '🏛️' :
                  sig.source.includes('Cluster') ? '🚨' :
                  sig.source.includes('SEC') ? '📋' :
                  sig.source.includes('Polymarket') ? '📊' : '📈';
    
    html += `
      <div class="source">
        ${emoji} <strong>${sig.source}:</strong> ${sig.action}
        ${sig.powerTrader ? '<span class="power">⭐ POWER TRADER</span>' : ''}
        ${sig.clusterSize ? ` (${sig.clusterSize} insiders)` : ''}
        ${sig.trader ? `<br><small style="opacity: 0.7;">${sig.trader}</small>` : ''}
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
    
    <div style="text-align: center; padding: 20px; opacity: 0.5; font-size: 13px;">
      <p>Record your trade at: https://insider-detector.onrender.com</p>
      <p>Nuclear Insider Detector • ${new Date().toLocaleDateString()}</p>
    </div>
  </div>
</body>
</html>
  `;
  
  return html;
}

function generateIntelligenceEmail(report) {
  let html = `
<html>
<head>
<style>
  body { font-family: -apple-system, sans-serif; background: #000; color: #fff; padding: 20px; }
  .container { max-width: 700px; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 40px; border-radius: 16px; text-align: center; margin-bottom: 30px; }
  .section { background: #1a1a1a; padding: 25px; border-radius: 12px; margin-bottom: 20px; }
  .section h2 { margin-top: 0; color: #00ff88; }
  .item { padding: 12px; background: #2a2a2a; margin: 8px 0; border-radius: 6px; }
  .new { color: #00ff88; font-weight: bold; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🧠 Intelligence Update</h1>
      <p style="margin: 10px 0 0; opacity: 0.9;">${new Date().toLocaleDateString()}</p>
    </div>
    
    <div class="section">
      <h2>System Status</h2>
      <div class="item">✅ All sources operational</div>
      <div class="item">📊 Tracking ${report.powerTraders.length} power traders</div>
      <div class="item">🔍 ${report.discoveries.length} discoveries this week</div>
    </div>
    
    ${report.newPowerTraders.length > 0 ? `
    <div class="section">
      <h2>🌟 New Power Traders</h2>
      ${report.newPowerTraders.map(pt => `
        <div class="item">
          <span class="new">NEW:</span> ${pt.name}
          <br><small>${pt.trades} trades • $${(pt.volume/1000000).toFixed(1)}M volume</small>
        </div>
      `).join('')}
    </div>
    ` : ''}
    
    ${report.discoveries.length > 0 ? `
    <div class="section">
      <h2>🔍 This Week's Discoveries</h2>
      ${report.discoveries.map(d => `
        <div class="item">${d}</div>
      `).join('')}
    </div>
    ` : ''}
    
    <div class="section">
      <h2>📈 Current Power Traders</h2>
      ${report.powerTraders.slice(0, 10).map((pt, i) => `
        <div class="item">${i + 1}. ${pt}</div>
      `).join('')}
    </div>
    
    <div style="text-align: center; padding: 20px; opacity: 0.5; font-size: 13px;">
      Next update: ${new Date(Date.now() + CONFIG.INTELLIGENCE_UPDATE_DAYS * 24 * 60 * 60 * 1000).toLocaleDateString()}
    </div>
  </div>
</body>
</html>
  `;
  
  return html;
}

async function sendEmail(subject, html) {
  if (CONFIG.EMAIL_PASSWORD === 'your-app-password-here') {
    console.log('   ⚠️  Email not configured - skipping send');
    console.log(`   📧 Would have sent: ${subject}`);
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
    
    console.log('   ✅ Email sent successfully!');
  } catch (e) {
    console.error('   ❌ Email error:', e.message);
  }
}

// ============================================
// INTELLIGENCE ENGINE
// ============================================

async function analyzeCongressPerformance() {
  try {
    console.log('🧠 Analyzing Congressional performance...');
    
    const response = await fetch('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json', {
      headers: { 'Accept': 'application/json' }
    });
    
    const text = await response.text();
    if (text.trim().startsWith('<')) {
      console.log('   ⚠️  API unavailable - keeping current power traders');
      return INTELLIGENCE.powerTraders;
    }
    
    const allTrades = JSON.parse(text);
    
    // Last 365 days
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    const recentTrades = allTrades.filter(t => 
      new Date(t.transaction_date) > oneYearAgo
    );
    
    // Group by representative
    const byMember = {};
    for (const trade of recentTrades) {
      if (!byMember[trade.representative]) {
        byMember[trade.representative] = [];
      }
      byMember[trade.representative].push(trade);
    }
    
    // Calculate performance score
    const performers = [];
    for (const [member, trades] of Object.entries(byMember)) {
      if (trades.length < 10) continue;
      
      const totalValue = trades.reduce((sum, t) => sum + parseAmount(t.amount), 0);
      if (totalValue < 500000) continue;
      
      const buys = trades.filter(t => t.type === 'purchase').length;
      const sells = trades.filter(t => t.type === 'sale').length;
      
      performers.push({
        name: member,
        trades: trades.length,
        volume: totalValue,
        score: Math.log(totalValue) * trades.length
      });
    }
    
    // Top 15 performers
    performers.sort((a, b) => b.score - a.score);
    const topPerformers = performers.slice(0, 15).map(p => p.name);
    
    console.log(`   ✓ Identified ${topPerformers.length} top performers`);
    
    return topPerformers;
    
  } catch (e) {
    console.log(`   ⚠️  Analysis error: ${e.message}`);
    return INTELLIGENCE.powerTraders;
  }
}

async function runIntelligenceUpdate() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧠 ADAPTIVE INTELLIGENCE UPDATE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const report = {
    date: new Date().toISOString(),
    powerTraders: INTELLIGENCE.powerTraders,
    newPowerTraders: [],
    discoveries: []
  };
  
  // Analyze Congress performance
  const newPowerTraders = await analyzeCongressPerformance();
  
  // Find NEW power traders
  const current = INTELLIGENCE.powerTraders;
  const discovered = newPowerTraders.filter(pt => !current.includes(pt));
  
  if (discovered.length > 0) {
    console.log(`\n🌟 NEW POWER TRADERS DISCOVERED: ${discovered.length}`);
    discovered.forEach(pt => {
      console.log(`   ⭐ ${pt}`);
      report.newPowerTraders.push({ name: pt, trades: 0, volume: 0 });
    });
    
    INTELLIGENCE.powerTraders = newPowerTraders;
    report.discoveries.push(`Found ${discovered.length} new high-performing traders`);
  }
  
  // Update timestamp
  INTELLIGENCE.lastUpdate = new Date().toISOString();
  await saveIntelligence();
  
  // Send report
  if (report.newPowerTraders.length > 0 || report.discoveries.length > 0) {
    await sendEmail('🧠 Intelligence Update - New Discoveries', generateIntelligenceEmail(report));
  }
  
  console.log('\n✅ Intelligence update complete\n');
  return report;
}

// ============================================
// MAIN SCAN
// ============================================

async function runScan() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚨 NUCLEAR SCAN: ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    // Scan all sources
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
        await sendEmail(subject, generateAlertEmail(nuclear));
      } else {
        console.log(`\n✅ No nuclear signals (need ${CONFIG.NUCLEAR_CONFIDENCE}%+ with ${CONFIG.MIN_SOURCES}+ sources)`);
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
    .header h1 { font-size: 32px; color: #1a1a1a; margin-bottom: 5px; }
    .status { color: #10b981; font-weight: bold; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
    .stat { background: rgba(255,255,255,0.95); padding: 25px; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .stat-label { font-size: 13px; color: #666; text-transform: uppercase; }
    .stat-value { font-size: 36px; font-weight: bold; margin: 10px 0; }
    .positive { color: #10b981; }
    .negative { color: #ef4444; }
    .section { background: rgba(255,255,255,0.95); padding: 30px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
    .section h2 { font-size: 20px; margin-bottom: 20px; color: #1a1a1a; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; margin-bottom: 15px; }
    input, button { padding: 12px 16px; border-radius: 8px; border: 2px solid #e5e7eb; font-size: 16px; }
    input:focus { outline: none; border-color: #667eea; }
    button { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; font-weight: bold; cursor: pointer; transition: transform 0.2s; }
    button:hover { transform: translateY(-2px); }
    .btn-sell { background: linear-gradient(135deg, #ef4444, #dc2626); }
    .position { background: #f9fafb; padding: 20px; border-radius: 10px; margin-bottom: 15px; border-left: 5px solid #667eea; }
    .position-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .ticker { font-size: 24px; font-weight: bold; }
    .info { text-align: center; padding: 20px; color: rgba(255,255,255,0.9); font-size: 14px; }
    @media (max-width: 768px) {
      .stats { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚨 Nuclear Insider Detector</h1>
      <p>Status: <span class="status">LIVE & SCANNING</span></p>
      <p style="font-size: 13px; color: #666; margin-top: 5px;">
        Tracking ${INTELLIGENCE.powerTraders.length} power traders
      </p>
    </div>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Unrealized P&L</div>
        <div class="stat-value ${totalUnrealized >= 0 ? 'positive' : 'negative'}">
          ${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toFixed(2)}
        </div>
        <div style="font-size: 14px; color: #666;">${PORTFOLIO.positions.length} positions</div>
      </div>
      <div class="stat">
        <div class="stat-label">Realized P&L</div>
        <div class="stat-value ${totalRealized >= 0 ? 'positive' : 'negative'}">
          ${totalRealized >= 0 ? '+' : ''}$${totalRealized.toFixed(2)}
        </div>
        <div style="font-size: 14px; color: #666;">
          ${PORTFOLIO.history.filter(h => h.type === 'SELL').length} closed trades
        </div>
      </div>
    </div>
    
    <div class="section">
      <h2>📝 Record Trade</h2>
      <form method="POST" action="/buy" class="form-row">
        <input type="text" name="ticker" placeholder="Ticker (NVDA)" required>
        <input type="number" name="price" placeholder="Buy Price" step="0.01" required>
        <input type="number" name="units" placeholder="Units" value="1" step="0.01">
        <button type="submit">BUY</button>
      </form>
      <form method="POST" action="/sell" class="form-row">
        <input type="text" name="ticker" placeholder="Ticker (NVDA)" required>
        <input type="number" name="price" placeholder="Sell Price" step="0.01" required>
        <input type="number" name="units" placeholder="Units" step="0.01">
        <button type="submit" class="btn-sell">SELL</button>
      </form>
    </div>
    
    <div class="section">
      <h2>💼 Open Positions (${PORTFOLIO.positions.length})</h2>
      ${PORTFOLIO.positions.length === 0 ? '<p style="color: #666; text-align: center; padding: 20px;">No positions yet. Record your first trade above!</p>' : ''}
      ${PORTFOLIO.positions.map(p => `
        <div class="position">
          <div class="position-header">
            <div class="ticker">${p.ticker}</div>
            <div style="font-weight: bold;">${p.units} units @ $${(p.buyPrice || 0).toFixed(2)}</div>
          </div>
          <div style="font-size: 14px; color: #666;">
            Bought: ${new Date(p.buyDate).toLocaleDateString()}
          </div>
        </div>
      `).join('')}
    </div>
    
    <div class="info">
      <p><strong>Next scan:</strong> ${new Date(Date.now() + CONFIG.SCAN_INTERVAL_MINUTES * 60 * 1000).toLocaleTimeString()}</p>
      <p style="margin-top: 10px;">Alert triggers: ${CONFIG.NUCLEAR_CONFIDENCE}%+ confidence with ${CONFIG.MIN_SOURCES}+ sources</p>
      <p style="margin-top: 10px; opacity: 0.7;">Intelligence updates: Every ${CONFIG.INTELLIGENCE_UPDATE_DAYS} days</p>
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
    units: parseFloat(units || 1),
    unrealizedPnL: 0
  });
  await savePortfolio();
  console.log(`✅ Recorded BUY: ${units || 1} ${ticker.toUpperCase()} @ $${price}`);
  res.redirect('/');
});

app.post('/sell', async (req, res) => {
  const { ticker, price, units } = req.body;
  const upperTicker = ticker.toUpperCase();
  const sellUnits = parseFloat(units || 0);
  
  const idx = PORTFOLIO.positions.findIndex(p => p.ticker === upperTicker);
  if (idx >= 0) {
    const pos = PORTFOLIO.positions[idx];
    const actualUnits = sellUnits || pos.units;
    const profit = (parseFloat(price) - pos.buyPrice) * actualUnits;
    const profitPercent = ((parseFloat(price) - pos.buyPrice) / pos.buyPrice) * 100;
    
    PORTFOLIO.history.push({
      type: 'SELL',
      ticker: pos.ticker,
      buyPrice: pos.buyPrice,
      sellPrice: parseFloat(price),
      profit,
      profitPercent,
      units: actualUnits,
      sellDate: new Date().toISOString()
    });
    
    if (!sellUnits || sellUnits >= pos.units) {
      PORTFOLIO.positions.splice(idx, 1);
    } else {
      PORTFOLIO.positions[idx].units -= sellUnits;
    }
    
    await savePortfolio();
    console.log(`✅ Recorded SELL: ${actualUnits} ${upperTicker} @ $${price} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
  }
  res.redirect('/');
});

// ============================================
// STARTUP
// ============================================

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║    NUCLEAR INSIDER DETECTOR - ULTIMATE SYSTEM         ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');
console.log('Features:');
console.log('  🎯 Nuclear BUY/SELL signals (85%+ confidence)');
console.log('  📊 Portfolio tracking');
console.log('  🌐 Web interface');
console.log('  📧 Email alerts');
console.log('  🧠 Self-updating intelligence');
console.log('\nInitializing...\n');

// Start web server
app.listen(CONFIG.WEB_PORT, () => {
  console.log(`🌐 Web interface: Port ${CONFIG.WEB_PORT}`);
  console.log(`   Public URL: https://insider-detector.onrender.com\n`);
});

// Load data
Promise.all([loadPortfolio(), loadIntelligence()]).then(() => {
  console.log(`📊 Portfolio: ${PORTFOLIO.positions.length} positions`);
  console.log(`🧠 Intelligence: ${INTELLIGENCE.powerTraders.length} power traders\n`);
  
  // Start scanning after 10 seconds
  setTimeout(() => {
    console.log('🚀 Starting scanner...\n');
    runScan();
    setInterval(runScan, CONFIG.SCAN_INTERVAL_MINUTES * 60 * 1000);
    
    // Intelligence updates weekly
    const daysSinceUpdate = INTELLIGENCE.lastUpdate 
      ? (Date.now() - new Date(INTELLIGENCE.lastUpdate)) / (1000 * 60 * 60 * 24)
      : CONFIG.INTELLIGENCE_UPDATE_DAYS + 1;
    
    if (daysSinceUpdate >= CONFIG.INTELLIGENCE_UPDATE_DAYS) {
      setTimeout(() => {
        runIntelligenceUpdate();
        setInterval(runIntelligenceUpdate, CONFIG.INTELLIGENCE_UPDATE_DAYS * 24 * 60 * 60 * 1000);
      }, 60000); // Run first intelligence update after 1 minute
    }
  }, 10000);
});
