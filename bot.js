'use strict';
/* Scalping bot, server side.
   The server's job: (1) the "analysts" give a direction and a score for each pair from broker candles,
   (2) it keeps the settings, (3) it shows the numbers in the Bot tab.
   The Expert Advisor on your VPS does the trading itself (opens the stack, trails every position, steps the lot up and down),
   so open trades keep being managed even if this server is asleep or offline. The server never holds your broker password. */

const PAIRS = ['XAUUSD', 'BTCUSD', 'USDJPY'];
const NAME = { XAUUSD: 'Gold', BTCUSD: 'Bitcoin', USDJPY: 'USDJPY' };
const num = (x, lo, hi, d) => { x = parseFloat(x); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const r2 = x => Math.round(x * 100) / 100;

/* every setting, its limits and what it means. The Bot tab and the Expert Advisor both use these names. */
const FIELDS = {
  startLot:      { lo: 0.01, hi: 1,    d: 0.01, step: 0.01, label: 'Start lot', hint: 'The lot every new stack starts at, and the lot it falls back towards after losses.' },
  lotUp:         { lo: 0,    hi: 0.5,  d: 0.02, step: 0.01, label: 'Lot step up after a profit', hint: 'Added to the lot when a stack (all its positions together) ends in profit.' },
  lotDown:       { lo: 0,    hi: 0.5,  d: 0.01, step: 0.01, label: 'Lot step down after a loss', hint: 'Taken off the lot when a stack ends at a loss. It never goes below the minimum lot.' },
  minLot:        { lo: 0.01, hi: 1,    d: 0.01, step: 0.01, label: 'Smallest lot', hint: 'The lot never goes below this.' },
  maxLot:        { lo: 0.01, hi: 5,    d: 0.10, step: 0.01, label: 'Biggest lot', hint: 'The lot never goes above this, however many wins in a row.' },
  startPos:      { lo: 1,    hi: 30,   d: 5,    step: 1,    label: 'Positions per stack', hint: 'How many positions open together on one signal, while the account is small.' },
  addEveryUsd:   { lo: 1,    hi: 100000, d: 20, step: 1,    label: 'Add 1 position for every ($) of growth', hint: 'One more position for each time equity grows by this much above the base equity.' },
  baseEq:        { lo: 1,    hi: 100000, d: 10, step: 1,    label: 'Base equity ($)', hint: 'The account size the starting number of positions is meant for.' },
  maxPos:        { lo: 1,    hi: 40,   d: 15,   step: 1,    label: 'Most positions in a stack', hint: 'The number of positions never goes above this.' },
  trigger:       { lo: 0.05, hi: 50,   d: 0.50, step: 0.05, label: 'Profit that starts the trailing stop ($ per 0.01 lot)', hint: 'When a position is this much in profit, it stops waiting and starts trailing. Scales with the lot, so the price distance stays the same.' },
  trailPct:      { lo: 20,   hi: 100,  d: 60,   step: 5,    label: 'Trail gap (% of the trigger)', hint: 'How far behind the best price the stop follows. Smaller holds less of a pullback, bigger gives the trade more room.' },
  lockPct:       { lo: 0,    hi: 80,   d: 30,   step: 5,    label: 'Profit always locked once trailing (% of the trigger)', hint: 'Once the trailing stop starts, the stop never sits below this much profit.' },
  riskCap:       { lo: 5,    hi: 50,   d: 30,   step: 1,    label: 'Most equity the whole stack may risk (%)', hint: 'If all positions hit their stop together, you lose about this much. The bot opens fewer positions (or a smaller lot) rather than go above it.' },
  slAtr:         { lo: 0.3,  hi: 3,    d: 0.8,  step: 0.1,  label: 'Stop loss size (x 5 minute ATR)', hint: 'The stop distance is this many times the average 5 minute candle range.' },
  slMin:         { lo: 1,    hi: 6,    d: 2,    step: 0.5,  label: 'Stop is never closer than (x the trigger distance)', hint: 'Keeps the stop from being tighter than normal price noise.' },
  maxSpreadFrac: { lo: 0.1,  hi: 1,    d: 0.5,  step: 0.05, label: 'Skip when the spread is over (x the trigger distance)', hint: 'A wide spread eats the small profit a scalp aims for, so the bot waits.' },
  minScore:      { lo: 20,   hi: 90,   d: 45,   step: 5,    label: 'Analysts must agree by at least (score out of 100)', hint: 'Higher means fewer but better-agreed entries.' },
  cooldown:      { lo: 0,    hi: 3600, d: 20,   step: 5,    label: 'Wait after a stack closes (seconds)', hint: 'Pause before the next stack on the same pair.' },
  dayLoss:       { lo: 2,    hi: 90,   d: 25,   step: 1,    label: 'Stop for the day after losing (% of the day-start equity)', hint: 'No new stacks for the rest of the day once equity is this far below where the day began.' },
  ddStop:        { lo: 5,    hi: 90,   d: 40,   step: 1,    label: 'Stop the bot after a drop of (% from the equity peak)', hint: 'Safety stop: the bot switches itself off and (if ticked) closes everything.' },
  targetEq:      { lo: 0,    hi: 100000000, d: 0, step: 10,  label: 'Target equity ($, 0 = none)', hint: 'The bot stops and (if ticked) closes everything when equity reaches this.' },
};
const FLAGS = { closeOnStop: true, news: true };
const KEYS = Object.keys(FIELDS);

module.exports = function makeBot(D) {
  const { state, saveState, telegram, E, ENV } = D;
  const eaKey = () => ENV.EA_KEY || '';

  function init() {
    const b = state.bot = state.bot || {};
    b.cfg = Object.assign({ enabled: false, pairs: PAIRS.slice(), resetN: 0, closeN: 0 }, b.cfg || {});
    KEYS.forEach(k => { b.cfg[k] = num(b.cfg[k], FIELDS[k].lo, FIELDS[k].hi, FIELDS[k].d); });
    Object.keys(FLAGS).forEach(k => { b.cfg[k] = b.cfg[k] == null ? FLAGS[k] : !!b.cfg[k]; });
    b.cfg.pairs = (b.cfg.pairs || []).filter(s => PAIRS.includes(s));
    b.views = b.views || {}; b.cycles = b.cycles || []; b.seen = b.seen || []; b.tel = b.tel || null; b.notes = b.notes || {};
    return b;
  }
  const B = () => state.bot || init();

  /* ---------------- the analysts ---------------- */
  function emaSeries(a, n) { const k = 2 / (n + 1), out = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out[i] = e; } return out; }
  function rsiLast(c, n) { if (c.length < n + 2) return 50; let ag = 0, al = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) ag += d; else al -= d; } ag /= n; al /= n; for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n; al = (al * (n - 1) + (d < 0 ? -d : 0)) / n; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  function atrLast(cs, n) { let s = 0, k = 0; for (let i = Math.max(1, cs.length - n); i < cs.length; i++) { const a = cs[i], p = cs[i - 1]; s += Math.max(a.h - a.l, Math.abs(a.h - p.c), Math.abs(a.l - p.c)); k++; } return k ? s / k : 0; }

  /* Pure function: closed 5 minute candles (c5), closed 1 minute candles or null (c1), closed 1 hour candles or null (cH),
     the news lean ('bullish', 'bearish', 'neutral') and the 5 minute strategy reading (scalp: {dir, conf} or null). */
  function scoreView(c5, c1, cH, bias, scalp, minScore) {
    if (!c5 || c5.length < 60) return { dir: 'WAIT', score: 0, atr: 0, parts: [], reason: 'not enough 5 minute candles yet' };
    const px = c5[c5.length - 1].c, closes = c5.map(c => c.c), parts = [];
    const atr = atrLast(c5, 14);
    if (!(atr > 0)) return { dir: 'WAIT', score: 0, atr: 0, parts: [], reason: 'no price movement' };
    const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50), n = closes.length - 1;
    // 1. trend analyst: 5 minute averages
    let t = 0, tn = 'mixed';
    if (e20[n] > e50[n] && px > e20[n]) { t = 25; tn = '20 above 50, price above the 20'; }
    else if (e20[n] < e50[n] && px < e20[n]) { t = -25; tn = '20 below 50, price below the 20'; }
    else if (e20[n] > e50[n]) { t = 8; tn = '20 above 50 but price under the 20'; }
    else if (e20[n] < e50[n]) { t = -8; tn = '20 below 50 but price over the 20'; }
    parts.push({ name: 'Trend (5 min)', v: t, note: tn });
    // 2. bigger picture analyst: 1 hour averages (or the long 5 minute averages when 1 hour candles are missing)
    let h = 0, hn = 'no data';
    if (cH && cH.length >= 55) { const hc = cH.map(c => c.c), h20 = emaSeries(hc, 20), h50 = emaSeries(hc, 50), m = hc.length - 1; if (h20[m] > h50[m] && hc[m] > h50[m]) { h = 20; hn = '1 hour averages point up'; } else if (h20[m] < h50[m] && hc[m] < h50[m]) { h = -20; hn = '1 hour averages point down'; } else hn = '1 hour is mixed'; }
    else if (closes.length >= 210) { const l1 = emaSeries(closes, 100), l2 = emaSeries(closes, 200); if (l1[n] > l2[n] && px > l2[n]) { h = 20; hn = 'long averages point up'; } else if (l1[n] < l2[n] && px < l2[n]) { h = -20; hn = 'long averages point down'; } else hn = 'long averages mixed'; }
    parts.push({ name: 'Bigger picture', v: h, note: hn });
    // 3. momentum analyst: RSI on 5 minutes, and the fast 1 minute averages
    const rs = rsiLast(closes, 14); let m1 = 0, mn = 'RSI ' + Math.round(rs);
    if (rs >= 65) m1 += 15; else if (rs >= 55) m1 += 10; else if (rs <= 35) m1 -= 15; else if (rs <= 45) m1 -= 10;
    if (c1 && c1.length >= 30) { const q = c1.map(c => c.c), f9 = emaSeries(q, 9), f21 = emaSeries(q, 21), k = q.length - 1; if (f9[k] > f21[k] && q[k] > f9[k]) { m1 += 10; mn += ', 1 min up'; } else if (f9[k] < f21[k] && q[k] < f9[k]) { m1 -= 10; mn += ', 1 min down'; } else mn += ', 1 min mixed'; }
    else { const d = closes[n] - closes[n - 3]; if (d > 0.3 * atr) { m1 += 8; mn += ', last 3 candles up'; } else if (d < -0.3 * atr) { m1 -= 8; mn += ', last 3 candles down'; } }
    parts.push({ name: 'Momentum', v: m1, note: mn });
    // 4. structure analyst: breakout of the last 12 candles, and Chloe's own 5 minute strategies
    let s = 0, sn = 'inside the range';
    let hi = -Infinity, lo = Infinity; for (let i = n - 12; i < n; i++) { if (c5[i].h > hi) hi = c5[i].h; if (c5[i].l < lo) lo = c5[i].l; }
    if (px > hi) { s += 10; sn = 'broke the 12 candle high'; } else if (px < lo) { s -= 10; sn = 'broke the 12 candle low'; }
    if (scalp && (scalp.dir === 'BUY' || scalp.dir === 'SELL') && scalp.conf >= 50) { const w = Math.round(25 * Math.min(1, scalp.conf / 70)); s += scalp.dir === 'BUY' ? w : -w; sn += '; strategy says ' + scalp.dir + ' (' + scalp.conf + '%)'; }
    parts.push({ name: 'Structure and strategies', v: s, note: sn });
    // 5. news analyst
    const nv = bias === 'bullish' ? 10 : bias === 'bearish' ? -10 : 0;
    parts.push({ name: 'News lean', v: nv, note: bias || 'neutral' });
    let score = Math.max(-100, Math.min(100, parts.reduce((a, p) => a + p.v, 0)));
    let dir = score >= minScore ? 'BUY' : score <= -minScore ? 'SELL' : 'WAIT', reason = dir === 'WAIT' ? 'analysts do not agree enough (' + score + ', need ' + minScore + ')' : 'analysts agree';
    const stretch = Math.abs(px - e20[n]) / atr;
    if (dir !== 'WAIT' && stretch > 2.5) { reason = 'price is stretched ' + stretch.toFixed(1) + ' ATR from its average, waiting for a pullback'; dir = 'WAIT'; }
    if (dir === 'BUY' && rs > 85) { reason = 'RSI ' + Math.round(rs) + ' is too stretched to buy'; dir = 'WAIT'; }
    if (dir === 'SELL' && rs < 15) { reason = 'RSI ' + Math.round(rs) + ' is too stretched to sell'; dir = 'WAIT'; }
    return { dir, score, atr, px, parts, reason };
  }

  const biasCache = {};
  async function viewFor(sym) {
    const c = B().cfg, closed = (cs, tf) => { if (!cs) return null; const last = cs[cs.length - 1], t = Date.parse(last.t.replace(' ', 'T') + 'Z'), mins = { M1: 1, M5: 5, H1: 60 }[tf]; return isFinite(t) && Date.now() < t + mins * 60000 ? cs.slice(0, -1) : cs; };
    const raw5 = D.brokerGet(sym, 'M5', 240);
    if (!raw5) return { dir: 'WAIT', score: 0, atr: 0, parts: [], reason: 'waiting for 5 minute prices from MT5 (the Expert Advisor sends them)', at: Date.now() };
    const c5 = closed(raw5, 'M5'), c1 = closed(D.brokerGet(sym, 'M1', 180), 'M1'), cH = closed(D.brokerGet(sym, 'H1', 900), 'H1');
    let bias = 'neutral'; const bc = biasCache[sym]; if (bc && Date.now() - bc.at < 300000) bias = bc.v; else { try { bias = await D.biasFor(sym) || 'neutral'; } catch (e) {} biasCache[sym] = { at: Date.now(), v: bias }; }
    const scalp = null; // Chloe 2 has no separate 5 minute strategy engine; the other four analysts decide
    const v = scoreView(c5, c1, cH, bias, scalp, c.minScore); v.at = Date.now(); v.hasM1 = !!c1; v.hasH1 = !!cH;
    return v;
  }
  async function refreshViews() {
    const b = B(); let any = false;
    for (const sym of PAIRS) { const old = b.views[sym]; if (old && Date.now() - old.at < 10000) continue; try { b.views[sym] = await viewFor(sym); any = true; } catch (e) { b.views[sym] = { dir: 'WAIT', score: 0, atr: 0, parts: [], reason: 'analysis error: ' + e.message, at: Date.now() }; } }
    return any;
  }

  /* ---------------- what the bot would do right now (an estimate from standard contract sizes) ---------------- */
  const VPU = { XAUUSD: () => 100, BTCUSD: () => 1, USDJPY: px => 100000 / px }; // dollars per 1.00 of price per 1.00 lot
  function posTarget(eq, c) { return Math.max(1, Math.min(c.maxPos, c.startPos + Math.floor(Math.max(0, eq - c.baseEq) / Math.max(1, c.addEveryUsd)))); }
  function preview(sym, eq, lot) {
    const c = B().cfg, v = B().views[sym]; if (!v || !(v.atr > 0) || !(eq > 0)) return null;
    const vpu = VPU[sym](v.px || 1), trig = c.trigger / (vpu * 0.01), sl = Math.max(c.slAtr * v.atr, c.slMin * trig), perPos = sl * vpu * lot, want = posTarget(eq, c), cap = eq * c.riskCap / 100, fit = Math.floor(cap / perPos + 1e-9);
    return { sym, trigDist: trig, slDist: sl, riskPerPos: r2(perPos), want, allowed: Math.max(0, Math.min(want, fit)), capMoney: r2(cap), minLotRisk: r2(sl * vpu * c.minLot) };
  }

  /* ---------------- the Expert Advisor talks here (called from the /ea/poll route) ---------------- */
  function ingest(b0) {
    const b = B(), t = b0 && b0.bot; if (!t || typeof t !== 'object') return;
    b.tel = { at: Date.now(), lot: +t.lot || 0, tpos: +t.tpos || 0, status: String(t.status || '').slice(0, 160), eq: +t.eq || 0, dayStart: +t.dayStart || 0, peak: +t.peak || 0, open: (Array.isArray(t.open) ? t.open : []).slice(0, 40).map(o => ({ sym: String(o.sym), dir: String(o.dir), vol: +o.vol, profit: +o.profit, armed: !!o.armed })), halted: String(t.halted || ''), version: String(t.v || '') };
    const msgs = [];
    for (const c of (Array.isArray(t.cyc) ? t.cyc : []).slice(-10)) {
      const id = String(c.id); if (!id || b.seen.includes(id)) continue;
      b.seen.push(id); if (b.seen.length > 200) b.seen = b.seen.slice(-200);
      const row = { id, sym: String(c.sym), dir: String(c.dir), lots: +c.lots, n: +c.n, net: r2(+c.net || 0), at: +c.at || Date.now(), lotAfter: +c.lotAfter || 0 };
      b.cycles.push(row); if (b.cycles.length > 150) b.cycles = b.cycles.slice(-150);
      msgs.push('CHLOE BOT: ' + (NAME[row.sym] || row.sym) + ' ' + row.dir + ' stack of ' + row.n + ' x ' + row.lots.toFixed(2) + ' closed ' + (row.net >= 0 ? '+' : '') + row.net.toFixed(2) + '. Next lot ' + (row.lotAfter ? row.lotAfter.toFixed(2) : '-') + '. Equity ' + (b.tel.eq ? b.tel.eq.toFixed(2) : '-') + '.');
    }
    if (b.tel.halted && b.notes.halted !== b.tel.halted) { b.notes.halted = b.tel.halted; if (/stopped|target|drop|day/i.test(b.tel.halted)) msgs.push('CHLOE BOT: ' + b.tel.halted); }
    if (!b.tel.halted) b.notes.halted = '';
    msgs.forEach(m => { try { telegram(m); } catch (e) {} });
  }

  /* lines appended to the plain-text reply the EA reads */
  async function lines() {
    const b = B(), c = b.cfg, out = [];
    await refreshViews();
    const kv = ['enabled=' + (c.enabled ? 1 : 0), 'reset=' + c.resetN, 'closeAll=' + c.closeN, 'pairs=' + c.pairs.join(',')];
    KEYS.forEach(k => kv.push(k + '=' + c[k])); Object.keys(FLAGS).forEach(k => kv.push(k + '=' + (c[k] ? 1 : 0)));
    out.push('BOTCFG|' + kv.join('|'));
    const now = Date.now(); let hold = '';
    if (c.news && D.inBlackout && D.inBlackout()) hold = 'news blackout around a scheduled release';
    if (D.paused && D.paused()) hold = 'paused from Telegram (/resume)';
    if (hold) out.push('BOTHOLD|' + hold);
    for (const sym of PAIRS) { const v = b.views[sym]; if (v) out.push('BOTVIEW|' + sym + '|' + v.dir + '|' + v.score + '|' + (v.atr ? +v.atr.toPrecision(6) : 0) + '|' + Math.round((now - v.at) / 1000) + '|' + String(v.reason || '').replace(/[|\n]/g, ' ').slice(0, 90)); }
    return out;
  }

  /* ---------------- page ---------------- */
  function status() {
    const b = B(), c = b.cfg, now = Date.now(), tel = b.tel, eq = tel && tel.eq || 0, lot = tel && tel.lot || c.startLot;
    const cy = b.cycles, wins = cy.filter(x => x.net > 0).length, net = r2(cy.reduce((s, x) => s + x.net, 0));
    return {
      cfg: c, fields: FIELDS, pairs: PAIRS, names: NAME, connected: !!(tel && now - tel.at < 120000), lastSeenSec: tel ? Math.round((now - tel.at) / 1000) : null,
      configured: { ea_key: !!eaKey() }, tel, lot, posTarget: posTarget(eq || c.baseEq, c),
      views: Object.fromEntries(PAIRS.map(s => [s, b.views[s] || null])), preview: Object.fromEntries(PAIRS.map(s => [s, preview(s, eq || c.baseEq, lot)])),
      cycles: cy.slice(-15).reverse(), stats: { n: cy.length, wins, losses: cy.length - wins, net, hit: cy.length ? Math.round(wins / cy.length * 100) : 0 },
    };
  }
  async function setConfig(b0) {
    const b = B(), c = b.cfg, err = m => ({ ok: false, error: m }), x = b0 || {};
    KEYS.forEach(k => { if (x[k] != null) c[k] = num(x[k], FIELDS[k].lo, FIELDS[k].hi, c[k]); });
    Object.keys(FLAGS).forEach(k => { if (x[k] != null) c[k] = !!x[k]; });
    if (c.maxLot < c.minLot) c.maxLot = c.minLot; if (c.startLot < c.minLot) c.startLot = c.minLot; if (c.startLot > c.maxLot) c.startLot = c.maxLot;
    if (Array.isArray(x.pairs)) c.pairs = x.pairs.filter(s => PAIRS.includes(s));
    if (x.resetLot) c.resetN++;
    if (x.closeAll) c.closeN++;
    if (x.enabled != null) {
      if (x.enabled && !c.pairs.length) return err('Pick at least one pair first.');
      if (x.enabled && !eaKey()) return err('EA_KEY is not set on the server.');
      c.enabled = !!x.enabled;
      if (!c.enabled) { /* switching off only stops NEW stacks; open positions keep their stops and trailing */ }
    }
    for (const s of PAIRS) delete b.views[s]; // new settings: re-score
    await saveState(); return { ok: true };
  }

  return { init, ingest, lines, status, setConfig, scoreView, posTarget, FIELDS, PAIRS, NAME };
};
