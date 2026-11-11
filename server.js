"use strict";
/* Chloe 2 server. No dependencies. Needs Node 18+ (global fetch).
   Environment variables (set them in Render, never in the code):
   TWELVE_KEY, FRED_KEY, FINNHUB_KEY, AV_KEY (optional), LLM_KEY,
   UPSTASH_URL, UPSTASH_TOKEN, ACCESS_KEY (recommended),
   LLM_PROVIDER (gemini | anthropic, default gemini), LLM_MODEL (optional for gemini, required for anthropic).
   Auto trading (optional): METAAPI_TOKEN, METAAPI_ACCOUNT_ID, METAAPI_REGION (default new-york), SYMBOL_SUFFIX, NAS_SYMBOL, MAX_LOT (default 0.05), MAX_POSITIONS (default 3) */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const E = process.env;
const PORT = E.PORT || 3000;
const MIME = { ".html": "text/html; charset=utf-8" };

/* ---------- helpers ---------- */
const mem = new Map();
async function cached(key, ttl, fn) {
  const h = mem.get(key);
  if (h && Date.now() - h.at < ttl) return h.v;
  const v = await fn();
  mem.set(key, { at: Date.now(), v });
  if (mem.size > 400) mem.delete(mem.keys().next().value);
  return v;
}
async function getJson(url, opts) {
  const host = new URL(url).host;
  let r;
  try { r = await fetch(url, opts); } catch { throw new Error(`Could not reach ${host}`); }
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { throw new Error(`Unreadable reply from ${host} (HTTP ${r.status})`); }
  if (!r.ok && j && !j.message && !j.error) throw new Error(`${host} answered HTTP ${r.status}`);
  return j;
}
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const need = (name) => { if (!E[name]) throw new Error(`${name} is not set on the server`); return E[name]; };
const same = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("Request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(new Error("Bad JSON body")); } });
    req.on("error", reject);
  });
}

/* ---------- candles: Twelve Data ---------- */
const SYMBOLS = new Set(["XAU/USD", "USD/JPY", "GBP/USD", "BTC/USD", "QQQ", "UUP"]);
const INTERVALS = new Set(["15min", "1h", "4h", "1day"]);
function series(symbol, interval, size) {
  if (!SYMBOLS.has(symbol) || !INTERVALS.has(interval)) throw new Error("Unsupported symbol or interval");
  size = Math.min(Math.max(+size || 100, 30), 300);
  return cached(`s|${symbol}|${interval}|${size}`, 300000, async () => {
    const j = await getJson(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}&apikey=${need("TWELVE_KEY")}`);
    if (j.status === "error" || !Array.isArray(j.values)) throw new Error(String(j.message || "Twelve Data returned no candles").slice(0, 160));
    return j.values.map(r => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter(x => [x.o, x.h, x.l, x.c].every(Number.isFinite)).reverse();
  });
}

/* ---------- macro: FRED ---------- */
const FRED = { dgs10: ["DGS10", 40], dfii10: ["DFII10", 40], ff: ["FEDFUNDS", 40], cpi: ["CPIAUCSL", 40], nfp: ["PAYEMS", 40] };
function macro() {
  return cached("macro", 3 * 3600000, async () => {
    const key = need("FRED_KEY"), out = {};
    await Promise.all(Object.entries(FRED).map(async ([name, [id, limit]]) => {
      const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`);
      if (!Array.isArray(j.observations)) throw new Error(String(j.error_message || `FRED had no data for ${id}`).slice(0, 160));
      out[name] = j.observations.map(o => ({ date: o.date, v: parseFloat(o.value) })).filter(o => Number.isFinite(o.v));
    }));
    return out;
  });
}

/* ---------- COT: CFTC public data (speculator positioning) ---------- */
const COT = {
  XAUUSD: { kw: "GOLD", pick: [/^GOLD - COMMODITY EXCHANGE/, /^GOLD/] },
  USDJPY: { kw: "JAPANESE YEN", pick: [/^JAPANESE YEN - CHICAGO MERCANTILE/, /^JAPANESE YEN/] },
  GBPUSD: { kw: "BRITISH POUND", pick: [/^BRITISH POUND - CHICAGO MERCANTILE/, /^BRITISH POUND/] },
  BTCUSD: { kw: "BITCOIN", pick: [/^BITCOIN - CHICAGO MERCANTILE/, /^BITCOIN/] },
  NASDAQ: { kw: "NASDAQ", pick: [/^NASDAQ MINI/, /^NASDAQ-100 STOCK INDEX \(MINI\)/, /^NASDAQ/] }
};
const CFTC = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
function cot(pair) {
  const c = COT[pair]; if (!c) throw new Error("No COT mapping for that pair");
  return cached("cot|" + pair, 6 * 3600000, async () => {
    const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10) + "T00:00:00.000";
    const q1 = `${CFTC}?$select=${encodeURIComponent("market_and_exchange_names")}&$group=${encodeURIComponent("market_and_exchange_names")}&$where=${encodeURIComponent(`upper(market_and_exchange_names) like '%${c.kw}%' AND report_date_as_yyyy_mm_dd > '${since}'`)}&$limit=60`;
    const names = await getJson(q1);
    if (!Array.isArray(names) || !names.length) throw new Error("CFTC returned no matching market");
    const all = names.map(n => n.market_and_exchange_names);
    let name = null;
    for (const re of c.pick) { name = all.find(n => re.test(n) && !/MICRO|E-MICRO/.test(n)); if (name) break; }
    if (!name) name = all[0];
    const q2 = `${CFTC}?$select=${encodeURIComponent("report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all")}&$where=${encodeURIComponent(`market_and_exchange_names = '${name.replace(/'/g, "''")}'`)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=56`;
    const rows = await getJson(q2);
    if (!Array.isArray(rows) || rows.length < 8) throw new Error("Not enough COT history returned");
    const nets = rows.map(r => ({ d: String(r.report_date_as_yyyy_mm_dd).slice(0, 10), n: (+r.noncomm_positions_long_all) - (+r.noncomm_positions_short_all) })).filter(r => Number.isFinite(r.n));
    const vals = nets.map(r => r.n), lo = Math.min(...vals), hi = Math.max(...vals);
    return { market: name, date: nets[0].d, net: nets[0].n, pct: hi === lo ? 0.5 : (nets[0].n - lo) / (hi - lo), change4: nets[0].n - (nets[4] ? nets[4].n : nets[nets.length - 1].n), weeks: nets.length };
  });
}

/* ---------- options put/call ratio: Alpha Vantage (optional) ---------- */
const OPT_SYMBOLS = new Set(["GLD", "QQQ", "IBIT", "UUP"]);
function options(symbol) {
  if (!OPT_SYMBOLS.has(symbol)) throw new Error("Unsupported options symbol");
  return cached("opt|" + symbol, 900000, async () => {
    const j = await getJson(`https://www.alphavantage.co/query?function=REALTIME_PUT_CALL_RATIO&symbol=${symbol}&apikey=${need("AV_KEY")}`);
    const v = parseFloat(j.put_call_ratio_full_chain);
    if (!Number.isFinite(v)) throw new Error(String(j.Information || j.Note || j["Error Message"] || "No options data returned").slice(0, 160));
    return { symbol, pcr: v };
  });
}

/* ---------- AI model (Gemini free tier by default, or Anthropic) ---------- */
let geminiPick = null;
async function geminiModel() {
  if (E.LLM_MODEL) return E.LLM_MODEL;
  if (geminiPick && Date.now() - geminiPick.at < 86400000) return geminiPick.name;
  let name = "gemini-2.5-flash";
  try {
    const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${need("LLM_KEY")}`);
    const best = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /\/gemini-[\d.]+-flash$/.test(m.name))
      .map(m => ({ n: m.name.replace("models/", ""), v: parseFloat(m.name.match(/gemini-([\d.]+)-flash/)[1]) })).sort((a, b) => b.v - a.v)[0];
    if (best) name = best.n;
  } catch {}
  geminiPick = { at: Date.now(), name };
  return name;
}
async function llm(messages, { json = false, maxTokens = 1200 } = {}) {
  const key = need("LLM_KEY"), prov = (E.LLM_PROVIDER || "gemini").toLowerCase();
  if (prov === "anthropic") {
    const model = need("LLM_MODEL");
    const j = await getJson("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, messages }) });
    if (j.error) throw new Error(String(j.error.message || "Anthropic error").slice(0, 200));
    return (j.content || []).map(b => b.text || "").join("");
  }
  const model = await geminiModel();
  const body = { contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048), temperature: 0.4 } };
  if (json) body.generationConfig.responseMimeType = "application/json";
  const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (j.error) throw new Error(/quota|rate|exhaust/i.test(j.error.message || "") ? "The free AI limit was reached. Wait a minute and try again." : String(j.error.message || "AI error").slice(0, 200));
  const text = ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) throw new Error("The AI returned no text");
  return text;
}
function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const m = String(t).match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* ---------- news tone: Finnhub headlines scored by the AI ---------- */
const NAMES = { XAUUSD: "Gold (XAUUSD)", USDJPY: "the US dollar against the Japanese yen (USDJPY)", GBPUSD: "the British pound against the US dollar (GBPUSD)", BTCUSD: "Bitcoin (BTCUSD)", NASDAQ: "the Nasdaq-100 index" };
function sentiment(pair) {
  if (!NAMES[pair]) throw new Error("Unknown pair");
  return cached("sent|" + pair, 20 * 60000, async () => {
    const tok = need("FINNHUB_KEY");
    const cats = pair === "BTCUSD" ? ["crypto", "general"] : ["forex", "general"];
    const lists = await Promise.all(cats.map(c => getJson(`https://finnhub.io/api/v1/news?category=${c}&token=${tok}`).catch(() => [])));
    const seen = new Set(), heads = [];
    for (const it of lists.flatMap(l => Array.isArray(l) ? l.sort((a, b) => b.datetime - a.datetime).slice(0, 18) : [])) { if (it.headline && !seen.has(it.headline)) { seen.add(it.headline); heads.push(it); } }
    if (!heads.length) throw new Error("Finnhub returned no headlines");
    const out = { count: heads.length, headlines: heads.slice(0, 8).map(h => ({ t: h.headline, s: h.source })), score: null, reason: "" };
    if (!E.LLM_KEY) return out;
    const prompt = `You are a market news analyst. Instrument: ${NAMES[pair]}.\nHeadlines:\n${heads.map((h, i) => `${i + 1}. ${h.headline}`).join("\n")}\n\nScore how these headlines are likely to move the instrument over the next day: -1 very bearish, 0 neutral or irrelevant, +1 very bullish. Ignore headlines that do not matter to this instrument. Reply with only JSON: {"score":0,"reason":"one plain sentence under 25 words"}`;
    const j = parseLoose(await llm([{ role: "user", content: prompt }], { json: true, maxTokens: 400 }));
    if (j && Number.isFinite(+j.score)) { out.score = Math.max(-1, Math.min(1, +j.score)); out.reason = String(j.reason || "").slice(0, 200); }
    return out;
  });
}

/* ---------- trade log in Upstash (optional) ---------- */
async function upstash(cmd) {
  const j = await getJson(need("UPSTASH_URL"), { method: "POST", headers: { authorization: `Bearer ${need("UPSTASH_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
  if (j.error) throw new Error(String(j.error).slice(0, 160));
  return j.result;
}

/* ---------- economic calendar (Forex Factory weekly JSON, free, no key) ---------- */
const CAL_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"];
let calStale = null;
async function calendar() {
  try {
    const out = await cached("cal", 30 * 60000, async () => {
      const lists = await Promise.all(CAL_URLS.map((u, i) => getJson(u).catch(e => (i === 0 ? Promise.reject(e) : []))));
      const events = lists.flat().filter(x => x && x.title && x.date)
        .map(x => ({ title: String(x.title).slice(0, 80), cur: String(x.country || "").toUpperCase(), t: Date.parse(x.date), impact: String(x.impact || ""), forecast: String(x.forecast || ""), previous: String(x.previous || "") }))
        .filter(x => Number.isFinite(x.t) && ["USD", "GBP", "JPY"].includes(x.cur) && ["High", "Medium"].includes(x.impact))
        .sort((a, b) => a.t - b.t);
      if (!events.length) throw new Error("The calendar feed returned no events");
      return { events, fetched: Date.now(), stale: false };
    });
    calStale = out; return out;
  } catch (e) {
    if (calStale) return Object.assign({}, calStale, { stale: true });
    throw e;
  }
}

/* ---------- auto trading through MetaApi (optional) ---------- */
const MT_SYM = { XAUUSD: "XAUUSD", USDJPY: "USDJPY", GBPUSD: "GBPUSD", BTCUSD: "BTCUSD", NASDAQ: E.NAS_SYMBOL || "USTEC" };
const mtSymbol = pair => { if (!MT_SYM[pair]) throw new Error("Unknown pair"); return MT_SYM[pair] + (E.SYMBOL_SUFFIX || ""); };
const MAX_LOT = parseFloat(E.MAX_LOT) > 0 ? parseFloat(E.MAX_LOT) : 0.05;
const MAX_POS = parseInt(E.MAX_POSITIONS, 10) > 0 ? parseInt(E.MAX_POSITIONS, 10) : 3;
const mtReady = () => !!(E.METAAPI_TOKEN && E.METAAPI_ACCOUNT_ID);
async function mt(sub, body) {
  const base = `https://mt-client-api-v1.${E.METAAPI_REGION || "new-york"}.agiliumtrade.ai/users/current/accounts/${encodeURIComponent(need("METAAPI_ACCOUNT_ID"))}`;
  const j = await getJson(base + sub, { method: body ? "POST" : "GET", headers: { "auth-token": need("METAAPI_TOKEN"), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (j && typeof j.error === "string" && !j.stringCode) throw new Error(String(j.message || j.error).slice(0, 200));
  return j;
}
const tradeOk = r => r && ["TRADE_RETCODE_DONE", "TRADE_RETCODE_PLACED", "TRADE_RETCODE_DONE_PARTIAL"].includes(r.stringCode);
async function tradeStatus() {
  if (!mtReady()) return { configured: false };
  const [a, pos] = await Promise.all([mt("/account-information"), mt("/positions")]);
  return {
    configured: true,
    account: { login: a.login, server: a.server, name: a.name, balance: a.balance, equity: a.equity, currency: a.currency, leverage: a.leverage, mode: /DEMO/i.test(String(a.tradeMode || "")) ? "DEMO" : /REAL/i.test(String(a.tradeMode || "")) ? "REAL" : "UNKNOWN" },
    positions: (Array.isArray(pos) ? pos : []).map(p => ({ id: String(p.id), symbol: p.symbol, type: String(p.type || "").replace("POSITION_TYPE_", ""), volume: p.volume, open: p.openPrice, sl: p.stopLoss, tp: p.takeProfit, profit: p.profit, comment: p.comment || "" })),
    limits: { maxLot: MAX_LOT, maxPositions: MAX_POS }
  };
}
const recent = new Map();
async function placeOrder(b) {
  const side = String(b.side || "").toUpperCase(), symbol = mtSymbol(b.pair), vol = Math.round(parseFloat(b.volume) * 100) / 100, sl = parseFloat(b.sl), tp = parseFloat(b.tp);
  if (b.pair === "NASDAQ") throw new Error("Nasdaq has no lot sizing yet, so it is switched off for auto trading");
  if (!["BUY", "SELL"].includes(side)) throw new Error("Side must be BUY or SELL");
  if (!(vol >= 0.01)) throw new Error("Lot must be at least 0.01");
  if (vol > MAX_LOT) throw new Error(`Lot ${vol} is above the server cap of ${MAX_LOT}. Raise MAX_LOT in Render if you really want that.`);
  if (!(sl > 0) || !(tp > 0) || sl === tp) throw new Error("A stop loss and a take profit are required");
  const key = b.pair + side, last = recent.get(key);
  if (last && Date.now() - last < 15000) throw new Error("That order was just sent. Wait a few seconds.");
  recent.set(key, Date.now());
  const pos = await mt("/positions");
  const list = Array.isArray(pos) ? pos : [];
  if (list.length >= MAX_POS) throw new Error(`Already ${list.length} open trades (limit ${MAX_POS}).`);
  if (list.some(p => p.symbol === symbol)) throw new Error(`You already have an open ${symbol} trade.`);
  const r = await mt("/trade", { actionType: side === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL", symbol, volume: vol, stopLoss: +sl.toFixed(5), takeProfit: +tp.toFixed(5), comment: "Chloe2" });
  if (!tradeOk(r)) throw new Error(String(r && (r.message || r.stringCode) || "Broker refused the order").slice(0, 200));
  return { ok: true, symbol, side, volume: vol, orderId: r.orderId, positionId: r.positionId, message: r.message };
}
async function closePosition(id) {
  const r = await mt("/trade", { actionType: "POSITION_CLOSE_ID", positionId: String(id) });
  if (!tradeOk(r)) throw new Error(String(r && (r.message || r.stringCode) || "Broker refused the close").slice(0, 200));
  return { ok: true };
}

/* ---------- routes ---------- */
async function api(req, res, u) {
  const p = u.pathname, q = u.searchParams;
  if (p === "/api/status") {
    return send(res, 200, { locked: !!E.ACCESS_KEY, keys: { twelve: !!E.TWELVE_KEY, fred: !!E.FRED_KEY, finnhub: !!E.FINNHUB_KEY, av: !!E.AV_KEY, llm: !!E.LLM_KEY, upstash: !!(E.UPSTASH_URL && E.UPSTASH_TOKEN), trade: mtReady() }, provider: (E.LLM_PROVIDER || "gemini").toLowerCase() });
  }
  if (E.ACCESS_KEY && !same(req.headers["x-access"] || "", E.ACCESS_KEY)) return send(res, 401, { error: "locked" });
  if (p === "/api/ping") return send(res, 200, { ok: true });
  if (p === "/api/series") return send(res, 200, { rows: await series(q.get("symbol"), q.get("interval"), q.get("size")) });
  if (p === "/api/macro") return send(res, 200, await macro());
  if (p === "/api/cot") return send(res, 200, await cot(q.get("pair")));
  if (p === "/api/options") return send(res, 200, await options(q.get("symbol")));
  if (p === "/api/sentiment") return send(res, 200, await sentiment(q.get("pair")));
  if (p === "/api/calendar") return send(res, 200, await calendar());
  if (p === "/api/trade/status") return send(res, 200, await tradeStatus());
  if (p === "/api/trade/order" && req.method === "POST") return send(res, 200, await placeOrder(await readBody(req)));
  if (p === "/api/trade/close" && req.method === "POST") { const b = await readBody(req); if (!b.id) throw new Error("No position id"); return send(res, 200, await closePosition(b.id)); }
  if (p === "/api/trade/closeall" && req.method === "POST") {
    const pos = await mt("/positions"); let n = 0, fail = 0;
    for (const x of (Array.isArray(pos) ? pos : [])) { try { await closePosition(x.id); n++; } catch { fail++; } }
    return send(res, 200, { ok: fail === 0, closed: n, failed: fail });
  }
  if (p === "/api/llm" && req.method === "POST") {
    const b = await readBody(req), m = b.messages;
    if (!Array.isArray(m) || !m.length || m.length > 24 || m.some(x => !x || !["user", "assistant"].includes(x.role) || typeof x.content !== "string" || x.content.length > 14000)) throw new Error("Bad messages");
    return send(res, 200, { text: await llm(m, { json: !!b.json, maxTokens: Math.min(+b.maxTokens || 1200, 3000) }) });
  }
  if (p === "/api/log") {
    if (req.method === "GET") { const r = await upstash(["GET", "chloe2:log"]); let log = []; try { log = r ? JSON.parse(r) : []; } catch {} return send(res, 200, { log }); }
    if (req.method === "PUT") { const b = await readBody(req, 400000); if (!Array.isArray(b.log)) throw new Error("Bad log"); await upstash(["SET", "chloe2:log", JSON.stringify(b.log.slice(0, 300))]); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: "Not found" });
}

function serveStatic(res, p) {
  if (p !== "/" && p !== "/index.html") return send(res, 404, "Not found", "text/plain");
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) return send(res, 404, "index.html is missing from the repo", "text/plain");
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/health") return send(res, 200, "ok", "text/plain");
    if (u.pathname.startsWith("/api/")) return await api(req, res, u);
    return serveStatic(res, u.pathname);
  } catch (e) {
    send(res, 502, { error: String(e && e.message || e).slice(0, 240) });
  }
}).listen(PORT, () => console.log("Chloe 2 listening on " + PORT));
