/* Ortak çekirdek: varlık listesi, fiyat verisi, karar adımı, Uniswap v3 işlemleri.
   Tarayıcı paneli ve sunucu botu aynı dosyayı kullanır; ethers ve fetch dışarıdan verilir. */
const Core = (() => {
  const Eng = typeof Engine !== 'undefined' ? Engine : require('./engine.js');

  /* Arbitrum One adresleri (küçük harf). Kaynaklar: Uniswap, Circle, Chainlink ve Arbitrum belgeleri.
     Ön kontrol her birinin sembolünü, ondalığını ve borsa fiyatını zincirde ayrıca doğrular.
     fee: USDC ile arasındaki tipik tek yön havuz ücreti (%); simülasyon ve geçmiş testi maliyeti için. */
  const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const ROUTER = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';   // Uniswap v3 SwapRouter02
  const QUOTER = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e';   // Uniswap v3 QuoterV2
  const ASSETS = [
    { sym: 'ETH', token: 'WETH', addr: WETH, dec: 18, bin: 'ETHUSDT', kr: 'ETHUSD', fee: 0.05 },
    { sym: 'BTC', token: 'WBTC', addr: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', dec: 8, bin: 'BTCUSDT', kr: 'XBTUSD', fee: 0.10 },
    { sym: 'ARB', token: 'ARB', addr: '0x912ce59144191c1204e64559fe8253a0e49e6548', dec: 18, bin: 'ARBUSDT', kr: 'ARBUSD', fee: 0.10 },
    { sym: 'LINK', token: 'LINK', addr: '0xf97f4df75117a78c1a5a0dbb814af92458539fb4', dec: 18, bin: 'LINKUSDT', kr: 'LINKUSD', fee: 0.35 },
    { sym: 'GMX', token: 'GMX', addr: '0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a', dec: 18, bin: 'GMXUSDT', kr: 'GMXUSD', fee: 0.35 }
  ];
  const bySym = Object.fromEntries(ASSETS.map(a => [a.sym, a]));
  const FEES = Object.fromEntries(ASSETS.map(a => [a.sym, a.fee]));
  const FEE_TIERS = [500, 3000, 10000], MIN_GAS_ETH = 0.00005, DEFAULT_RPC = 'https://arb1.arbitrum.io/rpc';
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'];
  const QUOTER_ABI = ['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'];
  const ROUTER_ABI = ['function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)', 'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])'];

  const DEFAULTS = {
    tf: '4h', emaFast: 50, emaSlow: 200, don: 20, atrN: 14, atrK: 3, riskPct: 2, maxPosPct: 50, maxPositions: 2, cooldown: 3,
    assets: ['ETH', 'BTC'],   // gerçek veriyle yapılan karşılaştırmada en tutarlı çıkan liste
    dailyLossPct: 3, maxDDPct: 15, maxSlipPct: 0.3, maxDevPct: 1, minTradeUsd: 5,
    rpc: DEFAULT_RPC, paperCash: 1000, slipPct: 0.05, gasUsd: 0.1
  };
  const freshRT = () => ({ halted: null, positions: {}, barT: {}, cool: {}, lastPx: {}, peakEq: null, dayKey: null, dayStartEq: null, errCount: 0 });
  // Eski tek varlıklı kayıtları yeni biçime taşır
  function migrateRT(R) {
    R.positions = R.positions || {}; R.barT = R.barT || {}; R.cool = R.cool || {}; R.lastPx = R.lastPx || {};
    if (R.pos) { R.positions.ETH = R.pos; } delete R.pos;
    if (R.lastBarT) { R.barT.ETH = R.lastBarT; } delete R.lastBarT;
    if (R.cooldownUntilT) { R.cool.ETH = R.cooldownUntilT; } delete R.cooldownUntilT;
    return R;
  }
  const enabled = S => ASSETS.filter(a => (S.assets || []).includes(a.sym));
  const errMsg = e => {
    if (!e) return 'Bilinmeyen hata';
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') return 'İşlem MetaMask\'ta reddedildi.';
    return String(e.shortMessage || e.reason || e.message || e).slice(0, 220);
  };
  const usd2 = v => '$' + Number(v).toFixed(2);

  /* ---------- Fiyat verisi ---------- */
  async function getJSON(fetch, url) {
    const c = new AbortController(), to = setTimeout(() => c.abort(), 12000);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(to); }
  }
  function checkBars(b, min) {
    if (!Array.isArray(b) || b.length < (min || 50)) throw new Error('Fiyat verisi eksik');
    for (let i = 0; i < b.length; i++) { const x = b[i]; if (!(x.o > 0 && x.h > 0 && x.l > 0 && x.c > 0) || x.h < x.l || (i && x.t <= b[i - 1].t)) throw new Error('Fiyat verisi bozuk'); }
    return b;
  }
  async function binance(fetch, a, tf, limit, endTime) {
    let err;
    for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) {
      try { const rows = await getJSON(fetch, `${h}/api/v3/klines?symbol=${a.bin}&interval=${tf}&limit=${limit}${endTime ? '&endTime=' + endTime : ''}`); return rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })); }
      catch (e) { err = e; }
    }
    throw err;
  }
  async function kraken(fetch, a, tf) {
    const j = await getJSON(fetch, `https://api.kraken.com/0/public/OHLC?pair=${a.kr}&interval=${{ '1h': 60, '4h': 240, '1d': 1440 }[tf]}`);
    if (j.error && j.error.length) throw new Error(j.error[0]);
    const k = Object.keys(j.result).find(x => x !== 'last');
    return j.result[k].map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
  }
  async function fetchRecent(fetch, a, tf) {
    try { return { feed: 'Binance', bars: checkBars(await binance(fetch, a, tf, 500)) }; }
    catch (e) { return { feed: 'Kraken', bars: checkBars(await kraken(fetch, a, tf)) }; }
  }
  // Seçili tüm varlıklar için güncel piyasa: { mkt: {SEMBOL: {closed, live, ind}}, errs, feed }
  async function fetchMarket(fetch, S, now, extraSyms) {
    const tfMs = Eng.TF_MS[S.tf], mkt = {}, errs = {}; let feed = '';
    const list = ASSETS.filter(a => (S.assets || []).includes(a.sym) || (extraSyms || []).includes(a.sym));
    await Promise.all(list.map(async a => {
      try {
        const r = await fetchRecent(fetch, a, S.tf), bars = r.bars;
        if (now - bars[bars.length - 1].t > 2 * tfMs) throw new Error('Fiyat verisi güncel değil');
        const closed = bars.filter(b => b.t + tfMs <= now);
        mkt[a.sym] = { closed, live: bars[bars.length - 1].c, ind: Eng.indicators(closed, S) }; feed = feed || r.feed;
      } catch (e) { errs[a.sym] = errMsg(e); }
    }));
    return { mkt, errs, feed };
  }
  async function fetchHistory(fetch, a, tf, bars, onProg) {
    let out = [], end;
    try {
      while (out.length < bars) {
        const page = await binance(fetch, a, tf, 1000, end);
        if (!page.length) break;
        out = page.concat(out); end = page[0].t - 1; if (onProg) onProg(Math.min(1, out.length / bars));
        if (page.length < 1000) break;
      }
    } catch (e) { if (!out.length) out = await kraken(fetch, a, tf); }
    const tfMs = Eng.TF_MS[tf];
    return checkBars(out.filter(b => b.t + tfMs <= Date.now()).slice(-bars), 10);
  }

  /* ---------- Simülasyon hesabı ---------- */
  function paperAdapter(P, S) {
    P.tok = P.tok || {};
    const cost = s => (bySym[s].fee + S.slipPct) / 100;
    return {
      async balances() { return { usdc: P.usdc, tok: Object.assign({}, P.tok), eth: null }; },
      async buy(s, amt, ref) { const qty = amt * (1 - cost(s)) / ref; P.usdc -= amt + S.gasUsd; P.tok[s] = (P.tok[s] || 0) + qty; return { qty, price: amt / qty, usd: amt }; },
      async sellAll(s, ref) { const qty = P.tok[s] || 0, out = qty * ref * (1 - cost(s)) - S.gasUsd; P.usdc += out; P.tok[s] = 0; return { qty, price: out / qty, usd: out }; }
    };
  }

  /* ---------- Zincir: bot cüzdanı + Uniswap v3 ---------- */
  function makeChain(E, bot, rpc) {
    const tok = {}; for (const a of ASSETS) tok[a.sym] = new E.Contract(a.addr, ERC20_ABI, bot);
    return { rpc, bot, c: { usdc: new E.Contract(USDC, ERC20_ABI, bot), router: new E.Contract(ROUTER, ROUTER_ABI, bot), quoter: new E.Contract(QUOTER, QUOTER_ABI, bot), tok } };
  }
  // USDC ile varlık arasındaki aday rotalar: doğrudan havuzlar ve WETH üzerinden iki adım
  function routes(E, a, side) {
    const out = [], pack = (toks, fees) => { const types = ['address'], vals = [toks[0]]; fees.forEach((f, i) => { types.push('uint24', 'address'); vals.push(f, toks[i + 1]); }); return E.solidityPacked(types, vals); };
    for (const f of FEE_TIERS) out.push(side === 'buy' ? pack([USDC, a.addr], [f]) : pack([a.addr, USDC], [f]));
    if (a.addr !== WETH) for (const f of FEE_TIERS) out.push(side === 'buy' ? pack([USDC, WETH, a.addr], [500, f]) : pack([a.addr, WETH, USDC], [f, 500]));
    return out;
  }
  async function bestQuote(E, W, a, side, amountIn) {
    const paths = routes(E, a, side);
    const res = await Promise.allSettled(paths.map(p => W.c.quoter.quoteExactInput.staticCall(p, amountIn)));
    let best = null;
    res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value[0] > 0n && (!best || r.value[0] > best.out)) best = { out: r.value[0], path: paths[i] }; });
    if (!best) throw new Error(a.sym + ' için borsa teklif vermedi.');
    return best;
  }
  const impliedPrice = (E, a, side, usdcAmt, tokAmt) => +E.formatUnits(usdcAmt, 6) / +E.formatUnits(tokAmt, a.dec);
  async function swap(E, W, S, a, side, amountIn, ref) {
    const me = W.bot.address, c = W.c;
    if (+E.formatUnits(await W.rpc.getBalance(me), 18) < MIN_GAS_ETH) throw new Error('Bot cüzdanında ağ ücreti için yeterli ETH yok.');
    // 1) En iyi rotayı ve teklifi bul  2) Teklifi piyasa fiyatıyla karşılaştır
    const q = await bestQuote(E, W, a, side, amountIn);
    const implied = side === 'buy' ? impliedPrice(E, a, side, amountIn, q.out) : impliedPrice(E, a, side, q.out, amountIn);
    const dev = Math.abs(implied / ref - 1) * 100;
    if (!(dev <= S.maxDevPct)) throw new Error(`${a.sym}: borsa fiyatı piyasadan %${dev.toFixed(2)} sapıyor (sınır %${S.maxDevPct}). İşlem yapılmadı.`);
    const minOut = q.out * (10000n - BigInt(Math.round(S.maxSlipPct * 100))) / 10000n;
    // 3) Yalnızca gereken tutar kadar harcama izni
    const tIn = side === 'buy' ? c.usdc : c.tok[a.sym], tOut = side === 'buy' ? c.tok[a.sym] : c.usdc;
    if (await tIn.allowance(me, ROUTER) < amountIn) { const ap = await tIn.approve(ROUTER, amountIn); const ar = await ap.wait(); if (!ar || ar.status !== 1) throw new Error('Harcama izni işlemi başarısız.'); }
    // 4) Önce zincirde dene (ücretsiz), sonra gönder. Süre sınırı: 2 dakika.
    const before = await tOut.balanceOf(me);
    const data = c.router.interface.encodeFunctionData('exactInput', [{ path: q.path, recipient: me, amountIn, amountOutMinimum: minOut }]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    await c.router.multicall.staticCall(deadline, [data]);
    const tx = await c.router.multicall(deadline, [data]);
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error('Takas işlemi zincirde başarısız oldu.');
    const got = (await tOut.balanceOf(me)) - before;
    if (got < minOut) throw new Error('Takas beklenenden az getirdi; bakiyeni kontrol et.');
    return { got, hash: tx.hash };
  }
  async function chainBalances(E, W) {
    const me = W.bot.address;
    const [u, e, ...ts] = await Promise.all([W.c.usdc.balanceOf(me), W.rpc.getBalance(me)].concat(ASSETS.map(a => W.c.tok[a.sym].balanceOf(me))));
    const tok = {}, raw = { usdc: u }; ASSETS.forEach((a, i) => { tok[a.sym] = +E.formatUnits(ts[i], a.dec); raw[a.sym] = ts[i]; });
    return { usdc: +E.formatUnits(u, 6), eth: +E.formatUnits(e, 18), tok, raw };
  }
  function liveAdapter(E, W, S) {
    return {
      balances: () => chainBalances(E, W),
      async buy(s, amt, ref) { const a = bySym[s], r = await swap(E, W, S, a, 'buy', E.parseUnits(amt.toFixed(6), 6), ref); const qty = +E.formatUnits(r.got, a.dec); return { qty, price: amt / qty, usd: amt, hash: r.hash }; },
      async sellRaw(s, raw, ref) { const a = bySym[s], r = await swap(E, W, S, a, 'sell', raw, ref); const qty = +E.formatUnits(raw, a.dec), out = +E.formatUnits(r.got, 6); return { qty, price: out / qty, usd: out, hash: r.hash, got: r.got }; },
      async sellAll(s, ref) { const b = await chainBalances(E, W); return this.sellRaw(s, b.raw[s], ref); }
    };
  }
  /* Ön kontrol. base: ağ ve USDC; assets: her varlık için sembol, ondalık ve borsa fiyatı.
     Yalnızca kontrolü geçen varlıklarda alım yapılır. */
  async function preflight(E, W, S, mkt) {
    const base = [], assets = {}, chk = (ok, text) => base.push({ ok: !!ok, text });
    try {
      chk((await W.rpc.getNetwork()).chainId === 42161n, 'Ağ: Arbitrum One');
      const [su, du, cr, cq] = await Promise.all([W.c.usdc.symbol(), W.c.usdc.decimals(), W.rpc.getCode(ROUTER), W.rpc.getCode(QUOTER)]);
      chk(su === 'USDC' && Number(du) === 6, 'USDC sözleşmesi');
      chk(cr.length > 2 && cq.length > 2, 'Uniswap v3 sözleşmeleri zincirde mevcut');
    } catch (e) { chk(false, 'Kontrol tamamlanamadı: ' + errMsg(e)); }
    await Promise.all(enabled(S).map(async a => {
      try {
        const m = mkt[a.sym]; if (!m) throw new Error('piyasa fiyatı yok');
        const [sy, de] = await Promise.all([W.c.tok[a.sym].symbol(), W.c.tok[a.sym].decimals()]);
        if (sy !== a.token || Number(de) !== a.dec) throw new Error(`sözleşme beklenenle uyuşmuyor (${sy}, ${de})`);
        const q = await bestQuote(E, W, a, 'buy', 100000000n), px = impliedPrice(E, a, 'buy', 100000000n, q.out), dev = Math.abs(px / m.live - 1) * 100;
        if (!(dev <= S.maxDevPct)) throw new Error(`borsa fiyatı ${usd2(px)}, piyasa ${usd2(m.live)} (fark %${dev.toFixed(2)})`);
        assets[a.sym] = { ok: true, text: `borsa ${usd2(px)}, piyasa ${usd2(m.live)} (fark %${dev.toFixed(2)})` };
      } catch (e) { assets[a.sym] = { ok: false, text: errMsg(e) }; }
    }));
    return { base, assets, baseOK: base.every(x => x.ok), tradeable: Object.keys(assets).filter(s => assets[s].ok) };
  }

  /* ---------- Karar adımı: her turda bir kez ---------- */
  async function step(c) {
    const { S, mkt, A, now, ev, logTrade } = c, R = migrateRT(c.R), tfMs = Eng.TF_MS[S.tf];
    let bal = await A.balances();
    for (const s in mkt) R.lastPx[s] = mkt[s].live;
    const px = s => mkt[s] ? mkt[s].live : R.lastPx[s];
    const equity = b => b.usdc + ASSETS.reduce((t, a) => t + (b.tok[a.sym] || 0) * (px(a.sym) || 0), 0);
    const eq = equity(bal);
    // Cüzdandaki varlıklarla kayıtlı pozisyonları eşle
    for (const a of ASSETS) {
      const s = a.sym, q = bal.tok[s] || 0, p = px(s), held = p > 0 && q * p >= 1, m = mkt[s];
      if (!held && R.positions[s] && p > 0) delete R.positions[s];
      if (held && !R.positions[s] && m && Eng.ready(m.closed.length - 1, m.ind)) {
        R.positions[s] = { qty: q, entry: m.live, stop: m.live - S.atrK * m.ind.a[m.closed.length - 1], hi: m.live, t: now };
        ev(`Cüzdanda ${s} bulundu; pozisyon olarak devralındı, stop ${usd2(R.positions[s].stop)}.`);
      }
      if (R.positions[s]) R.positions[s].qty = q;
    }
    const dk = new Date(now).toISOString().slice(0, 10);
    if (R.dayKey !== dk || R.dayStartEq == null) { R.dayKey = dk; R.dayStartEq = eq; if (R.halted && R.halted.kind === 'day') { R.halted = null; ev('Yeni gün: günlük zarar freni kalktı.'); } }
    if (R.peakEq == null || eq > R.peakEq) R.peakEq = eq;
    const view = () => ({ bal, eq: equity(bal) });
    if (!c.active) return view();

    const errors = [];
    const exit = async (s, reason) => {
      const pos = R.positions[s], m = mkt[s]; if (!pos) return;
      if (!m) throw new Error(s + ' için fiyat verisi yok; satış yapılamadı.');
      const r = await A.sellAll(s, m.live);
      logTrade({ sym: s, side: 'Satış', qty: r.qty, price: r.price, usd: r.usd, reason, hash: r.hash, pnl: pos.usdIn != null ? r.usd - pos.usdIn : null });
      ev(`Satıldı: ${r.qty.toFixed(4)} ${s}, ${usd2(r.price)} fiyattan (${reason}).`);
      delete R.positions[s]; bal = await A.balances();
    };
    const exitAll = async reason => { for (const s of Object.keys(R.positions)) { try { await exit(s, reason); } catch (e) { errors.push(e); } } };
    const done = () => { if (errors.length) throw errors[0]; return view(); };

    // Güvenlik frenleri her şeyden önce gelir. Fren devredeyken kalan pozisyon varsa kapatmayı yeniden dener.
    if (R.halted && (R.halted.kind === 'day' || R.halted.kind === 'dd')) { await exitAll(R.halted.kind === 'day' ? 'günlük zarar sınırı' : 'zirveden düşüş sınırı'); return done(); }
    if (!R.halted) {
      if (R.dayStartEq > 0 && eq <= R.dayStartEq * (1 - S.dailyLossPct / 100)) {
        R.halted = { kind: 'day', reason: `Bugünkü zarar %${S.dailyLossPct} sınırını aştı. Bot yarın (UTC gece yarısı) kendiliğinden devam eder.` }; ev('Günlük zarar freni devreye girdi.', true);
        await exitAll('günlük zarar sınırı'); return done();
      }
      if (R.peakEq > 0 && eq <= R.peakEq * (1 - S.maxDDPct / 100)) {
        R.halted = { kind: 'dd', reason: `Hesap zirvesinden %${S.maxDDPct} düştü. Bot, fren kaldırılana kadar işlem yapmaz.` }; ev('Zirveden düşüş freni devreye girdi.', true);
        await exitAll('zirveden düşüş sınırı'); return done();
      }
    }
    // Açık pozisyonlar: stop, iz süren stop, trend çıkışı (hata freni devredeyken de çalışır)
    for (const s of Object.keys(R.positions)) {
      const pos = R.positions[s], m = mkt[s];
      if (!m) { ev(`${s} fiyatı alınamadı; stop bu turda denetlenemedi.`, true); continue; }
      const i = m.closed.length - 1;
      try {
        if (m.live <= pos.stop) { await exit(s, 'stop'); R.cool[s] = now + S.cooldown * tfMs; continue; }
        if (!Eng.ready(i, m.ind)) continue;
        if (m.closed[i].t !== R.barT[s]) { if (m.closed[i].c > pos.hi) pos.hi = m.closed[i].c; const ns = pos.hi - S.atrK * m.ind.a[i]; if (ns > pos.stop) pos.stop = ns; }
        if (Eng.trendBroken(i, m.ind)) await exit(s, 'trend bozuldu');
        R.barT[s] = m.closed[i].t;
      } catch (e) { errors.push(e); }
    }
    // Tarama: yeni kapanan mumda trend + kırılım veren varlıklar, güçlüden zayıfa
    if (!R.halted) {
      const cands = [];
      for (const a of enabled(S)) {
        const s = a.sym, m = mkt[s]; if (R.positions[s] || !m) continue;
        const i = m.closed.length - 1; if (!Eng.ready(i, m.ind) || m.closed[i].t === R.barT[s]) continue;
        R.barT[s] = m.closed[i].t;
        const fresh = now - (m.closed[i].t + tfMs) < tfMs * (c.freshPct || 15) / 100;   // bayat sinyalle alım yapma
        if (!fresh || now < (R.cool[s] || 0) || !Eng.entryOK(i, m.closed, m.ind)) continue;
        if (c.tradeable && !c.tradeable.includes(s)) { ev(`${s}: alım sinyali var ama ön kontrolü geçmediği için atlandı.`, true); continue; }
        cands.push({ s, m, i, strength: (m.closed[i].c - m.ind.d[i]) / m.ind.a[i] });
      }
      cands.sort((x, y) => y.strength - x.strength);
      for (const { s, m, i } of cands) {
        if (Object.keys(R.positions).length >= S.maxPositions) { ev(`${s}: alım sinyali var ama pozisyon sınırı (${S.maxPositions}) dolu.`); continue; }
        const amt = Math.floor(Math.min(bal.usdc * 0.998 - (c.paperGas || 0), equity(bal) * Eng.posFraction(m.live, m.ind.a[i], S)) * 100) / 100;
        if (amt < S.minTradeUsd) { ev(`${s}: alım sinyali var ama tutar en küçük işlemin altında; atlandı.`); continue; }
        try {
          const r = await A.buy(s, amt, m.live);
          R.positions[s] = { qty: r.qty, entry: r.price, stop: m.live - S.atrK * m.ind.a[i], hi: m.live, t: now, usdIn: r.usd };
          logTrade({ sym: s, side: 'Alış', qty: r.qty, price: r.price, usd: r.usd, reason: 'trend + kırılım', hash: r.hash });
          ev(`Alındı: ${r.qty.toFixed(4)} ${s}, ${usd2(r.price)} fiyattan. Stop ${usd2(R.positions[s].stop)}.`);
          bal = await A.balances();
        } catch (e) { ev(`${s} alımı yapılamadı: ${errMsg(e)}`, true); }
      }
    }
    return done();
  }

  return { USDC, WETH, ROUTER, QUOTER, ASSETS, bySym, FEES, MIN_GAS_ETH, DEFAULT_RPC, ERC20_ABI, DEFAULTS, freshRT, migrateRT, enabled, errMsg,
    fetchMarket, fetchHistory, paperAdapter, makeChain, bestQuote, swap, chainBalances, liveAdapter, preflight, step };
})();
if (typeof module !== 'undefined') module.exports = Core;
