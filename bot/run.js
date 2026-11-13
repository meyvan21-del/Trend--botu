'use strict';
/* Trend Botu sunucu çalıştırıcısı. GitHub Actions bunu ~10 dakikada bir çalıştırır:
   fiyatı alır, kuralları uygular, gerekirse Uniswap v3'te işlem yapar, durumu state/state.json'a yazar.
   config.json içinde "live": false iken gerçek işlem göndermez; sanal hesapla çalışır. */
const Engine = require('./engine.js');

const ADDR = {
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  ROUTER: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  QUOTER: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'
};
const POOL_FEE = 500, MIN_GAS_ETH = 0.00005, DEFAULT_RPC = 'https://arb1.arbitrum.io/rpc';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'];
const ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)', 'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])'];
const DEFAULTS = { live: false, tf: '4h', emaFast: 50, emaSlow: 200, don: 20, atrN: 14, atrK: 3, riskPct: 2, maxPosPct: 100, cooldown: 3, dailyLossPct: 3, maxDDPct: 15, maxSlipPct: 0.3, maxDevPct: 1, minTradeUsd: 5, entryWindowPct: 25, paperCash: 1000, feePct: 0.05, slipPct: 0.05, gasUsd: 0.1 };
const freshRT = () => ({ halted: null, pos: null, lastBarT: null, cooldownUntilT: 0, peakEq: null, dayKey: null, dayStartEq: null, errCount: 0 });
const usd = v => '$' + Number(v).toFixed(2);
const errMsg = e => String((e && (e.shortMessage || e.reason || e.message)) || e).slice(0, 220);

/* ---------- Fiyat verisi ---------- */
async function getJSON(fetch, url) {
  const c = new AbortController(), to = setTimeout(() => c.abort(), 12000);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(to); }
}
function checkBars(b) {
  if (!Array.isArray(b) || b.length < 50) throw new Error('Fiyat verisi eksik');
  for (let i = 0; i < b.length; i++) { const x = b[i]; if (!(x.o > 0 && x.h > 0 && x.l > 0 && x.c > 0) || x.h < x.l || (i && x.t <= b[i - 1].t)) throw new Error('Fiyat verisi bozuk'); }
  return b;
}
async function fetchBars(fetch, tf) {
  let err;
  for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const rows = await getJSON(fetch, `${h}/api/v3/klines?symbol=ETHUSDT&interval=${tf}&limit=500`);
      return { feed: 'Binance', bars: checkBars(rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }))) };
    } catch (e) { err = e; }
  }
  try {
    const iv = { '1h': 60, '4h': 240, '1d': 1440 }[tf];
    const j = await getJSON(fetch, `https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=${iv}`);
    if (j.error && j.error.length) throw new Error(j.error[0]);
    const k = Object.keys(j.result).find(x => x !== 'last');
    return { feed: 'Kraken', bars: checkBars(j.result[k].map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] }))) };
  } catch (e) { throw new Error('Fiyat verisi alınamadı: ' + errMsg(err) + ' / ' + errMsg(e)); }
}

/* ---------- Zincir ---------- */
function makeChain(E, key, rpcUrl) {
  const rpc = new E.JsonRpcProvider(rpcUrl, 42161, { staticNetwork: true, batchMaxCount: 1 });
  const bot = new E.Wallet(key.startsWith('0x') ? key : '0x' + key, rpc);
  return { rpc, bot, c: { usdc: new E.Contract(ADDR.USDC, ERC20_ABI, bot), weth: new E.Contract(ADDR.WETH, ERC20_ABI, bot), router: new E.Contract(ADDR.ROUTER, ROUTER_ABI, bot), quoter: new E.Contract(ADDR.QUOTER, QUOTER_ABI, bot) } };
}
async function chainBalances(E, W) {
  const a = W.bot.address;
  const [u, w, e] = await Promise.all([W.c.usdc.balanceOf(a), W.c.weth.balanceOf(a), W.rpc.getBalance(a)]);
  return { usdc: +E.formatUnits(u, 6), weth: +E.formatUnits(w, 18), eth: +E.formatUnits(e, 18), rawW: w, rawU: u };
}
// Tarayıcı uygulamasındaki takas işleviyle aynı adımlar
async function swap(E, W, S, tokenIn, tokenOut, amountIn, ref, side) {
  const me = W.bot.address, c = W.c;
  if (+E.formatUnits(await W.rpc.getBalance(me), 18) < MIN_GAS_ETH) throw new Error('Bot cüzdanında ağ ücreti için yeterli ETH yok.');
  const q = await c.quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n });
  const out = q[0];
  if (out <= 0n) throw new Error('Borsa teklif vermedi.');
  const implied = side === 'buy' ? +E.formatUnits(amountIn, 6) / +E.formatUnits(out, 18) : +E.formatUnits(out, 6) / +E.formatUnits(amountIn, 18);
  const dev = Math.abs(implied / ref - 1) * 100;
  if (!(dev <= S.maxDevPct)) throw new Error(`Borsa fiyatı piyasadan %${dev.toFixed(2)} sapıyor (sınır %${S.maxDevPct}). İşlem yapılmadı.`);
  const minOut = out * (10000n - BigInt(Math.round(S.maxSlipPct * 100))) / 10000n;
  const tIn = tokenIn === ADDR.USDC ? c.usdc : c.weth, tOut = tokenOut === ADDR.USDC ? c.usdc : c.weth;
  if (await tIn.allowance(me, ADDR.ROUTER) < amountIn) { const a = await tIn.approve(ADDR.ROUTER, amountIn); const ar = await a.wait(); if (!ar || ar.status !== 1) throw new Error('Harcama izni işlemi başarısız.'); }
  const before = await tOut.balanceOf(me);
  const data = c.router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: POOL_FEE, recipient: me, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  await c.router.multicall.staticCall(deadline, [data]);
  const tx = await c.router.multicall(deadline, [data]);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error('Takas işlemi zincirde başarısız oldu.');
  const got = (await tOut.balanceOf(me)) - before;
  if (got < minOut) throw new Error('Takas beklenenden az getirdi.');
  return { got, hash: tx.hash };
}
async function preflight(E, W, S, live) {
  const out = [], chk = (ok, text) => out.push({ ok: !!ok, text });
  try {
    chk((await W.rpc.getNetwork()).chainId === 42161n, 'Ağ: Arbitrum One');
    const [su, du, sw, dw] = await Promise.all([W.c.usdc.symbol(), W.c.usdc.decimals(), W.c.weth.symbol(), W.c.weth.decimals()]);
    chk(su === 'USDC' && Number(du) === 6, 'USDC sözleşmesi');
    chk(sw === 'WETH' && Number(dw) === 18, 'WETH sözleşmesi');
    const q = await W.c.quoter.quoteExactInputSingle.staticCall({ tokenIn: ADDR.USDC, tokenOut: ADDR.WETH, amountIn: 100000000n, fee: POOL_FEE, sqrtPriceLimitX96: 0n });
    const px = 100 / +E.formatUnits(q[0], 18), dev = Math.abs(px / live - 1) * 100;
    chk(dev <= S.maxDevPct, `Borsa fiyatı ${usd(px)}, piyasa ${usd(live)} (fark %${dev.toFixed(2)})`);
  } catch (e) { chk(false, 'Kontrol tamamlanamadı: ' + errMsg(e)); }
  return out;
}

/* ---------- Tek çalıştırma ---------- */
async function main(d) {
  const E = d.ethers, env = d.env || {}, now = d.now ? d.now() : Date.now();
  const S = Object.assign({}, DEFAULTS, JSON.parse(d.read('bot/config.json')));
  let st = {}; try { st = JSON.parse(d.read('state/state.json')) || {}; } catch (e) { st = {}; }
  st.v = 1; st.rt = st.rt || {}; st.trades = st.trades || []; st.events = st.events || [];
  if (!st.paper) st.paper = { usdc: S.paperCash, weth: 0 };
  const mode = S.live ? 'live' : 'paper';
  const R = st.rt[mode] = Object.assign(freshRT(), st.rt[mode]);
  const sig = () => JSON.stringify([mode, !!R.pos, R.halted && R.halted.kind, R.lastBarT, st.trades.length, st.events.length && st.events[0].msg]);
  const before = sig(), wasHalted = R.halted && R.halted.kind;
  const ev = (msg, bad) => { if (st.events[0] && st.events[0].msg === msg) { st.events[0].t = now; return; } st.events.unshift({ t: now, msg, bad: !!bad }); if (st.events.length > 40) st.events.length = 40; };
  if (st.mode && st.mode !== mode) ev(mode === 'live' ? 'Gerçek para moduna geçildi.' : 'Deneme moduna geçildi.');
  st.mode = mode; st.settings = { tf: S.tf, emaFast: S.emaFast, emaSlow: S.emaSlow, don: S.don, atrK: S.atrK, riskPct: S.riskPct, dailyLossPct: S.dailyLossPct, maxDDPct: S.maxDDPct };
  if (String(env.RESET_HALT) === 'true' && R.halted) { R.halted = null; R.errCount = 0; R.peakEq = null; ev('Güvenlik freni elle kaldırıldı.'); }

  const finish = (exitCode) => {
    st.lastRun = now;
    const changed = sig() !== before || !st.savedAt || now - st.savedAt >= 55 * 60e3;
    if (changed) st.savedAt = now;
    d.write('state/state.json', JSON.stringify(st, null, 1));
    return { changed, exitCode: exitCode || 0, state: st };
  };

  // 1) Fiyat
  let M;
  try {
    const { bars, feed } = await fetchBars(d.fetch, S.tf), tfMs = Engine.TF_MS[S.tf];
    if (now - bars[bars.length - 1].t > 2 * tfMs) throw new Error('Fiyat verisi güncel değil');
    const closed = bars.filter(b => b.t + tfMs <= now);
    M = { closed, live: bars[bars.length - 1].c, ind: Engine.indicators(closed, S), tfMs, feed };
    st.price = M.live; st.feed = feed; st.dataErr = null;
  } catch (e) { st.dataErr = errMsg(e); ev('Fiyat verisi alınamadı; bu turda işlem yapılmadı.', true); return finish(0); }
  const { closed, live, ind, tfMs } = M, i = closed.length - 1;
  st.trendUp = Engine.trendUp(i, closed, ind); st.breakout = Engine.ready(i, ind) ? ind.d[i] : null;

  // 2) Cüzdan
  let W = null;
  try {
    if (env.BOT_PRIVATE_KEY) { W = makeChain(E, env.BOT_PRIVATE_KEY.trim(), (env.RPC_URL || '').trim() || DEFAULT_RPC); st.address = W.bot.address; }
    if (S.live && !W) throw new Error('Gerçek para modu açık ama BOT_PRIVATE_KEY gizli değeri tanımlı değil.');
    if (W) { st.preflight = await preflight(E, W, S, live); st.wallet = await chainBalances(E, W).then(b => ({ usdc: b.usdc, weth: b.weth, eth: b.eth })); }
    if (S.live && st.preflight.some(p => !p.ok)) throw new Error('Ön kontrol geçmedi: ' + st.preflight.filter(p => !p.ok).map(p => p.text).join('; '));
  } catch (e) {
    ev('Hata: ' + errMsg(e), true);
    if (S.live) { R.errCount = (R.errCount || 0) + 1; if (R.errCount >= 3 && !R.halted) { R.halted = { kind: 'err', reason: 'Art arda 3 hata oluştu: ' + errMsg(e) }; } return finish(R.halted && !wasHalted ? 1 : 0); }
  }

  const cost = (S.feePct + S.slipPct) / 100;
  const A = S.live ? {
    balances: () => chainBalances(E, W),
    async buy(amt, ref) { const r = await swap(E, W, S, ADDR.USDC, ADDR.WETH, E.parseUnits(amt.toFixed(6), 6), ref, 'buy'); const qty = +E.formatUnits(r.got, 18); return { qty, price: amt / qty, usd: amt, hash: r.hash }; },
    async sellAll(ref) { const b = await chainBalances(E, W), r = await swap(E, W, S, ADDR.WETH, ADDR.USDC, b.rawW, ref, 'sell'); const out = +E.formatUnits(r.got, 6); return { qty: b.weth, price: out / b.weth, usd: out, hash: r.hash }; }
  } : {
    async balances() { return { usdc: st.paper.usdc, weth: st.paper.weth, eth: null }; },
    async buy(amt, ref) { const qty = amt * (1 - cost) / ref; st.paper.usdc -= amt + S.gasUsd; st.paper.weth += qty; return { qty, price: amt / qty, usd: amt }; },
    async sellAll(ref) { const qty = st.paper.weth, out = qty * ref * (1 - cost) - S.gasUsd; st.paper.usdc += out; st.paper.weth = 0; return { qty, price: out / qty, usd: out }; }
  };

  // 3) Karar ve işlem (tarayıcı botuyla aynı kurallar)
  let traded = false;
  try {
    let bal = await A.balances(), eq = bal.usdc + bal.weth * live;
    // Dışarıdan para girişi/çıkışı zarar gibi sayılmasın
    if (S.live && st.prevBal && R.peakEq != null) {
      const flow = (bal.usdc - st.prevBal.usdc) + (bal.weth - st.prevBal.weth) * live;
      if (Math.abs(flow) > Math.max(0.5, eq * 0.002)) {
        R.peakEq = Math.max(eq, R.peakEq + flow); if (R.dayStartEq != null) R.dayStartEq = Math.max(0, R.dayStartEq + flow);
        ev(`Cüzdanda ${flow > 0 ? 'para girişi' : 'para çıkışı'} algılandı (${usd(Math.abs(flow))}); sınırlar buna göre güncellendi.`);
      }
    }
    const hasPos = bal.weth * live >= 1;
    if (!hasPos && R.pos) R.pos = null;
    if (hasPos && !R.pos && Engine.ready(i, ind)) { R.pos = { qty: bal.weth, entry: live, stop: live - S.atrK * ind.a[i], hi: live, t: now }; ev('Cüzdanda ETH bulundu; pozisyon olarak devralındı, stop ' + usd(R.pos.stop) + '.'); }
    if (R.pos) R.pos.qty = bal.weth;
    const dk = new Date(now).toISOString().slice(0, 10);
    if (R.dayKey !== dk || R.dayStartEq == null) { R.dayKey = dk; R.dayStartEq = eq; if (R.halted && R.halted.kind === 'day') { R.halted = null; ev('Yeni gün: günlük zarar freni kalktı.'); } }
    if (R.peakEq == null || eq > R.peakEq) R.peakEq = eq;
    const snap = () => { st.bal = { usdc: bal.usdc, weth: bal.weth, eth: bal.eth }; st.eq = bal.usdc + bal.weth * live; if (S.live) st.prevBal = { usdc: bal.usdc, weth: bal.weth }; };
    snap();
    const logTrade = x => { st.trades.push(Object.assign({ t: now, mode }, x)); if (st.trades.length > 60) st.trades = st.trades.slice(-60); traded = true; };
    const exit = async reason => {
      if (!R.pos) return;
      const r = await A.sellAll(live);
      logTrade({ side: 'Satış', qty: r.qty, price: r.price, usd: r.usd, reason, hash: r.hash, pnl: R.pos.usdIn != null ? r.usd - R.pos.usdIn : null });
      ev(`Satıldı: ${r.qty.toFixed(4)} ETH, ${usd(r.price)} fiyattan (${reason}).`);
      R.pos = null; bal = await A.balances(); snap();
    };
    if (!R.halted) {
      if (R.dayStartEq > 0 && eq <= R.dayStartEq * (1 - S.dailyLossPct / 100)) {
        await exit('günlük zarar sınırı');
        R.halted = { kind: 'day', reason: `Bugünkü zarar %${S.dailyLossPct} sınırını aştı. Bot yarın (UTC gece yarısı) kendiliğinden devam eder.` }; ev('Günlük zarar freni devreye girdi.', true);
      } else if (R.peakEq > 0 && eq <= R.peakEq * (1 - S.maxDDPct / 100)) {
        await exit('zirveden düşüş sınırı');
        R.halted = { kind: 'dd', reason: `Hesap zirvesinden %${S.maxDDPct} düştü. Bot, fren elle kaldırılana kadar işlem yapmaz.` }; ev('Zirveden düşüş freni devreye girdi.', true);
      } else if (R.pos && live <= R.pos.stop) {
        await exit('stop'); R.cooldownUntilT = now + S.cooldown * tfMs;
      } else if (Engine.ready(i, ind)) {
        const newBar = closed[i].t !== R.lastBarT;
        if (R.pos) {
          if (newBar) { if (closed[i].c > R.pos.hi) R.pos.hi = closed[i].c; const ns = R.pos.hi - S.atrK * ind.a[i]; if (ns > R.pos.stop) R.pos.stop = ns; }
          if (Engine.trendBroken(i, ind)) await exit('trend bozuldu');
        } else if (newBar) {
          const fresh = now - (closed[i].t + tfMs) < tfMs * S.entryWindowPct / 100;
          if (fresh && now >= (R.cooldownUntilT || 0) && Engine.entryOK(i, closed, ind)) {
            const frac = Engine.posFraction(live, ind.a[i], S);
            const amt = Math.floor(Math.min(bal.usdc * 0.998 - (S.live ? 0 : S.gasUsd), eq * frac) * 100) / 100;
            if (amt < S.minTradeUsd) ev('Alım sinyali geldi ama tutar en küçük işlemin altında; atlandı.');
            else {
              const r = await A.buy(amt, live);
              R.pos = { qty: r.qty, entry: r.price, stop: live - S.atrK * ind.a[i], hi: live, t: now, usdIn: r.usd };
              logTrade({ side: 'Alış', qty: r.qty, price: r.price, usd: r.usd, reason: 'trend + kırılım', hash: r.hash });
              ev(`Alındı: ${r.qty.toFixed(4)} ETH, ${usd(r.price)} fiyattan. Stop ${usd(R.pos.stop)}.`);
              bal = await A.balances(); snap();
            }
          }
        }
        R.lastBarT = closed[i].t;
      }
    }
    R.errCount = 0;
  } catch (e) {
    ev('Hata: ' + errMsg(e), true);
    R.errCount = (R.errCount || 0) + 1;
    if (R.errCount >= 3 && !R.halted) R.halted = { kind: 'err', reason: 'Art arda 3 hata oluştu: ' + errMsg(e) };
  }
  // Yeni devreye giren kalıcı fren, iş akışını "başarısız" bitirir; GitHub e-postayla haber verir
  const newHalt = R.halted && R.halted.kind !== 'day' && R.halted.kind !== wasHalted;
  return finish(newHalt ? 1 : 0);
}

if (require.main === module) {
  const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..');
  main({
    ethers: require('ethers'), fetch: globalThis.fetch, env: process.env,
    read: f => fs.readFileSync(path.join(root, f), 'utf8'),
    write: (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  }).then(r => {
    const s = r.state, R = s.rt[s.mode];
    console.log(`[${s.mode}] fiyat ${s.price} | değer ${s.eq} | pozisyon ${R.pos ? R.pos.qty : 'yok'} | fren ${R.halted ? R.halted.kind : 'yok'}`);
    for (const e of s.events.slice(0, 5)) console.log(' -', new Date(e.t).toISOString(), e.msg);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${r.changed}\n`);
    process.exitCode = r.exitCode;
  }).catch(e => { console.error('Beklenmeyen hata:', e); process.exitCode = 1; });
}
module.exports = { main };
