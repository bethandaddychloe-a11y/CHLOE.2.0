"use strict";
/* Chloe 2 server. No dependencies. Needs Node 18+ (global fetch).
   Environment variables (set them in Render, never in the code):
   TWELVE_KEY, FRED_KEY, FINNHUB_KEY, AV_KEY (optional), LLM_KEY,
   UPSTASH_URL, UPSTASH_TOKEN, ACCESS_KEY (recommended),
   LLM_PROVIDER (gemini | anthropic, default gemini), LLM_MODEL (optional for gemini, required for anthropic).
   Scalping bot (optional): EA_KEY (any long secret; type the same one into the Expert Advisor).
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
const SYMBOLS = new Set(["XAU/USD", "USD/JPY", "BTC/USD", "QQQ", "UUP"]);
const INTERVALS = new Set(["15min", "1h", "4h", "1day"]);
function series(symbol, interval, size, tz) {
  if (!SYMBOLS.has(symbol) || !INTERVALS.has(interval)) throw new Error("Unsupported symbol or interval");
  size = Math.min(Math.max(+size || 100, 30), 500); const utc = tz === "UTC";
  return cached(`s|${symbol}|${interval}|${size}|${utc ? "u" : ""}`, 300000, async () => {
    const j = await getJson(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}${utc ? "&timezone=UTC" : ""}&apikey=${need("TWELVE_KEY")}`);
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
  BTCUSD: { kw: "BITCOIN", pick: [/^BITCOIN - CHICAGO MERCANTILE/, /^BITCOIN/] }
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
const SECRETS = ["TWELVE_KEY", "FRED_KEY", "FINNHUB_KEY", "AV_KEY", "LLM_KEY", "UPSTASH_URL", "UPSTASH_TOKEN", "METAAPI_TOKEN", "ACCESS_KEY", "EA_KEY"];
function scrub(msg) {
  let t = String(msg || "");
  for (const k of SECRETS) { const v = E[k]; if (v && v.length >= 6) t = t.split(v).join("***"); }
  return t.replace(/(api_?key|token|key)=[^&\s"']+/gi, "$1=***");
}
function options(symbol) {
  if (!OPT_SYMBOLS.has(symbol)) throw new Error("Unsupported options symbol");
  return cached("opt|" + symbol, 6 * 3600000, async () => {
    const j = await getJson(`https://www.alphavantage.co/query?function=REALTIME_PUT_CALL_RATIO&symbol=${symbol}&apikey=${need("AV_KEY")}`);
    const v = parseFloat(j.put_call_ratio_full_chain);
    if (!Number.isFinite(v)) { const m = String(j.Information || j.Note || j["Error Message"] || "No options data returned"); throw new Error(/rate limit|requests per day|premium|subscribe/i.test(m) ? "Options data is over its free daily limit" : scrub(m).slice(0, 120)); }
    return { symbol, pcr: v };
  });
}

/* ---------- AI model (Gemini free tier by default, or Anthropic) ---------- */
let geminiPick = null;
async function geminiModels() {
  if (geminiPick && Date.now() - geminiPick.at < 6 * 3600000) return geminiPick.list;
  let list = [];
  try {
    const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${need("LLM_KEY")}`);
    const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace("models/", ""));
    const ver = n => parseFloat((n.match(/gemini-([\d.]+)-flash/) || [0, 0])[1]);
    const full = ok.filter(n => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => ver(b) - ver(a)).slice(0, 3);
    const lite = ok.filter(n => /^gemini-[\d.]+-flash-lite$/.test(n)).sort((a, b) => ver(b) - ver(a)).slice(0, 2);
    list = [...full, ...lite];
  } catch {}
  if (!list.length) list = ["gemini-2.5-flash"];
  geminiPick = { at: Date.now(), list };
  return list;
}
async function llm(messages, { json = false, maxTokens = 1200, search = false, meta = null } = {}) {
  const key = need("LLM_KEY"), prov = (E.LLM_PROVIDER || "gemini").toLowerCase();
  if (prov === "anthropic") {
    const model = need("LLM_MODEL");
    const j = await getJson("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, messages }) });
    if (j.error) throw new Error(String(j.error.message || "Anthropic error").slice(0, 200));
    return (j.content || []).map(b => b.text || "").join("");
  }
  const models = [...new Set([...(E.LLM_MODEL ? [E.LLM_MODEL] : []), ...(await geminiModels())])];
  const base = { contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048), temperature: 0.4 } };
  const rawPost = body => model => getJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const post = async (model, body) => {
    /* switch off the slow "thinking" step where the model allows it; fall back if the model rejects the setting */
    const fast = JSON.parse(JSON.stringify(body)); fast.generationConfig.thinkingConfig = /gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
    try { const j = await rawPost(fast)(model); if (!(j.error && /thinking|invalid|unknown name/i.test(j.error.message || ""))) return j; } catch {}
    return rawPost(body)(model);
  };
  let lastMsg = "", quota = false;
  for (const model of models) {
    let j = null, searched = false;
    if (search) {
      const body = JSON.parse(JSON.stringify(base)); body.tools = [{ google_search: {} }]; body.generationConfig.maxOutputTokens = Math.max(maxTokens, 4096);
      try { j = await post(model, body); searched = !j.error; } catch (e) { lastMsg = e.message; }
    }
    if (!j || j.error) {
      const body = JSON.parse(JSON.stringify(base)); if (json) body.generationConfig.responseMimeType = "application/json";
      try { j = await post(model, body); } catch (e) { lastMsg = e.message; j = null; }
      if (search && meta) meta.searchFailed = true;
    }
    if (!j) continue;
    if (j.error) { const em = String(j.error.message || "AI error"); if (!/no longer available|not found|not supported/i.test(em) || !lastMsg) lastMsg = em; if (/quota|rate|exhaust/i.test(lastMsg)) quota = true; await new Promise(r => setTimeout(r, 800)); continue; }
    const cand = (j.candidates || [])[0], text = ((cand && cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    if (!text) { lastMsg = "The AI returned no text"; continue; }
    if (meta && searched) {
      const seen = new Set(); meta.sources = [];
      for (const c of ((cand.groundingMetadata || {}).groundingChunks || [])) { const w = c.web; if (w && w.uri && !seen.has(w.uri) && meta.sources.length < 5) { seen.add(w.uri); meta.sources.push({ title: String(w.title || w.uri).slice(0, 80), url: w.uri }); } }
    }
    return text;
  }
  throw new Error(quota ? "The free AI limit was reached. Wait a minute and try again." : /high demand|overload|unavailable/i.test(lastMsg) ? "Google's free AI is busy right now. Wait a minute and tap again." : String(lastMsg || "AI error").slice(0, 200));
}
function parseLoose(t) {
  try { return JSON.parse(t); } catch {}
  const m = String(t).match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* ---------- news tone: Finnhub headlines scored by the AI ---------- */
const NAMES = { XAUUSD: "Gold (XAUUSD)", USDJPY: "the US dollar against the Japanese yen (USDJPY)", BTCUSD: "Bitcoin (BTCUSD)" };
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

/* ---------- economic calendar: free weekly feed, saved copy, then AI web search as backup ---------- */
const FF_HOSTS = ["https://nfs.faireconomy.media", "https://cdn-nfs.faireconomy.media"];
const CAL_CUR = ["USD", "JPY"];
let calMem = null, calFFFail = 0;
function normEvents(list) {
  return (Array.isArray(list) ? list : []).filter(x => x && x.title && (x.date || x.time))
    .map(x => ({ title: String(x.title).slice(0, 80), cur: String(x.country || "").toUpperCase(), t: Date.parse(x.date || x.time), impact: /^high$/i.test(x.impact) ? "High" : /^medium$/i.test(x.impact) ? "Medium" : String(x.impact || ""), forecast: String(x.forecast || ""), previous: String(x.previous || "") }))
    .filter(x => Number.isFinite(x.t) && CAL_CUR.includes(x.cur) && ["High", "Medium"].includes(x.impact))
    .sort((a, b) => a.t - b.t);
}
async function fetchFF() {
  const wk = ["thisweek"]; if (new Date().getUTCDay() >= 4 || new Date().getUTCDay() === 0) wk.push("nextweek");
  let events = [], lastErr = "no answer";
  for (let i = 0; i < wk.length; i++) {
    let got = null;
    for (const h of FF_HOSTS) {
      try {
        const r = await fetch(`${h}/ff_calendar_${wk[i]}.json`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Chloe2/1.0)", accept: "application/json" } });
        if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
        const j = await r.json(); if (Array.isArray(j)) { got = j; break; }
      } catch (e) { lastErr = String(e && e.message || e); }
    }
    if (got) events = events.concat(normEvents(got)); else if (i === 0) throw new Error("Calendar feed: " + lastErr);
  }
  if (!events.length) throw new Error("Calendar feed returned no events");
  return events;
}

/* US release dates from FRED (dates only; Analyse finds forecasts) */
const FRED_REL = [
  [/Consumer Price Index/i, "CPI m/m", "High", [8, 30]], [/^Employment Situation/i, "Non-Farm Employment Change", "High", [8, 30]],
  [/Gross Domestic Product/i, "GDP q/q", "High", [8, 30]], [/Producer Price Index/i, "PPI m/m", "Medium", [8, 30]],
  [/Advance Monthly Sales for Retail/i, "Retail Sales m/m", "High", [8, 30]], [/Unemployment Insurance Weekly Claims/i, "Unemployment Claims", "Medium", [8, 30]],
  [/Personal Income and Outlays/i, "Core PCE Price Index m/m", "High", [8, 30]], [/FOMC Press Release/i, "FOMC Rate Decision", "High", [14, 0]]
];
function nyToUtc(ymd, h, m) {
  const [Y, M, D] = ymd.split("-").map(Number), fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
  for (const off of [4, 5]) { const t = Date.UTC(Y, M - 1, D, h + off, m); if (+fmt.format(t) === h) return t; }
  return Date.UTC(Y, M - 1, D, h + 5, m);
}
async function fredCalendar() {
  const today = new Date().toISOString().slice(0, 10);
  const j = await getJson(`https://api.stlouisfed.org/fred/releases/dates?api_key=${need("FRED_KEY")}&file_type=json&realtime_start=${today}&realtime_end=9999-12-31&include_release_dates_with_no_data=true&sort_order=asc&limit=400`);
  const out = [];
  for (const r of (j.release_dates || [])) {
    const rule = FRED_REL.find(x => x[0].test(r.release_name || "")); if (!rule || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const t = nyToUtc(r.date, rule[3][0], rule[3][1]);
    if (t > Date.now() - 3 * 3600000 && t < Date.now() + 10 * 86400000) out.push({ title: rule[1], cur: "USD", t, impact: rule[2], forecast: "", previous: "" });
  }
  if (!out.length) throw new Error("FRED returned no release dates");
  return out.sort((a, b) => a.t - b.t);
}
async function aiCalendar() {
  const now = new Date(), prompt = `You are an economic calendar researcher. Today is ${now.toUTCString()}.
Search the web for the high and medium impact economic events scheduled from now until 7 days ahead for the United States (USD) and Japan (JPY). Include inflation (CPI, PPI), jobs (payrolls, unemployment, jobless claims), central bank rate decisions and speeches (Fed, BOJ), GDP, retail sales and PMIs. Use the official or consensus release times.
Reply with only a JSON array, no markdown. Each item: {"title":"","country":"USD|JPY","impact":"High|Medium","time":"ISO 8601 UTC like 2026-11-12T13:30:00Z","forecast":"","previous":""}. Leave forecast or previous empty if unknown. Never invent an event you could not find.`;
  const meta = {}, text = await llm([{ role: "user", content: prompt }], { json: true, search: true, maxTokens: 4000, meta });
  const events = normEvents(parseLoose(text)).filter(x => x.t > Date.now() - 3 * 3600000 && x.t < Date.now() + 8 * 86400000);
  if (!events.length) throw new Error("The AI search found no events");
  return events;
}
async function calendar() {
  const now = Date.now();
  if (calMem && now - calMem.fetched < (calMem.source === "feed" ? 6 : calMem.source === "fred" ? 6 : 1) * 3600000 && calMem.events.some(x => x.t > now - 3 * 3600000)) return calMem;
  let why = "";
  if (now - calFFFail > 15 * 60000) {
    try { const events = await fetchFF(); calMem = { events, fetched: now, source: "feed", stale: false }; if (E.UPSTASH_URL && E.UPSTASH_TOKEN) upstash(["SET", "chloe2:cal", JSON.stringify(calMem)]).catch(() => {}); return calMem; }
    catch (e) { calFFFail = now; why = e.message; }
  }
  if (E.UPSTASH_URL && E.UPSTASH_TOKEN) {
    try { const r = await upstash(["GET", "chloe2:cal"]); const c = r ? JSON.parse(r) : null; if (c && c.events && now - c.fetched < 4 * 86400000 && c.events.some(x => x.t > now)) return Object.assign({}, c, { stale: true }); } catch {}
  }
  if (E.FRED_KEY) {
    try { const events = await fredCalendar(); calMem = { events, fetched: now, source: "fred", stale: false }; return calMem; } catch (e) { why += (why ? "; " : "") + "FRED: " + e.message; }
  }
  if (E.LLM_KEY) {
    try { const events = await aiCalendar(); calMem = { events, fetched: now, source: "ai", stale: false }; return calMem; } catch (e) { why += (why ? "; " : "") + e.message; }
  }
  if (calMem) return Object.assign({}, calMem, { stale: true });
  throw new Error("Could not load the news calendar. " + why.slice(0, 140));
}

/* ---------- auto trading through MetaApi (optional) ---------- */
const MT_SYM = { XAUUSD: "XAUUSD", USDJPY: "USDJPY", BTCUSD: "BTCUSD" };
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

/* ---------- deep research: four search agents plus a chair, with official numbers from FRED ---------- */
const FRED_HIST = [
  [/core\s*pce|pce price/i, "PCEPILFE", "pct", "Core PCE m/m %"], [/core cpi/i, "CPILFESL", "pct", "Core CPI m/m %"],
  [/\bcpi\b|inflation/i, "CPIAUCSL", "pct", "CPI m/m %"], [/\bppi\b|producer/i, "PPIFIS", "pct", "PPI m/m %"],
  [/non-?farm|payroll|employment change/i, "PAYEMS", "diff", "Non-farm payrolls change (thousands)"], [/unemployment rate/i, "UNRATE", "level", "Unemployment rate %"],
  [/unemployment claims|jobless/i, "ICSA", "level", "Weekly jobless claims"], [/retail sales/i, "RSAFS", "pct", "Retail sales m/m %"],
  [/\bgdp\b/i, "A191RL1Q225SBEA", "raw", "GDP q/q annualised %"], [/fomc|rate decision|federal funds/i, "FEDFUNDS", "level", "Fed funds rate %"]
];
async function fredHistory(title) {
  if (!E.FRED_KEY) return "";
  const m = FRED_HIST.find(x => x[0].test(title)); if (!m) return "";
  try {
    const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${m[1]}&api_key=${need("FRED_KEY")}&file_type=json&sort_order=desc&limit=14`);
    const v = (j.observations || []).map(o => parseFloat(o.value)).filter(Number.isFinite); let a = [];
    if (m[2] === "pct") for (let i = 0; i < 6 && i + 1 < v.length; i++) a.push((v[i] / v[i + 1] - 1) * 100);
    else if (m[2] === "diff") for (let i = 0; i < 6 && i + 1 < v.length; i++) a.push(v[i] - v[i + 1]); else a = v.slice(0, 6);
    if (a.length < 3) return "";
    const avg = a.reduce((x, y) => x + y, 0) / a.length, f = x => Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2);
    return `${m[3]}, latest first: ${a.map(f).join(", ")}. Average of those ${a.length}: ${f(avg)}. The latest reading is ${a[0] > avg ? "above" : "below"} that average.`;
  } catch { return ""; }
}
const AGENTS = [
  ["Consensus and history", e => `Find the consensus forecast and the previous value for ${e}. Then give the actual result against forecast for each of the last 6 releases (beat, miss or in line), with numbers.`],
  ["Central bank", e => `What have the relevant central bank and its officials said in the last 2 weeks that matters for ${e}? Include the expected policy path and any hints about this data.`],
  ["Market pricing", e => `What is already priced in before ${e}? Cover rate expectations, bond yields, dollar and gold positioning, and what analyst previews expect. How have markets moved into the release?`],
  ["World events", e => `List news from the last 48 hours (wars, oil, trade, banks, big companies, politics) that could change how markets react to ${e}.`]
];
async function research(ev) {
  const evText = `${ev.cur} ${ev.title} (scheduled ${new Date(ev.t).toUTCString()}; calendar forecast ${ev.forecast || "none"}, previous ${ev.previous || "none"})`;
  const hist = await fredHistory(ev.title), metas = AGENTS.map(() => ({}));
  const rs = await Promise.allSettled(AGENTS.map((a, i) => llm([{ role: "user", content: `Today is ${new Date().toUTCString()}. ${a[1](evText)} Reply in under 90 words of plain text. Facts only. Write "not found" for anything you cannot verify.` }], { search: true, maxTokens: 900, meta: metas[i] })));
  const agents = rs.map((r, i) => ({ name: AGENTS[i][0], ok: r.status === "fulfilled", note: r.status === "fulfilled" ? String(r.value).trim().slice(0, 700) : "Search failed: " + scrub(String(r.reason && r.reason.message || "")).slice(0, 90) }));
  if (!agents.some(a => a.ok)) throw new Error(agents[0].note);
  const seen = new Set(), sources = []; for (const m of metas) for (const x of (m.sources || [])) if (!seen.has(x.url) && sources.length < 6) { seen.add(x.url); sources.push(x); }
  const pairs = "XAUUSD (Gold), USDJPY, BTCUSD (Bitcoin)";
  const chair = `You are the chair of a macro research desk. Today is ${new Date().toUTCString()}.
Event: ${evText}.
${hist ? "Official data history (calculated, trust these numbers): " + hist : "No official history numbers were available for this event."}
Research notes from four analysts:
${agents.map(a => `- ${a.name}: ${a.note}`).join("\n")}
Combine all of this. Estimate the chance the actual figure comes in below, in line with, or above the forecast (integers summing to 100). Lean on the official history and the analysts' facts, not on guesses. If the notes disagree or key facts are missing, lower your confidence and keep the odds closer to even. Then say how each pair usually reacts in each case: ${pairs}. Keep every "why" under 16 words.
Reply with only JSON, no markdown: {"forecast":"","previous":"","odds":{"below":0,"match":0,"above":0},"summary":"one or two sentences","drivers":["up to 4 short findings"],"confidence":{"level":"low|medium|high","why":"one short sentence"},"reactions":{"XAUUSD":{"below":{"dir":"BUY|SELL|CHOP","why":""},"match":{"dir":"","why":""},"above":{"dir":"","why":""}}}} with an entry for each of: XAUUSD, USDJPY, BTCUSD.`;
  const text = await llm([{ role: "user", content: chair }], { json: true, maxTokens: 3000 });
  return { text, sources, agents, history: hist, searched: metas.some(m => (m.sources || []).length > 0) };
}


/* ---------- pair drivers: what GBPUSD and USDJPY actually react to ---------- */
const DRV = {
  USDJPY: { home: "Japan", bank: "Bank of Japan", cur: "JPY", yld: "IRLTLT01JPM156N", rate: "IR3TIB01JPM156N",
    focus: "Bank of Japan policy path and any hint of a hike, the US-Japan 10-year yield gap, Japan's Ministry of Finance comments or intervention in the yen, Japan inflation, risk sentiment (yen is a safe haven)" }
};
async function fredLatest(id, n = 8) {
  if (!E.FRED_KEY) return [];
  try { const j = await getJson(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${need("FRED_KEY")}&file_type=json&sort_order=desc&limit=${n}`);
    return (j.observations || []).map(o => ({ d: o.date, v: parseFloat(o.value) })).filter(o => Number.isFinite(o.v)); } catch { return []; }
}
async function drivers(pair) {
  const D = DRV[pair]; if (!D) throw new Error("No driver research for " + pair);
  return cached("drv:" + pair, 3 * 3600000, async () => {
    const [home, us, homeR, usR] = await Promise.all([fredLatest(D.yld, 6), fredLatest("DGS10", 70), fredLatest(D.rate, 6), fredLatest("FEDFUNDS", 6)]);
    const facts = [];
    if (home.length >= 3 && us.length) {
      const gapNow = us[0].v - home[0].v, usOld = us[Math.min(us.length - 1, 60)].v, gapOld = usOld - home[Math.min(home.length - 1, 3)].v;
      facts.push(`${D.home} 10-year yield ${home[0].v.toFixed(2)}% (${home[0].d}); US 10-year ${us[0].v.toFixed(2)}%. The US minus ${D.home} gap is ${gapNow.toFixed(2)} points now against ${gapOld.toFixed(2)} about 3 months ago (${gapNow > gapOld ? "widening, supports the dollar" : "narrowing, supports " + D.cur}).`);
    }
    if (homeR.length && usR.length) facts.push(`Short rate: ${D.home} ${homeR[0].v.toFixed(2)}% (${homeR[0].d}), US Fed funds ${usR[0].v.toFixed(2)}%.`);
    const base = `Today is ${new Date().toUTCString()}. Pair: ${pair}. Be factual, short, no markdown. Say "not found" for anything you cannot verify.`;
    const asks = [
      ["Central banks", `${base} What is the ${D.bank}'s current policy rate and last decision, how are markets pricing its next move, and how does that compare with the US Federal Reserve's expected path? Include recent official comments. Under 100 words.`],
      ["Price drivers", `${base} What has moved ${pair} in the last 2 weeks? Cover: ${D.focus}. Under 100 words.`]
    ];
    const metas = asks.map(() => ({}));
    const rs = await Promise.allSettled(asks.map((a, i) => llm([{ role: "user", content: a[1] }], { search: true, maxTokens: 900, meta: metas[i] })));
    const notes = rs.map((r, i) => r.status === "fulfilled" ? `- ${asks[i][0]}: ${String(r.value).trim().slice(0, 700)}` : null).filter(Boolean);
    if (!notes.length) throw new Error(String(rs[0].reason && rs[0].reason.message || "Research failed"));
    const seen = new Set(), sources = []; for (const m of metas) for (const x of (m.sources || [])) if (!seen.has(x.url) && sources.length < 5) { seen.add(x.url); sources.push(x); }
    const up = "the dollar gaining on the yen";
    const chair = `You are the currency desk analyst for ${pair}. Today is ${new Date().toUTCString()}.
Official data (calculated, trust it): ${facts.join(" ") || "none available"}
Research notes:
${notes.join("\n")}
Score what is pushing ${pair} over the next 1 to 3 days. Positive means ${pair} rises (${up}), negative means it falls. Each score is from -1 to 1. If facts are missing, use 0 for that part.
Reply with only JSON: {"policy":0,"economy":0,"flows":0,"home_stance":"hawkish|neutral|dovish","us_stance":"hawkish|neutral|dovish","intervention":"none|watch|high","summary":"two short sentences on what the pair wants right now","drivers":["up to 3 short findings"],"confidence":"low|medium|high"}
policy = rate path and central bank gap. economy = inflation, growth, jobs and yield gap. flows = risk sentiment, safe-haven demand, intervention or political risk. intervention only matters for USDJPY.`;
    const o = parseLoose(await llm([{ role: "user", content: chair }], { json: true, maxTokens: 1500 }));
    if (!o || typeof o !== "object") throw new Error("Unreadable driver research");
    const c = v => Math.max(-1, Math.min(1, Number(v) || 0));
    const score = Math.max(-1, Math.min(1, 0.45 * c(o.policy) + 0.3 * c(o.economy) + 0.25 * c(o.flows)));
    const st = v => ["hawkish", "neutral", "dovish"].includes(v) ? v : "neutral";
    return { pair, score, parts: { policy: c(o.policy), economy: c(o.economy), flows: c(o.flows) }, homeStance: st(o.home_stance), usStance: st(o.us_stance),
      intervention: pair === "USDJPY" && ["watch", "high"].includes(o.intervention) ? o.intervention : "none", summary: String(o.summary || "").slice(0, 400),
      drivers: (Array.isArray(o.drivers) ? o.drivers : []).slice(0, 3).map(x => String(x).slice(0, 140)), confidence: ["low", "medium", "high"].includes(o.confidence) ? o.confidence : "low", facts, sources, at: Date.now() };
  });
}


/* ---------- scalping bot: the Expert Advisor on the VPS trades, this server analyses and keeps the settings ---------- */
const BOT_TFS = new Set(["M1", "M5", "M15", "H1", "H4"]), BOT_SYMS = new Set(["XAUUSD", "USDJPY", "BTCUSD"]), brokerCs = {};
function brokerGet(sym, tf, maxAgeSec) { const b = brokerCs[sym + "|" + tf]; return b && b.cs.length >= 70 && Date.now() - b.at < maxAgeSec * 1000 ? b.cs : null; }
function brokerPut(sym, tf, rows) {
  if (!BOT_SYMS.has(sym) || !BOT_TFS.has(tf) || !Array.isArray(rows)) return { ok: false, error: "bad symbol, timeframe or rows" };
  const cs = rows.slice(-600).map(r => ({ t: String(r[0]).slice(0, 19).replace("T", " "), o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).filter(c => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(c.t) && [c.o, c.h, c.l, c.c].every(Number.isFinite) && c.h >= c.l);
  if (cs.length < 70) return { ok: false, error: "need at least 70 good candles, got " + cs.length };
  cs.sort((a, b) => a.t < b.t ? -1 : 1); brokerCs[sym + "|" + tf] = { at: Date.now(), cs }; return { ok: true, n: cs.length };
}
const botState = {}; let botHash = "", botLastSave = 0, botTimer = null;
async function botSave() {
  const b = botState.bot; if (!b || !(E.UPSTASH_URL && E.UPSTASH_TOKEN)) return;
  const txt = JSON.stringify({ cfg: b.cfg, cycles: b.cycles, seen: b.seen, notes: b.notes });
  if (txt === botHash) return;
  const wait = 15000 - (Date.now() - botLastSave);
  if (wait > 0) { if (!botTimer) botTimer = setTimeout(() => { botTimer = null; botSave().catch(() => {}); }, wait); return; }
  botLastSave = Date.now(); botHash = txt;
  try { await upstash(["SET", "chloe2:bot", txt]); } catch { botHash = ""; }
}
const botBias = async pair => { const s = await sentiment(pair); return s.score > 0.25 ? "bullish" : s.score < -0.25 ? "bearish" : "neutral"; };
const inBlackout = () => { const n = Date.now(); return !!(calMem && calMem.events && calMem.events.some(x => x.impact === "High" && n > x.t - 10 * 60000 && n < x.t + 10 * 60000)); };
const BOT = require("./bot.js")({ state: botState, saveState: botSave, telegram: () => {}, E, ENV: E, brokerGet, biasFor: botBias, inBlackout, paused: () => false });
BOT.init();
(async () => {
  if (E.UPSTASH_URL && E.UPSTASH_TOKEN) { try { const r = await upstash(["GET", "chloe2:bot"]); if (r) { const o = JSON.parse(r); botState.bot = { cfg: o.cfg || {}, cycles: o.cycles || [], seen: o.seen || [], notes: o.notes || {} }; BOT.init(); } } catch {} }
  if (E.EA_KEY) setInterval(() => { calendar().catch(() => {}); }, 30 * 60000), calendar().catch(() => {});
})();
async function eaRoute(req, res, p) {
  let b = null; try { b = await readBody(req, 600000); } catch {}
  if (!E.EA_KEY || !b || !b.key || !same(b.key, E.EA_KEY)) return send(res, 403, "DENIED", "text/plain");
  if (p === "/ea/candles") return send(res, 200, brokerPut(String(b.sym || "").toUpperCase(), String(b.tf || "").toUpperCase(), b.rows));
  try { BOT.ingest(b); } catch (e) { console.log("bot ingest: " + e.message); }
  let text = "OK"; try { text += "\n" + (await BOT.lines()).join("\n"); } catch (e) { console.log("bot lines: " + e.message); }
  botSave().catch(() => {});
  return send(res, 200, text, "text/plain");
}

/* ---------- routes ---------- */
async function api(req, res, u) {
  const p = u.pathname, q = u.searchParams;
  if (p === "/api/status") {
    return send(res, 200, { locked: !!E.ACCESS_KEY, keys: { twelve: !!E.TWELVE_KEY, fred: !!E.FRED_KEY, finnhub: !!E.FINNHUB_KEY, av: !!E.AV_KEY, llm: !!E.LLM_KEY, upstash: !!(E.UPSTASH_URL && E.UPSTASH_TOKEN), trade: mtReady() }, provider: (E.LLM_PROVIDER || "gemini").toLowerCase() });
  }
  if (E.ACCESS_KEY && !same(req.headers["x-access"] || "", E.ACCESS_KEY)) return send(res, 401, { error: "locked" });
  if (p === "/api/ping") return send(res, 200, { ok: true });
  if (p === "/api/series") return send(res, 200, { rows: await series(q.get("symbol"), q.get("interval"), q.get("size"), q.get("tz")) });
  if (p === "/api/macro") return send(res, 200, await macro());
  if (p === "/api/cot") return send(res, 200, await cot(q.get("pair")));
  if (p === "/api/options") return send(res, 200, await options(q.get("symbol")));
  if (p === "/api/sentiment") return send(res, 200, await sentiment(q.get("pair")));
  if (p === "/api/drivers") return send(res, 200, await drivers(q.get("pair")));
  if (p === "/api/calendar") return send(res, 200, await calendar());
  if (p === "/api/bot" && req.method === "GET") return send(res, 200, BOT.status());
  if (p === "/api/bot/config" && req.method === "POST") return send(res, 200, await BOT.setConfig(await readBody(req)));
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
    const meta = {}, text = await llm(m, { json: !!b.json, maxTokens: Math.min(+b.maxTokens || 1200, 3000), search: !!b.search, meta });
    return send(res, 200, { text, sources: meta.sources || [], searched: !!b.search && !meta.searchFailed });
  }
  if (p === "/api/research" && req.method === "POST") {
    const b = await readBody(req), t = +b.t;
    if (typeof b.title !== "string" || b.title.length > 90 || !["USD", "JPY"].includes(b.cur) || !Number.isFinite(t)) throw new Error("Bad event");
    return send(res, 200, await research({ title: b.title, cur: b.cur, impact: String(b.impact || "").slice(0, 10), t, forecast: String(b.forecast || "").slice(0, 20), previous: String(b.previous || "").slice(0, 20) }));
  }
  if (p === "/api/preds") {
    if (req.method === "GET") { const r = await upstash(["GET", "chloe2:preds"]); let preds = []; try { preds = r ? JSON.parse(r) : []; } catch {} return send(res, 200, { preds }); }
    if (req.method === "PUT") { const b = await readBody(req, 400000); if (!Array.isArray(b.preds)) throw new Error("Bad predictions"); await upstash(["SET", "chloe2:preds", JSON.stringify(b.preds.slice(0, 200))]); return send(res, 200, { ok: true }); }
  }
  if (p === "/api/log") {
    if (req.method === "GET") { const r = await upstash(["GET", "chloe2:log"]); let log = []; try { log = r ? JSON.parse(r) : []; } catch {} return send(res, 200, { log }); }
    if (req.method === "PUT") { const b = await readBody(req, 400000); if (!Array.isArray(b.log)) throw new Error("Bad log"); await upstash(["SET", "chloe2:log", JSON.stringify(b.log.slice(0, 300))]); return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: "Not found" });
}

const ICONS = new Set(["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon-64.png"]);
const MANIFEST = { name: "Chloe 2", short_name: "Chloe 2", start_url: "/", display: "standalone", background_color: "#fdf5e6", theme_color: "#f6e0e1", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }] };
function serveStatic(res, p) {
  if (p === "/manifest.webmanifest") return send(res, 200, MANIFEST, "application/manifest+json");
  if (ICONS.has(p)) return fs.readFile(path.join(__dirname, p.slice(1)), (err, data) => { if (err) return send(res, 404, "Not found", "text/plain"); res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }); res.end(data); });
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
    if ((u.pathname === "/ea/poll" || u.pathname === "/ea/candles") && req.method === "POST") return await eaRoute(req, res, u.pathname);
    if (u.pathname.startsWith("/api/")) return await api(req, res, u);
    return serveStatic(res, u.pathname);
  } catch (e) {
    send(res, 502, { error: scrub(String(e && e.message || e)).slice(0, 240) });
  }
}).listen(PORT, () => console.log("Chloe 2 listening on " + PORT));
