'use strict';
/* Araştırma: "bütün piyasayı tara" fikrinin gerçek veriyle sınanması.
   Binance'teki tüm USDT spot çiftlerinin 4 saatlik geçmişini indirir ve aynı trend kurallarını
   farklı tarama genişliklerinde dener. Evren her an için o andaki bilgiyle seçilir (son 30 günün işlem hacmi).
   Bilinen eksik: listeden kaldırılmış coinler veride yoktur; sonuçlar gerçekte olacağından iyi görünür. */
const fs = require('fs'), path = require('path');
const Engine = require('./engine.js'), Core = require('./core.js');
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(pathq, tries = 5) {
  let err;
  for (let k = 0; k < tries; k++) for (const h of HOSTS) {
    try {
      const c = new AbortController(), to = setTimeout(() => c.abort(), 20000);
      const r = await fetch(h + pathq, { signal: c.signal }); clearTimeout(to);
      if (r.status === 429 || r.status === 418) { await sleep(15000 * (k + 1)); throw new Error('hız sınırı'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(400); }
  }
  throw err;
}
const STABLE = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USDD', 'USD1', 'EUR', 'EURI', 'AEUR', 'XUSD', 'BFUSD', 'USDE', 'PAXG', 'XAUT', 'WBTC', 'WBETH', 'BETH', 'WETH', 'STETH', 'BNSOL', 'RLUSD', 'PYUSD', 'UST', 'USTC', 'SUSD', 'GBP', 'TRY', 'BRL']);
(async () => {
  const cfg = Object.assign({}, Core.DEFAULTS, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')));
  const tf = '4h', TFMS = Engine.TF_MS[tf], years = +(process.env.YEARS || 3), need = Math.ceil(years * Engine.BARS_PER_YEAR[tf]) + cfg.emaSlow + cfg.don + 10;
  const info = await get('/api/v3/exchangeInfo');
  let syms = info.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed !== false && !STABLE.has(s.baseAsset) && !/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset)).map(s => ({ sym: s.baseAsset, pair: s.symbol }));
  if (process.env.MAX_SYMS) syms = syms.slice(0, +process.env.MAX_SYMS);
  console.log('çift sayısı', syms.length);
  const data = {}, failed = []; let done = 0;
  async function load(x) {
    try {
      let out = [], end;
      while (out.length < need) {
        const rows = await get(`/api/v3/klines?symbol=${x.pair}&interval=${tf}&limit=1000${end ? '&endTime=' + end : ''}`);
        if (!rows.length) break;
        out = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], qv: +r[7] })).concat(out); end = rows[0][0] - 1;
        if (rows.length < 1000) break;
      }
      out = out.filter(b => b.t + TFMS <= Date.now() && b.o > 0 && b.h >= b.l && b.l > 0).slice(-need);
      if (out.length > cfg.emaSlow + cfg.don + 200) data[x.sym] = out;
    } catch (e) { failed.push(x.sym); }
    if (++done % 50 === 0) console.log('indirildi', done, '/', syms.length);
  }
  const q = syms.slice(); await Promise.all(Array.from({ length: 5 }, async () => { while (q.length) await load(q.shift()); }));
  const names = Object.keys(data); console.log('kullanılabilir varlık', names.length, 'başarısız', failed.length);
  if (!data.BTC || !data.ETH) throw new Error('BTC/ETH verisi yok');
  // O andaki bilgiyle hacim sıralaması: her gün, son 30 günün (180 mum) dolar hacmine göre
  const idx = {}, pre = {};
  for (const s of names) { const m = new Map(), p = [0]; data[s].forEach((b, i) => { m.set(b.t, i); p.push(p[i] + b.qv); }); idx[s] = m; pre[s] = p; }
  const ref = data.BTC, DAY = 6, ranks = new Map();
  for (let k = 0; k < ref.length; k += DAY) {
    const t = ref[k].t, list = [];
    for (const s of names) { const i = idx[s].get(t); if (i != null && i >= 180) list.push([s, pre[s][i + 1] - pre[s][i + 1 - 180]]); }
    list.sort((a, b) => b[1] - a[1]); const r = {}; list.forEach((x, n) => { r[x[0]] = n; }); ranks.set(t, r);
  }
  const refIdx = idx.BTC, rankAt = (s, t) => { const i = refIdx.get(t); if (i == null) return Infinity; const r = ranks.get(ref[i - i % DAY].t); return r && r[s] != null ? r[s] : Infinity; };
  const btcInd = Engine.indicators(ref, cfg), btcUp = t => { const i = refIdx.get(t); return i != null && Engine.trendUp(i, ref, btcInd); };
  let r0 = 0; while (!Engine.ready(r0, btcInd)) r0++;
  const startAt = ref[Math.max(r0, 180)].t, base = Object.assign({}, cfg, { tf, capital: 1000, feePct: 0.10, fees: {}, slipPct: 0.05, gasUsd: 0, startAt });
  const hold = s => { const b = data[s], i = idx[s].get(startAt); return b[b.length - 1].c / b[i].c - 1; };
  const out = { at: Date.now(), tf, years, from: startAt, to: ref[ref.length - 1].t, nSymbols: names.length, failed: failed.length, btcHold: hold('BTC'), ethHold: hold('ETH'),
    note: 'Listeden kaldırılmış coinler veride yok; sonuçlar gerçekte olacağından iyi görünür. Küçük coinlerde gerçek kayma varsayılandan yüksektir.', variants: [] };
  const run = (name, d, extra) => {
    const r = Engine.backtestPortfolio(d, Object.assign({}, base, extra));
    if (r.error) { out.variants.push({ name, error: r.error }); return; }
    const s = r.stats, f = x => Math.round(x * 1e4) / 1e4, pa = r.perAsset.filter(a => a.n).sort((a, b) => b.pnl - a.pnl);
    const v = { name, ret: f(s.ret), cagr: f(s.cagr), maxDD: f(s.maxDD), h1: f(s.h1), h2: f(s.h2), nTrades: s.nTrades, winRate: f(s.winRate), profitFactor: f(s.profitFactor), exposure: f(s.exposure), sharpe: f(s.sharpe),
      tradedSymbols: pa.length, best: pa.slice(0, 5).map(a => [a.sym, Math.round(a.pnl)]), worst: pa.slice(-5).reverse().map(a => [a.sym, Math.round(a.pnl)]),
      top3share: f(pa.slice(0, 3).reduce((t, a) => t + a.pnl, 0) / Math.max(1, pa.filter(a => a.pnl > 0).reduce((t, a) => t + a.pnl, 0))) };
    out.variants.push(v); console.log(JSON.stringify(v));
  };
  run('Yalnızca ETH', { ETH: data.ETH }, { maxPositions: 1, maxPosPct: 100 });
  run('BTC + ETH', { BTC: data.BTC, ETH: data.ETH }, { maxPositions: 2, maxPosPct: 50 });
  for (const regime of [false, true]) for (const N of [10, 30, 100, null]) {
    run(`${N ? 'Hacimce ilk ' + N : 'Bütün piyasa'}${regime ? ' + piyasa filtresi' : ''}`, data, { maxPositions: 5, maxPosPct: 20, canEnter: (s, t) => (N == null || rankAt(s, t) < N) && (!regime || btcUp(t)) });
  }
  fs.mkdirSync(path.join(__dirname, '..', 'state'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'state', 'research.json'), JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
