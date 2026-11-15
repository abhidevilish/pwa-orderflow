// app.js
const SYMBOL = 'btcusdc';
const WS_URL = `wss://fstream.binance.com/market/ws/${SYMBOL}@aggTrade`;
const CANDLE_INTERVAL_MS = 5 * 60 * 1000;
const WHALE_NOTIONAL = 100000;
const MAX_HISTORY_ROWS = 20;

let socket = null;
let shouldReconnect = false;
let reconnectTimer = null;
let connectedAt = 0;
const candles = new Map();
let currentCandleStart = 0;

// DOM refs
const $ = id => document.getElementById(id);
const statusEl = $('status');
const startEl = $('startTime');
const cvdEl = $('cvd');
const tradeEl = $('tradeCount');
const whaleEl = $('whaleCount');
const vwapEl = $('vwap');
const historyEl = $('history');

// Helpers
const roundQty = num => Math.round((num + Number.EPSILON) * 1e8) / 1e8;
const getCandleStart = ts => Math.floor(ts / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
const formatTime = ms => new Date(ms).toLocaleTimeString([], { hour12: false });
const fmtCvd = v => (v >= 0 ? '+' : '') + v.toFixed(3);

function clearHistory() {
  historyEl.innerHTML = '';   // remove closed-candle rows
  candles.clear();            // drop stored candle data
  currentCandleStart = 0;     // so the next connect starts fresh

  // reset the current-candle display
  startEl.textContent = '--';
  cvdEl.textContent = '--';
  cvdEl.className = 'value';
  tradeEl.textContent = '--';
  whaleEl.textContent = '--';
  vwapEl.textContent = '--';
};

function metrics(c) {
  return {
    cvd: c.buyVol - c.sellVol,
    vwap: c.totalVolume > 0 ? c.totalNotional / c.totalVolume : 0
  };
}

// A candle is partial if we joined it late or lost the connection during it
function markCurrentPartial() {
  const c = candles.get(currentCandleStart);
  if (c) c.partial = true;
}

function renderCurrent() {
  const c = candles.get(currentCandleStart);
  if (!c) return;
  const { cvd, vwap } = metrics(c);

  startEl.textContent = c.startStr + (c.partial ? ' *' : '');
  cvdEl.textContent = fmtCvd(cvd);
  cvdEl.className = 'value ' + (cvd >= 0 ? 'pos' : 'neg');
  tradeEl.textContent = c.tradesCount.toLocaleString();
  whaleEl.textContent = c.whaleCount.toLocaleString();
  vwapEl.textContent = '$' + vwap.toFixed(2);
}

function onCandleClose(closedStartMs) {
  const c = candles.get(closedStartMs);
  if (!c) return;
  const { cvd, vwap } = metrics(c);

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${c.startStr}${c.partial ? ' *' : ''}</td>
    <td class="${cvd >= 0 ? 'pos' : 'neg'}">${fmtCvd(cvd)}</td>
    <td>${c.tradesCount}</td>
    <td>${c.whaleCount}</td>
    <td>$${vwap.toFixed(2)}</td>`;
  historyEl.prepend(tr);
  while (historyEl.children.length > MAX_HISTORY_ROWS) historyEl.lastChild.remove();

  for (const key of candles.keys()) {
    if (key <= closedStartMs) candles.delete(key);
  }
}

function handleTrade(trade) {
  if (!trade.p || !trade.q || !trade.T) return; // ignore non-trade messages

  const price = parseFloat(trade.p);
  const qty = parseFloat(trade.q);
  const notional = price * qty;
  const isMarketBuy = !trade.m; // m === false means aggressive buy
  const isWhale = notional >= WHALE_NOTIONAL;

  const candleStart = getCandleStart(trade.T);

  // Late trade belonging to a candle we already closed: ignore it
  if (candleStart < currentCandleStart) return;

  if (currentCandleStart !== 0 && candleStart > currentCandleStart) {
    onCandleClose(currentCandleStart);
  }
  currentCandleStart = candleStart;

  if (!candles.has(candleStart)) {
    candles.set(candleStart, {
      startStr: formatTime(candleStart),
      partial: connectedAt > candleStart, // connected after the candle began
      buyVol: 0,
      sellVol: 0,
      totalNotional: 0,
      totalVolume: 0,
      tradesCount: 0,
      whaleCount: 0
    });
  }

  const c = candles.get(candleStart);
  c.totalNotional += notional;
  c.totalVolume = roundQty(c.totalVolume + qty);
  c.tradesCount += 1;

  if (isMarketBuy) c.buyVol = roundQty(c.buyVol + qty);
  else c.sellVol = roundQty(c.sellVol + qty);

  if (isWhale) c.whaleCount++;
}

const connect = () => {
  if (socket && socket.readyState <= 1) return; // already connecting or open
  clearTimeout(reconnectTimer);
  shouldReconnect = true;

  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    statusEl.textContent = 'connected';
    connectedAt = Date.now();
    markCurrentPartial(); // there may have been a gap before this
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return; // ignore stale sockets
    try {
      handleTrade(JSON.parse(event.data));
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  };

  ws.onerror = (error) => console.log('error', error);

  ws.onclose = () => {
    if (socket !== ws) return;
    statusEl.textContent = 'disconnected';
    markCurrentPartial();
    if (shouldReconnect) reconnectTimer = setTimeout(connect, 2000);
  };
};

const disconnect = () => {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  if (socket) socket.close();
  clearHistory();
};

// Re-render 4x per second instead of on every trade
setInterval(renderCurrent, 250);

// No auto-connect: use the Connect button