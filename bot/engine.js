/* Strateji motoru: saf fonksiyonlar. Ağ, cüzdan ve arayüzden bağımsızdır;
   aynı kurallar hem geçmiş testinde hem canlı botta kullanılır. */
const Engine = (() => {
  const TF_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 24 * 3600e3 };
  const BARS_PER_YEAR = { '1h': 8760, '4h': 2190, '1d': 365 };

  function ema(v, n) {
    const out = new Array(v.length).fill(null);
    if (v.length < n) return out;
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i];
    let e = s / n;
    out[n - 1] = e;
    const k = 2 / (n + 1);
    for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }

  // Wilder ATR
  function atr(b, n) {
    const out = new Array(b.length).fill(null);
    if (b.length <= n) return out;
    let s = 0;
    const tr = i => Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    for (let i = 1; i <= n; i++) s += tr(i);
    let a = s / n;
    out[n] = a;
    for (let i = n + 1; i < b.length; i++) { a = (a * (n - 1) + tr(i)) / n; out[i] = a; }
    return out;
  }

  // Önceki n mumun en yüksek değeri (içinde bulunulan mum hariç)
  function donchianHigh(b, n) {
    const out = new Array(b.length).fill(null);
    for (let i = n; i < b.length; i++) {
      let m = -Infinity;
      for (let j = i - n; j < i; j++) if (b[j].h > m) m = b[j].h;
      out[i] = m;
    }
    return out;
  }

  function indicators(b, p) {
    const c = b.map(x => x.c);
    return { f: ema(c, p.emaFast), s: ema(c, p.emaSlow), a: atr(b, p.atrN), d: donchianHigh(b, p.don) };
  }

  const ready = (i, ind) => i >= 0 && ind.f[i] != null && ind.s[i] != null && ind.a[i] != null && ind.d[i] != null;
  const trendUp = (i, b, ind) => ready(i, ind) && ind.f[i] > ind.s[i] && b[i].c > ind.s[i];
  // Giriş: trend yukarı VE kapanış son N mumun zirvesini aşıyor
  const entryOK = (i, b, ind) => trendUp(i, b, ind) && b[i].c > ind.d[i];
  // Çıkış: hızlı ortalama yavaşın altına indi
  const trendBroken = (i, ind) => ind.f[i] != null && ind.s[i] != null && ind.f[i] < ind.s[i];

  // Pozisyon büyüklüğü: stop çalışırsa sermayenin en fazla riskPct'i kaybedilsin
  function posFraction(price, atrV, p) {
    const stopDist = p.atrK * atrV / price;
    if (!(stopDist > 0) || !isFinite(stopDist)) return 0;
    return Math.max(0, Math.min(p.maxPosPct / 100, (p.riskPct / 100) / stopDist));
  }

  function maxDrawdown(series) {
    let peak = -Infinity, dd = 0;
    for (const x of series) { if (x.v > peak) peak = x.v; const d = 1 - x.v / peak; if (d > dd) dd = d; }
    return dd;
  }

  /* Geçmiş testi. Sinyal mum kapanışında oluşur, işlem BİR SONRAKİ mumun
     açılışında yapılır (geleceği görme hatası yok). Stop mum içinde tetiklenir. */
  function backtest(b, p) {
    const ind = indicators(b, p);
    const cost = (p.feePct + p.slipPct) / 100;
    const gas = p.gasUsd;
    const capital = p.capital || 1000;
    const minTrade = p.minTradeUsd || 5;
    let start = 0;
    while (start < b.length && !ready(start, ind)) start++;
    if (start >= b.length - 2) return { error: 'Yeterli veri yok', eq: [], bh: [], trades: [] };

    let cash = capital, qty = 0, pos = null, pending = null, cooldownUntil = -1, barsIn = 0;
    const eq = [], bh = [], trades = [];
    const p0 = b[start].c;

    const closeAt = (i, px, reason) => {
      const out = qty * px * (1 - cost) - gas;
      cash += out;
      trades.push({ tIn: pos.t, tOut: b[i].t, entry: pos.entry, exit: px, usdIn: pos.usdIn, usdOut: out, pnl: out - pos.usdIn, reason });
      qty = 0; pos = null;
    };

    for (let i = start; i < b.length; i++) {
      const bar = b[i];
      if (pending === 'buy' && !pos) {
        const frac = posFraction(bar.o, ind.a[i - 1], p);
        const n = Math.min(cash - gas, (cash) * frac);
        if (n >= minTrade) {
          qty = n * (1 - cost) / bar.o;
          cash -= n + gas;
          pos = { t: bar.t, entry: bar.o, stop: bar.o - p.atrK * ind.a[i - 1], hi: bar.o, usdIn: n + gas };
        }
      } else if (pending === 'sell' && pos) {
        closeAt(i, bar.o, 'trend');
      }
      pending = null;

      if (pos && bar.l <= pos.stop) {
        closeAt(i, Math.min(bar.o, pos.stop), 'stop');
        cooldownUntil = i + p.cooldown;
      }

      if (pos) {
        barsIn++;
        if (bar.c > pos.hi) pos.hi = bar.c;
        const ns = pos.hi - p.atrK * ind.a[i];
        if (ns > pos.stop) pos.stop = ns;
        if (trendBroken(i, ind)) pending = 'sell';
      } else if (i >= cooldownUntil && entryOK(i, b, ind)) {
        pending = 'buy';
      }
      eq.push({ t: bar.t, v: cash + qty * bar.c });
      bh.push({ t: bar.t, v: capital * bar.c / p0 });
    }

    const n = eq.length;
    const years = n / (BARS_PER_YEAR[p.tf] || 2190);
    const ret = eq[n - 1].v / capital - 1;
    const bhRet = bh[n - 1].v / capital - 1;
    let mean = 0, sd = 0;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(eq[i].v / eq[i - 1].v - 1);
    for (const r of rets) mean += r;
    mean /= rets.length || 1;
    for (const r of rets) sd += (r - mean) ** 2;
    sd = Math.sqrt(sd / (rets.length || 1));
    const wins = trades.filter(t => t.pnl > 0);
    const grossW = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL = trades.filter(t => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0);
    const mid = Math.floor(n / 2);
    const half = (ser, a, z) => ser[z].v / ser[a].v - 1;
    return {
      eq, bh, trades, ind, start,
      stats: {
        years, ret, bhRet,
        cagr: years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : 0,
        bhCagr: years > 0 ? Math.pow(1 + bhRet, 1 / years) - 1 : 0,
        maxDD: maxDrawdown(eq), bhMaxDD: maxDrawdown(bh),
        sharpe: sd > 0 ? mean / sd * Math.sqrt(BARS_PER_YEAR[p.tf] || 2190) : 0,
        nTrades: trades.length,
        winRate: trades.length ? wins.length / trades.length : 0,
        profitFactor: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
        exposure: barsIn / n,
        h1: half(eq, 0, mid), h2: half(eq, mid, n - 1),
        bhH1: half(bh, 0, mid), bhH2: half(bh, mid, n - 1),
        openPos: !!pos
      }
    };
  }

  /* Portföy geçmiş testi: aynı kurallar her varlığa ayrı ayrı uygulanır, sermaye ortaktır.
     data = { SEMBOL: mumlar }, p.fees = { SEMBOL: tek yön borsa ücreti % }, p.maxPositions = aynı anda en çok pozisyon. */
  function backtestPortfolio(data, p) {
    const syms = Object.keys(data).filter(s => data[s] && data[s].length > p.emaSlow + p.don + 5);
    if (!syms.length) return { error: 'Yeterli veri yok', eq: [], bh: [], trades: [] };
    const gas = p.gasUsd, capital = p.capital || 1000, minTrade = p.minTradeUsd || 5, maxPos = p.maxPositions || syms.length;
    const A = {}, tset = new Set(); let start = -Infinity;
    for (const s of syms) {
      const b = data[s], ind = indicators(b, p), map = new Map(); b.forEach((x, i) => { map.set(x.t, i); tset.add(x.t); });
      let r = 0; while (r < b.length && !ready(r, ind)) r++;
      if (r >= b.length - 2) continue;
      A[s] = { b, ind, map, cost: ((p.fees && p.fees[s] != null ? p.fees[s] : p.feePct || 0.05) + p.slipPct) / 100, qty: 0, pos: null, pending: null, strength: 0, cool: -Infinity, last: b[r].c, n: 0, pnl: 0, wins: 0, bars: 0 };
      if (b[r].t > start) start = b[r].t;
    }
    const names = Object.keys(A); if (!names.length) return { error: 'Yeterli veri yok', eq: [], bh: [], trades: [] };
    const times = [...tset].filter(t => t >= start).sort((x, y) => x - y);
    if (times.length < 3) return { error: 'Yeterli veri yok', eq: [], bh: [], trades: [] };
    let cash = capital, barsIn = 0; const eq = [], bh = [], trades = [], p0 = {};
    for (const s of names) { const i = A[s].map.get(times[0]); p0[s] = i != null ? A[s].b[i].c : A[s].last; }
    const closeAt = (s, t, px, reason) => {
      const a = A[s], out = a.qty * px * (1 - a.cost) - gas, pnl = out - a.pos.usdIn; cash += out;
      trades.push({ sym: s, tIn: a.pos.t, tOut: t, entry: a.pos.entry, exit: px, usdIn: a.pos.usdIn, usdOut: out, pnl, reason });
      a.n++; a.pnl += pnl; if (pnl > 0) a.wins++; a.qty = 0; a.pos = null;
    };
    for (let k = 0; k < times.length; k++) {
      const t = times[k], here = [];
      for (const s of names) { const i = A[s].map.get(t); if (i != null) here.push([s, i]); }
      // 1) Açılışta bekleyen satışlar, sonra (güçlüden zayıfa) bekleyen alımlar
      for (const [s, i] of here) { const a = A[s]; if (a.pending === 'sell' && a.pos) { closeAt(s, t, a.b[i].o, 'trend'); a.pending = null; } }
      const buys = here.filter(([s]) => A[s].pending === 'buy' && !A[s].pos).sort((x, y) => A[y[0]].strength - A[x[0]].strength);
      for (const [s, i] of buys) {
        const a = A[s], bar = a.b[i]; a.pending = null;
        if (names.filter(n => A[n].pos).length >= maxPos) continue;
        let eqNow = cash; for (const n of names) if (A[n].qty) eqNow += A[n].qty * A[n].last;
        const amt = Math.min(cash - gas, eqNow * posFraction(bar.o, a.ind.a[i - 1], p));
        if (amt >= minTrade) { a.qty = amt * (1 - a.cost) / bar.o; cash -= amt + gas; a.pos = { t, entry: bar.o, stop: bar.o - p.atrK * a.ind.a[i - 1], hi: bar.o, usdIn: amt + gas }; }
      }
      for (const [s] of here) if (A[s].pending) A[s].pending = null;
      // 2) Mum içi stop, 3) kapanışta iz süren stop ve sinyaller
      let any = false;
      for (const [s, i] of here) {
        const a = A[s], bar = a.b[i];
        if (a.pos && bar.l <= a.pos.stop) { closeAt(s, t, Math.min(bar.o, a.pos.stop), 'stop'); a.cool = k + p.cooldown; }
        if (a.pos) {
          any = true; a.bars++;
          if (bar.c > a.pos.hi) a.pos.hi = bar.c;
          const ns = a.pos.hi - p.atrK * a.ind.a[i]; if (ns > a.pos.stop) a.pos.stop = ns;
          if (trendBroken(i, a.ind)) a.pending = 'sell';
        } else if (k >= a.cool && entryOK(i, a.b, a.ind)) { a.pending = 'buy'; a.strength = (bar.c - a.ind.d[i]) / a.ind.a[i]; }
        a.last = bar.c;
      }
      if (any) barsIn++;
      let v = cash, hold = 0; for (const s of names) { v += A[s].qty * A[s].last; hold += capital / names.length * A[s].last / p0[s]; }
      eq.push({ t, v }); bh.push({ t, v: hold });
    }
    const n = eq.length, years = n / (BARS_PER_YEAR[p.tf] || 2190), ret = eq[n - 1].v / capital - 1, bhRet = bh[n - 1].v / capital - 1;
    let mean = 0, sd = 0; const rets = []; for (let i = 1; i < n; i++) rets.push(eq[i].v / eq[i - 1].v - 1);
    for (const r of rets) mean += r; mean /= rets.length || 1; for (const r of rets) sd += (r - mean) ** 2; sd = Math.sqrt(sd / (rets.length || 1));
    const wins = trades.filter(x => x.pnl > 0), gw = wins.reduce((s, x) => s + x.pnl, 0), gl = trades.filter(x => x.pnl <= 0).reduce((s, x) => s - x.pnl, 0);
    const mid = Math.floor(n / 2), half = (ser, a, z) => ser[z].v / ser[a].v - 1;
    trades.sort((x, y) => x.tOut - y.tOut);
    return { eq, bh, trades, syms: names,
      perAsset: names.map(s => ({ sym: s, n: A[s].n, wins: A[s].wins, pnl: A[s].pnl, open: !!A[s].pos })),
      stats: { years, ret, bhRet, cagr: years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : 0, bhCagr: years > 0 ? Math.pow(Math.max(0, 1 + bhRet), 1 / years) - 1 : 0,
        maxDD: maxDrawdown(eq), bhMaxDD: maxDrawdown(bh), sharpe: sd > 0 ? mean / sd * Math.sqrt(BARS_PER_YEAR[p.tf] || 2190) : 0,
        nTrades: trades.length, winRate: trades.length ? wins.length / trades.length : 0, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
        exposure: barsIn / n, h1: half(eq, 0, mid), h2: half(eq, mid, n - 1), bhH1: half(bh, 0, mid), bhH2: half(bh, mid, n - 1), openPos: names.some(s => A[s].pos) } };
  }

  return { TF_MS, BARS_PER_YEAR, ema, atr, donchianHigh, indicators, ready, trendUp, entryOK, trendBroken, posFraction, maxDrawdown, backtest, backtestPortfolio };
})();
if (typeof module !== 'undefined') module.exports = Engine;
