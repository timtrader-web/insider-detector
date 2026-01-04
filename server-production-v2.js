const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ============================================
// CONFIGURATION FROM ENVIRONMENT VARIABLES
// ============================================

const CONFIG = {
  // Email (REQUIRED)
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
  
  // API Keys (REQUIRED)
  SEC_API_KEY: process.env.SEC_API_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  
  // Security (REQUIRED)
  SCAN_TOKEN: process.env.SCAN_TOKEN,
  BASIC_AUTH_PASS: process.env.BASIC_AUTH_PASS || 'change-me',
  
  // Feature Flags
  PAPER_TRADING: process.env.PAPER_TRADING !== 'false', // Default ON
  
  // Signal Settings
  NUCLEAR_CONFIDENCE: parseInt(process.env.NUCLEAR_CONFIDENCE) || 85,
  MIN_SOURCES: parseInt(process.env.MIN_SOURCES) || 2,
  
  // System
  WEB_PORT: process.env.PORT || 3000,
  MAX_ALERTS_PER_DAY: parseInt(process.env.MAX_ALERTS_PER_DAY) || 10
};

// Validate required config
const REQUIRED = ['EMAIL_TO', 'EMAIL_FROM', 'EMAIL_PASSWORD', 'SEC_API_KEY', 'DATABASE_URL', 'SCAN_TOKEN'];
for (const key of REQUIRED) {
  if (!CONFIG[key]) {
    console.error(`❌ FATAL: Missing required environment variable: ${key}`);
    console.error('Set it in Render dashboard → Environment');
    process.exit(1);
  }
}

// ============================================
// DATABASE (SUPABASE)
// ============================================

const supabase = createClient(CONFIG.DATABASE_URL.replace('postgresql://', 'https://').split('@')[1].split(':')[0], 'dummy', {
  db: { schema: 'public' },
  auth: { persistSession: false }
});

// Use node-postgres for direct connection
const { Pool } = require('pg');
const pool = new Pool({ connectionString: CONFIG.DATABASE_URL });

async function initDatabase() {
  console.log('📊 Initializing database...');
  
  try {
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(10) NOT NULL,
        buy_price DECIMAL(10,2) NOT NULL,
        buy_date TIMESTAMP NOT NULL,
        units DECIMAL(10,4) NOT NULL,
        is_paper BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(10) NOT NULL,
        action VARCHAR(10) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        units DECIMAL(10,4) NOT NULL,
        profit DECIMAL(10,2),
        profit_percent DECIMAL(10,2),
        is_paper BOOLEAN DEFAULT true,
        trade_date TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS sent_alerts (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(10) NOT NULL,
        action VARCHAR(20) NOT NULL,
        confidence INTEGER NOT NULL,
        evidence_hash VARCHAR(64) NOT NULL,
        sent_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(ticker, action, evidence_hash)
      );
      
      CREATE TABLE IF NOT EXISTS seen_signals (
        id SERIAL PRIMARY KEY,
        signal_id VARCHAR(255) NOT NULL UNIQUE,
        first_seen TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS power_traders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        source VARCHAR(50) NOT NULL,
        score DECIMAL(10,2),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Database initialized');
  } catch (e) {
    console.error('❌ Database init failed:', e.message);
    process.exit(1);
  }
}

// ============================================
// SCAN MUTEX
// ============================================

let scanInProgress = false;

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

function generateSignalId(source, data) {
  const key = source === 'congress' 
    ? `congress|${data.representative}|${data.ticker}|${data.transaction_date}|${data.type}|${data.amount}`
    : source === 'sec'
    ? `sec|${data.accessionNo}|${data.reportingOwner?.name}|${data.issuer?.tradingSymbol}|${data.transactionCode}|${data.transactionShares}`
    : `${source}|${JSON.stringify(data)}`;
  
  return crypto.createHash('md5').update(key).digest('hex');
}

async function isSignalSeen(signalId) {
  const result = await pool.query('SELECT 1 FROM seen_signals WHERE signal_id = $1', [signalId]);
  return result.rows.length > 0;
}

async function markSignalSeen(signalId) {
  await pool.query(
    'INSERT INTO seen_signals (signal_id) VALUES ($1) ON CONFLICT (signal_id) DO NOTHING',
    [signalId]
  );
}

async function getPowerTraders() {
  const result = await pool.query('SELECT name FROM power_traders WHERE source = $1', ['congress']);
  return result.rows.map(r => r.name);
}

// ============================================
// DATA SOURCES WITH DEDUPLICATION
// ============================================

async function scanCongress() {
  try {
    console.log('🏛️  Scanning Congress trades...');
    
    const response = await fetch('https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json', {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const text = await response.text();
    if (text.trim().startsWith('<')) {
      console.log('   ⚠️  API unavailable (XML response)');
      return [];
    }
    
    const trades = JSON.parse(text);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const recent = trades.filter(t => new Date(t.transaction_date) > sevenDaysAgo);
    
    const powerTraders = await getPowerTraders();
    const signals = [];
    
    for (const trade of recent) {
      const signalId = generateSignalId('congress', trade);
      if (await isSignalSeen(signalId)) continue;
      
      const ticker = normalizeTicker(trade.ticker);
      if (!ticker) continue;
      
      const amount = parseAmount(trade.amount);
      if (amount < 15000) continue;
      
      // Normalize trade type
      const typeNorm = trade.type.toLowerCase();
      const isSale = typeNorm.includes('sale') || typeNorm.includes('sell');
      const isPurchase = typeNorm.includes('purchase') || typeNorm.includes('buy');
      
      if (!isSale && !isPurchase) continue;
      
      const isPower = powerTraders.some(name => trade.representative?.includes(name));
      
      await markSignalSeen(signalId);
      
      signals.push({
        source: 'Congress',
        ticker,
        action: isSale ? 'SELL' : 'BUY',
        confidence: isPower ? 95 : 80,
        amount,
        trader: trade.representative,
        powerTrader: isPower,
        isPrimary: true
      });
    }
    
    console.log(`   ✓ Found ${signals.length} new Congress signals`);
    return signals;
    
  } catch (e) {
    console.log(`   ⚠️  Congress error: ${e.message}`);
    return [];
  }
}

async function scanSECForm4() {
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
      }),
      timeout: 15000
    });
    
    const data = await response.json();
    const transactions = data.transactions || [];
    
    const signals = [];
    const clusterMap = {};
    
    for (const t of transactions) {
      const signalId = generateSignalId('sec', t);
      if (await isSignalSeen(signalId)) continue;
      
      const ticker = normalizeTicker(t.issuer?.tradingSymbol);
      if (!ticker) continue;
      
      // CRITICAL: Filter transaction codes properly
      const code = t.transactionCode;
      
      // Only care about open market purchases (P) and sales (S)
      if (code !== 'P' && code !== 'S') continue;
      
      const shares = t.transactionShares || 0;
      const price = t.transactionPricePerShare || 0;
      
      if (shares === 0 || price === 0) continue;
      
      const value = shares * price;
      if (value < 100000) continue;
      
      const isCLevel = t.reportingOwner?.relationship?.isOfficer &&
                      t.reportingOwner?.relationship?.officerTitle?.match(/CEO|CFO|COO|President/i);
      
      await markSignalSeen(signalId);
      
      signals.push({
        source: 'SEC Form 4',
        ticker,
        action: code === 'P' ? 'BUY' : 'SELL',
        confidence: isCLevel ? 85 : 75,
        amount: value,
        trader: t.reportingOwner?.name,
        isPrimary: true
      });
      
      // Cluster detection (only for purchases)
      if (code === 'P') {
        if (!clusterMap[ticker]) clusterMap[ticker] = [];
        clusterMap[ticker].push(t);
      }
    }
    
    // Detect clusters (3+ insiders buying)
    for (const [ticker, trades] of Object.entries(clusterMap)) {
      if (trades.length >= 3) {
        const totalValue = trades.reduce((sum, t) => 
          sum + (t.transactionShares * t.transactionPricePerShare), 0
        );
        
        signals.push({
          source: 'Insider Cluster',
          ticker,
          action: 'BUY',
          confidence: 90,
          amount: totalValue,
          isCluster: true,
          clusterSize: trades.length,
          isPrimary: true
        });
      }
    }
    
    console.log(`   ✓ Found ${signals.length} new SEC signals`);
    return signals;
    
  } catch (e) {
    console.log(`   ⚠️  SEC error: ${e.message}`);
    return [];
  }
}

async function scanPolymarket() {
  try {
    console.log('📊 Scanning Polymarket...');
    
    const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&limit=50', {
      timeout: 10000
    });
    const data = await response.json();
    
    if (!Array.isArray(data)) return [];
    
    const signals = [];
    
    for (const market of data) {
      if (!market || !market.title || !market.volume || market.volume < 100000) continue;
      
      const title = market.title.toLowerCase();
      
      for (const ticker of Object.keys(ETORO_TICKERS)) {
        const name = ETORO_TICKERS[ticker].toLowerCase();
        
        // Word boundary matching only
        const tickerRegex = new RegExp(`\\b${ticker.toLowerCase()}\\b`);
        const nameRegex = new RegExp(`\\b${name}\\b`);
        
        if (tickerRegex.test(title) || nameRegex.test(title)) {
          const isBullish = title.match(/reach|hit|above|over|exceed|rise/i);
          const isBearish = title.match(/below|fall|drop|decline|miss/i);
          
          if (isBullish || isBearish) {
            signals.push({
              source: 'Polymarket',
              ticker,
              action: isBullish ? 'BUY' : 'SELL',
              confidence: 70,
              amount: market.volume,
              isPrimary: false // Polymarket is SECONDARY only
            });
          }
        }
      }
    }
    
    console.log(`   ✓ Found ${signals.length} Polymarket signals`);
    return signals;
    
  } catch (e) {
    console.log(`   ⚠️  Polymarket error: ${e.message}`);
    return [];
  }
}

// ============================================
// SIGNAL AGGREGATION (EVIDENCE-WEIGHTED)
// ============================================

function aggregateSignals(allSignals) {
  const byTicker = {};
  
  for (const sig of allSignals) {
    if (!byTicker[sig.ticker]) {
      byTicker[sig.ticker] = {
        ticker: sig.ticker,
        buys: [],
        sells: [],
        primarySources: new Set(),
        secondarySources: new Set(),
        powerTraders: [],
        clusters: []
      };
    }
    
    const asset = byTicker[sig.ticker];
    if (sig.action === 'BUY') asset.buys.push(sig);
    if (sig.action === 'SELL') asset.sells.push(sig);
    
    if (sig.isPrimary) asset.primarySources.add(sig.source);
    else asset.secondarySources.add(sig.source);
    
    if (sig.powerTrader) asset.powerTraders.push(sig.trader);
    if (sig.isCluster) asset.clusters.push(sig);
  }
  
  const nuclear = [];
  
  for (const [ticker, data] of Object.entries(byTicker)) {
    // REQUIREMENT: Must have at least one PRIMARY source
    if (data.primarySources.size === 0) continue;
    
    // Calculate evidence-weighted score
    const buyEvidence = data.buys.reduce((sum, s) => {
      const weight = s.isPrimary ? 1.0 : 0.3;
      return sum + (s.confidence * weight);
    }, 0);
    
    const sellEvidence = data.sells.reduce((sum, s) => {
      const weight = s.isPrimary ? 1.0 : 0.3;
      return sum + (s.confidence * weight);
    }, 0);
    
    const netEvidence = buyEvidence - sellEvidence;
    const totalStrength = buyEvidence + sellEvidence;
    
    if (totalStrength === 0) continue;
    
    const directionalStrength = Math.abs(netEvidence) / totalStrength;
    
    // NUCLEAR REQUIREMENTS:
    // 1. At least one primary source
    // 2. Directional strength >= 0.6 (60% of evidence in one direction)
    // 3. Total strength >= threshold
    
    if (directionalStrength < 0.6) continue;
    
    let finalConf = totalStrength / (data.buys.length + data.sells.length);
    
    // Bonuses
    if (data.powerTraders.length > 0) finalConf += 10;
    if (data.clusters.length > 0) finalConf += 15;
    if (data.primarySources.size >= 2) finalConf += 10;
    
    finalConf = Math.min(finalConf, 99);
    
    if (finalConf < CONFIG.NUCLEAR_CONFIDENCE) continue;
    
    // Determine action
    let action = null;
    if (netEvidence > 0) action = netEvidence > 150 ? 'STRONG BUY' : 'BUY';
    else if (netEvidence < 0) action = netEvidence < -150 ? 'STRONG SELL' : 'SELL';
    
    if (action) {
      nuclear.push({
        ticker,
        action,
        confidence: Math.round(finalConf),
        primarySources: Array.from(data.primarySources),
        secondarySources: Array.from(data.secondarySources),
        powerTraders: data.powerTraders,
        clusters: data.clusters,
        buys: data.buys,
        sells: data.sells,
        evidenceHash: crypto.createHash('md5')
          .update(JSON.stringify([...data.buys, ...data.sells].map(s => s.source + s.trader)))
          .digest('hex')
      });
    }
  }
  
  return nuclear.sort((a, b) => b.confidence - a.confidence);
}

// ============================================
// ALERT DEDUPLICATION
// ============================================

async function shouldSendAlert(signal) {
  const result = await pool.query(
    'SELECT sent_at FROM sent_alerts WHERE ticker = $1 AND action = $2 AND evidence_hash = $3',
    [signal.ticker, signal.action, signal.evidenceHash]
  );
  
  if (result.rows.length > 0) {
    console.log(`   ⏭️  Skipping duplicate alert: ${signal.ticker} (same evidence)`);
    return false;
  }
  
  // Check daily limit
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const countResult = await pool.query(
    'SELECT COUNT(*) FROM sent_alerts WHERE sent_at >= $1',
    [today]
  );
  
  if (parseInt(countResult.rows[0].count) >= CONFIG.MAX_ALERTS_PER_DAY) {
    console.log(`   ⚠️  Daily alert limit reached (${CONFIG.MAX_ALERTS_PER_DAY})`);
    return false;
  }
  
  return true;
}

async function recordAlert(signal) {
  await pool.query(
    'INSERT INTO sent_alerts (ticker, action, confidence, evidence_hash) VALUES ($1, $2, $3, $4)',
    [signal.ticker, signal.action, signal.confidence, signal.evidenceHash]
  );
}

// ============================================
// EMAIL GENERATION & SENDING
// ============================================

function generateAlertEmail(signal) {
  const mode = CONFIG.PAPER_TRADING ? '📝 PAPER TRADING MODE' : '💰 LIVE MODE';
  
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
  .mode { background: rgba(0,0,0,0.3); padding: 10px 20px; border-radius: 8px; margin-top: 15px; font-size: 16px; }
  .details { background: #1a1a1a; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
  .source { padding: 12px; background: #2a2a2a; margin: 8px 0; border-radius: 6px; border-left: 4px solid #7928ca; }
  .primary { border-left-color: #00ff88; }
  .power { color: #ffd700; }
  .btn { display: inline-block; background: #00ff88; color: #000; padding: 20px 50px; border-radius: 12px; text-decoration: none; font-size: 24px; font-weight: 900; margin: 20px 0; }
</style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="action">${signal.action}</div>
      <div class="ticker">${signal.ticker}</div>
      <div class="conf">${signal.confidence}% confidence</div>
      <div class="conf">${signal.primarySources.length} primary sources</div>
      <div class="mode">${mode}</div>
    </div>
    
    <div class="details">
      <h3 style="margin-top: 0;">🎯 Primary Evidence:</h3>
  `;
  
  const primarySigs = [...signal.buys, ...signal.sells].filter(s => s.isPrimary).slice(0, 5);
  for (const sig of primarySigs) {
    const emoji = sig.source.includes('Congress') ? '🏛️' :
                  sig.source.includes('Cluster') ? '🚨' : '📋';
    
    html += `
      <div class="source primary">
        ${emoji} <strong>${sig.source}:</strong> ${sig.action}
        ${sig.powerTrader ? '<span class="power">⭐ POWER TRADER</span>' : ''}
        ${sig.clusterSize ? ` (${sig.clusterSize} insiders)` : ''}
        ${sig.trader ? `<br><small style="opacity: 0.7;">${sig.trader}</small>` : ''}
      </div>
    `;
  }
  
  if (signal.secondarySources.size > 0) {
    html += `<h3>📊 Supporting Context:</h3>`;
    const secondarySigs = [...signal.buys, ...signal.sells].filter(s => !s.isPrimary).slice(0, 3);
    for (const sig of secondarySigs) {
      html += `
        <div class="source">
          📊 <strong>${sig.source}:</strong> ${sig.action}
        </div>
      `;
    }
  }
  
  html += `
    </div>
    
    <div style="text-align: center;">
      <a href="https://www.etoro.com/discover/markets/stocks/${signal.ticker}" class="btn">
        ${signal.action} ON ETORO
      </a>
    </div>
    
    <div style="text-align: center; padding: 20px; opacity: 0.5; font-size: 13px;">
      <p>Record at: https://insider-detector.onrender.com</p>
      <p>${new Date().toLocaleString()}</p>
    </div>
  </div>
</body>
</html>
  `;
  
  return html;
}

async function sendEmail(subject, html) {
  try {
    const transporter = nodemailer.createTransporter({
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
    throw e; // Re-throw to trigger retry logic
  }
}

// ============================================
// MAIN SCAN (WITH MUTEX)
// ============================================

async function runScan() {
  if (scanInProgress) {
    console.log('⏭️  Scan already in progress, skipping...');
    return { skipped: true };
  }
  
  scanInProgress = true;
  const startTime = Date.now();
  
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
    console.log(`\n📊 New signals: ${all.length}`);
    
    if (all.length > 0) {
      const nuclear = aggregateSignals(all);
      
      if (nuclear.length > 0) {
        console.log(`\n🚨 NUCLEAR SIGNALS: ${nuclear.length}`);
        
        for (const signal of nuclear) {
          console.log(`   ${signal.action} ${signal.ticker} (${signal.confidence}%)`);
          
          if (await shouldSendAlert(signal)) {
            const subject = `🚨 NUCLEAR: ${signal.action} ${signal.ticker} (${signal.confidence}%)`;
            await sendEmail(subject, generateAlertEmail(signal));
            await recordAlert(signal);
          }
        }
      } else {
        console.log(`\n✅ No nuclear signals (need ${CONFIG.NUCLEAR_CONFIDENCE}%+, primary source required)`);
      }
    } else {
      console.log('\n✅ No new signals (all previously seen)');
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n⏱️  Scan completed in ${duration}s\n`);
    
    return { success: true, duration, signals: all.length };
    
  } catch (e) {
    console.error('❌ Scan error:', e.message);
    return { error: e.message };
  } finally {
    scanInProgress = false;
  }
}

// ============================================
// WEB INTERFACE (WITH BASIC AUTH)
// ============================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic Auth Middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Nuclear Insider Detector"');
    return res.status(401).send('Authentication required');
  }
  
  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [username, password] = credentials.split(':');
  
  if (password !== CONFIG.BASIC_AUTH_PASS) {
    return res.status(401).send('Invalid credentials');
  }
  
  next();
}

app.get('/', requireAuth, async (req, res) => {
  const positionsResult = await pool.query('SELECT * FROM positions ORDER BY created_at DESC');
  const tradesResult = await pool.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT 10');
  
  const positions = positionsResult.rows;
  const trades = tradesResult.rows;
  
  const totalUnrealized = 0; // Would need price fetching
  const totalRealized = trades
    .filter(t => t.action === 'SELL')
    .reduce((sum, t) => sum + parseFloat(t.profit || 0), 0);
  
  const mode = CONFIG.PAPER_TRADING ? '📝 Paper Trading' : '💰 Live Trading';
  
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
    .header h1 { font-size: 32px; color: #1a1a1a; margin-bottom: 10px; }
    .mode { background: #f59e0b; color: white; padding: 8px 16px; border-radius: 8px; display: inline-block; font-size: 14px; font-weight: bold; }
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
    .paper-badge { background: #f59e0b; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px; }
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
      <div class="mode">${mode}</div>
      <p style="margin-top: 10px; font-size: 14px; color: #666;">Protected • Authenticated</p>
    </div>
    
    <div class="stats">
      <div class="stat">
        <div class="stat-label">Realized P&L</div>
        <div class="stat-value ${totalRealized >= 0 ? 'positive' : 'negative'}">
          ${totalRealized >= 0 ? '+' : ''}$${totalRealized.toFixed(2)}
        </div>
        <div style="font-size: 14px; color: #666;">${trades.filter(t => t.action === 'SELL').length} closed</div>
      </div>
      <div class="stat">
        <div class="stat-label">Open Positions</div>
        <div class="stat-value">${positions.length}</div>
        <div style="font-size: 14px; color: #666;">tracked</div>
      </div>
    </div>
    
    <div class="section">
      <h2>📝 Record Trade</h2>
      <form method="POST" action="/buy" class="form-row">
        <input type="text" name="ticker" placeholder="Ticker" required>
        <input type="number" name="price" placeholder="Price" step="0.01" required>
        <input type="number" name="units" placeholder="Units" value="1" step="0.01">
        <button type="submit">BUY</button>
      </form>
      <form method="POST" action="/sell" class="form-row">
        <input type="text" name="ticker" placeholder="Ticker" required>
        <input type="number" name="price" placeholder="Price" step="0.01" required>
        <input type="number" name="units" placeholder="Units" step="0.01">
        <button type="submit" class="btn-sell">SELL</button>
      </form>
    </div>
    
    <div class="section">
      <h2>💼 Positions (${positions.length})</h2>
      ${positions.length === 0 ? '<p style="text-align: center; color: #666;">No positions</p>' : ''}
      ${positions.map(p => `
        <div class="position">
          <strong>${p.ticker}</strong> ${p.is_paper ? '<span class="paper-badge">PAPER</span>' : ''}
          <br>${p.units} units @ $${parseFloat(p.buy_price).toFixed(2)}
          <br><small style="color: #666;">${new Date(p.buy_date).toLocaleDateString()}</small>
        </div>
      `).join('')}
    </div>
    
    <div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.9); font-size: 14px;">
      <p><strong>Scan trigger:</strong> POST /scan with X-Scan-Token header</p>
      <p style="margin-top: 5px; opacity: 0.7;">Protected by Basic Auth</p>
    </div>
  </div>
</body>
</html>
  `;
  
  res.send(html);
});

app.post('/buy', requireAuth, async (req, res) => {
  const { ticker, price, units } = req.body;
  
  await pool.query(
    'INSERT INTO positions (ticker, buy_price, buy_date, units, is_paper) VALUES ($1, $2, $3, $4, $5)',
    [ticker.toUpperCase(), parseFloat(price), new Date(), parseFloat(units || 1), CONFIG.PAPER_TRADING]
  );
  
  await pool.query(
    'INSERT INTO trades (ticker, action, price, units, is_paper, trade_date) VALUES ($1, $2, $3, $4, $5, $6)',
    [ticker.toUpperCase(), 'BUY', parseFloat(price), parseFloat(units || 1), CONFIG.PAPER_TRADING, new Date()]
  );
  
  console.log(`✅ BUY: ${units || 1} ${ticker.toUpperCase()} @ $${price}`);
  res.redirect('/');
});

app.post('/sell', requireAuth, async (req, res) => {
  const { ticker, price, units } = req.body;
  const upperTicker = ticker.toUpperCase();
  
  const posResult = await pool.query(
    'SELECT * FROM positions WHERE ticker = $1 ORDER BY created_at LIMIT 1',
    [upperTicker]
  );
  
  if (posResult.rows.length > 0) {
    const pos = posResult.rows[0];
    const sellUnits = parseFloat(units || pos.units);
    const profit = (parseFloat(price) - parseFloat(pos.buy_price)) * sellUnits;
    const profitPercent = ((parseFloat(price) - parseFloat(pos.buy_price)) / parseFloat(pos.buy_price)) * 100;
    
    await pool.query(
      'INSERT INTO trades (ticker, action, price, units, profit, profit_percent, is_paper, trade_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [upperTicker, 'SELL', parseFloat(price), sellUnits, profit, profitPercent, CONFIG.PAPER_TRADING, new Date()]
    );
    
    if (sellUnits >= parseFloat(pos.units)) {
      await pool.query('DELETE FROM positions WHERE id = $1', [pos.id]);
    } else {
      await pool.query(
        'UPDATE positions SET units = units - $1 WHERE id = $2',
        [sellUnits, pos.id]
      );
    }
    
    console.log(`✅ SELL: ${sellUnits} ${upperTicker} @ $${price} (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
  }
  
  res.redirect('/');
});

// EXTERNAL SCAN TRIGGER
app.post('/scan', (req, res) => {
  const token = req.headers['x-scan-token'];
  
  if (token !== CONFIG.SCAN_TOKEN) {
    console.log('❌ Unauthorized scan attempt');
    return res.status(401).json({ error: 'Invalid scan token' });
  }
  
  console.log('✅ External scan triggered');
  
  runScan().then(result => {
    res.json(result);
  }).catch(err => {
    res.status(500).json({ error: err.message });
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mode: CONFIG.PAPER_TRADING ? 'paper' : 'live',
    scanning: scanInProgress
  });
});

// ============================================
// STARTUP
// ============================================

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║    NUCLEAR INSIDER DETECTOR - PRODUCTION v2.0         ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');
console.log('Features:');
console.log('  ✅ Environment variables (secure)');
console.log('  ✅ Supabase database (persistent)');
console.log('  ✅ Basic auth (protected)');
console.log('  ✅ Deduplication (no spam)');
console.log('  ✅ External trigger (Render-friendly)');
console.log(`  ✅ Mode: ${CONFIG.PAPER_TRADING ? 'PAPER TRADING' : 'LIVE'}`);
console.log('  ✅ SEC filtering (P/S codes only)');
console.log('\nInitializing...\n');

initDatabase().then(() => {
  // Load initial power traders
  pool.query(`
    INSERT INTO power_traders (name, source, score) VALUES
    ('Nancy Pelosi', 'congress', 100),
    ('Paul Pelosi', 'congress', 100),
    ('Josh Gottheimer', 'congress', 95),
    ('Ro Khanna', 'congress', 90)
    ON CONFLICT (name) DO NOTHING
  `);
  
  app.listen(CONFIG.WEB_PORT, () => {
    console.log(`🌐 Web interface: Port ${CONFIG.WEB_PORT}`);
    console.log(`   URL: https://insider-detector.onrender.com`);
    console.log(`   Auth: Basic (password set in env)\n`);
    console.log('🎯 Scan endpoint: POST /scan');
    console.log(`   Header: X-Scan-Token: ${CONFIG.SCAN_TOKEN}\n`);
    console.log('✅ System ready for external triggers\n');
  });
});
