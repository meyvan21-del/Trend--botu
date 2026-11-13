'use strict';
/* Gerçek fiyat verisiyle karşılaştırmalı geçmiş testi. Elle çalıştırılır (Actions → Geçmiş testi).
   Kuralların parametreleri değiştirilmez; yalnızca hangi varlıkların tarandığı karşılaştırılır. */
const fs = require('fs'), path = require('path');
const Engine = require('./engine.js'), Core = require('./core.js');
(async () => {
  const cfg = Object.assign({}, Core.DEFAULTS, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')));
  const years = +(process.env.YEARS || 3), need = Math.ceil(years * Engine.BARS_PER_YEAR[cfg.tf]) + cfg.emaSlow + cfg.don + 10, data = {}, notes = [];
  for (const a of Core.ASSETS) { try { data[a.sym] = await Core.fetchHistory(globalThis.fetch, a, cfg.tf, need); } catch (e) { notes.push(a.sym + ': ' + Core.errMsg(e)); } }
  const variants = [
    { name: 'Yalnızca ETH', assets: ['ETH'], maxPositions: 1, maxPosPct: 100 },
    { name: 'ETH + BTC', assets: ['ETH', 'BTC'], maxPositions: 2, maxPosPct: 50 },
    { name: 'Beş varlık (varsayılan)', assets: cfg.assets, maxPositions: cfg.maxPositions, maxPosPct: cfg.maxPosPct }
  ];
  const out = { at: Date.now(), tf: cfg.tf, years, bars: Object.fromEntries(Object.keys(data).map(s => [s, data[s].length])), notes, variants: [] };
  for (const v of variants) {
    const d = {}; for (const s of v.assets) if (data[s]) d[s] = data[s];
    const r = Engine.backtestPortfolio(d, Object.assign({}, cfg, v, { capital: 1000, fees: Core.FEES }));
    if (r.error) { out.variants.push({ name: v.name, error: r.error }); continue; }
    const s = r.stats, f = x => Math.round(x * 1e4) / 1e4;
    out.variants.push({ name: v.name, assets: r.syms, from: r.eq[0].t, to: r.eq[r.eq.length - 1].t,
      ret: f(s.ret), bhRet: f(s.bhRet), cagr: f(s.cagr), maxDD: f(s.maxDD), bhMaxDD: f(s.bhMaxDD), h1: f(s.h1), h2: f(s.h2), nTrades: s.nTrades, winRate: f(s.winRate), profitFactor: f(s.profitFactor), exposure: f(s.exposure), sharpe: f(s.sharpe),
      perAsset: r.perAsset.map(a => ({ sym: a.sym, n: a.n, wins: a.wins, pnl: Math.round(a.pnl * 100) / 100 })) });
    console.log(v.name, JSON.stringify(out.variants[out.variants.length - 1]));
  }
  fs.mkdirSync(path.join(__dirname, '..', 'state'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'state', 'backtest.json'), JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
