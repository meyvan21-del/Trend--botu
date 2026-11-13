'use strict';
/* Trend Botu sunucu çalıştırıcısı. GitHub Actions bunu düzenli aralıklarla çalıştırır:
   seçili varlıkları tarar, kuralları uygular, gerekirse Uniswap v3'te işlem yapar, durumu state/state.json'a yazar.
   config.json içinde "live": false iken gerçek işlem göndermez; sanal hesapla çalışır.
   Karar ve işlem mantığı core.js içindedir; tarayıcı paneli de aynı dosyayı kullanır. */
const Engine = require('./engine.js');
const Core = require('./core.js');
const usd = v => '$' + Number(v).toFixed(2);

async function main(d) {
  const E = d.ethers, env = d.env || {}, now = d.now ? d.now() : Date.now();
  const S = Object.assign({ live: false, entryWindowPct: 25 }, Core.DEFAULTS, JSON.parse(d.read('bot/config.json')));
  let st = {}; try { st = JSON.parse(d.read('state/state.json')) || {}; } catch (e) { st = {}; }
  st.v = 2; st.rt = st.rt || {}; st.trades = st.trades || []; st.events = st.events || [];
  if (!st.paper) st.paper = { usdc: S.paperCash, tok: {} };
  if (st.paper.weth != null) { st.paper.tok = st.paper.tok || {}; if (st.paper.weth) st.paper.tok.ETH = st.paper.weth; delete st.paper.weth; }
  const mode = S.live ? 'live' : 'paper';
  const R = st.rt[mode] = Core.migrateRT(Object.assign(Core.freshRT(), st.rt[mode]));
  const sig = () => JSON.stringify([mode, S.assets, S.maxPositions, st.assets, st.maxPositions, Object.keys(R.positions).sort(), R.halted && R.halted.kind, R.barT, st.trades.length, st.events.length && st.events[0].msg]);
  const before = sig(), wasHalted = R.halted && R.halted.kind;
  st.assets = S.assets; st.maxPositions = S.maxPositions;
  const ev = (msg, bad) => { if (st.events[0] && st.events[0].msg === msg) { st.events[0].t = now; return; } st.events.unshift({ t: now, msg, bad: !!bad }); if (st.events.length > 40) st.events.length = 40; };
  const logTrade = x => { st.trades.push(Object.assign({ t: now, mode }, x)); if (st.trades.length > 80) st.trades = st.trades.slice(-80); };
  if (st.mode && st.mode !== mode) ev(mode === 'live' ? 'Gerçek para moduna geçildi.' : 'Deneme moduna geçildi.');
  st.mode = mode;
  if (String(env.RESET_HALT) === 'true' && R.halted) { R.halted = null; R.errCount = 0; R.peakEq = null; ev('Güvenlik freni elle kaldırıldı.'); }

  const finish = () => {
    st.lastRun = now;
    const changed = sig() !== before || !st.savedAt || now - st.savedAt >= 55 * 60e3;
    if (changed) st.savedAt = now;
    d.write('state/state.json', JSON.stringify(st, null, 1));
    // Yeni devreye giren kalıcı fren, iş akışını "başarısız" bitirir; GitHub e-postayla haber verir
    const newHalt = R.halted && R.halted.kind !== 'day' && R.halted.kind !== wasHalted;
    return { changed, exitCode: newHalt ? 1 : 0, state: st };
  };
  const fail = e => { ev('Hata: ' + Core.errMsg(e), true); R.errCount = (R.errCount || 0) + 1; if (R.errCount >= 3 && !R.halted) R.halted = { kind: 'err', reason: 'Art arda 3 hata oluştu: ' + Core.errMsg(e) }; };

  // 1) Piyasa taraması (elde tutulan ama listeden çıkarılmış varlıklar da izlenir)
  const { mkt, errs, feed } = await Core.fetchMarket(d.fetch, S, now, Object.keys(R.positions));
  st.feed = feed; st.scan = {};
  for (const a of Core.ASSETS) {
    const m = mkt[a.sym]; if (!m) { if (errs[a.sym]) st.scan[a.sym] = { err: errs[a.sym] }; continue; }
    const i = m.closed.length - 1, ok = Engine.ready(i, m.ind);
    st.scan[a.sym] = { price: m.live, trendUp: Engine.trendUp(i, m.closed, m.ind), breakout: ok ? m.ind.d[i] : null };
  }
  st.dataErr = Object.keys(mkt).length ? null : 'Fiyat verisi alınamadı';
  if (st.dataErr) { ev('Fiyat verisi alınamadı; bu turda işlem yapılmadı.', true); return finish(); }
  for (const s in errs) if (R.positions[s]) ev(`${s} fiyatı alınamadı: ${errs[s]}`, true);

  // 2) Cüzdan ve ön kontrol
  let W = null, tradeable = null;
  try {
    if (env.BOT_PRIVATE_KEY) {
      const key = env.BOT_PRIVATE_KEY.trim(), rpc = new E.JsonRpcProvider((env.RPC_URL || '').trim() || Core.DEFAULT_RPC, 42161, { staticNetwork: true, batchMaxCount: 1 });
      W = Core.makeChain(E, new E.Wallet(key.startsWith('0x') ? key : '0x' + key, rpc), rpc); st.address = W.bot.address;
      const pf = await Core.preflight(E, W, S, mkt); st.preflight = { base: pf.base, assets: pf.assets };
      const b = await Core.chainBalances(E, W); st.wallet = { usdc: b.usdc, eth: b.eth, tok: b.tok };
      if (S.live) { if (!pf.baseOK) throw new Error('Ön kontrol geçmedi: ' + pf.base.filter(p => !p.ok).map(p => p.text).join('; ')); tradeable = pf.tradeable; }
    }
    if (S.live && !W) throw new Error('Gerçek para modu açık ama BOT_PRIVATE_KEY gizli değeri tanımlı değil.');
  } catch (e) { if (S.live) { fail(e); return finish(); } ev('Cüzdan kontrolü yapılamadı: ' + Core.errMsg(e), true); }

  // 3) Karar ve işlem
  const A = S.live ? Core.liveAdapter(E, W, S) : Core.paperAdapter(st.paper, S);
  try {
    if (S.live && st.prevBal && R.peakEq != null) {   // dışarıdan para girişi/çıkışı zarar gibi sayılmasın
      const b = await A.balances(); let flow = b.usdc - st.prevBal.usdc;
      for (const a of Core.ASSETS) { const p = mkt[a.sym] ? mkt[a.sym].live : R.lastPx[a.sym]; flow += ((b.tok[a.sym] || 0) - ((st.prevBal.tok || {})[a.sym] || 0)) * (p || 0); }
      const eqNow = b.usdc + Core.ASSETS.reduce((t, a) => t + (b.tok[a.sym] || 0) * ((mkt[a.sym] ? mkt[a.sym].live : R.lastPx[a.sym]) || 0), 0);
      if (Math.abs(flow) > Math.max(0.5, eqNow * 0.002)) {
        R.peakEq = Math.max(eqNow, R.peakEq + flow); if (R.dayStartEq != null) R.dayStartEq = Math.max(0, R.dayStartEq + flow);
        ev(`Cüzdanda ${flow > 0 ? 'para girişi' : 'para çıkışı'} algılandı (${usd(Math.abs(flow))}); sınırlar buna göre güncellendi.`);
      }
    }
    const v = await Core.step({ S, R, mkt, A, now, active: true, ev, logTrade, tradeable, paperGas: S.live ? 0 : S.gasUsd, freshPct: S.entryWindowPct });
    st.bal = { usdc: v.bal.usdc, eth: v.bal.eth, tok: v.bal.tok }; st.eq = v.eq;
    if (S.live) st.prevBal = { usdc: v.bal.usdc, tok: v.bal.tok };
    R.errCount = 0;
  } catch (e) {
    fail(e);
    try { const b = await A.balances(); st.bal = { usdc: b.usdc, eth: b.eth, tok: b.tok }; if (S.live) st.prevBal = { usdc: b.usdc, tok: b.tok }; } catch (e2) {}
  }
  return finish();
}

if (require.main === module) {
  const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..');
  main({
    ethers: require('ethers'), fetch: globalThis.fetch, env: process.env,
    read: f => fs.readFileSync(path.join(root, f), 'utf8'),
    write: (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  }).then(r => {
    const s = r.state, R = s.rt[s.mode];
    console.log(`[${s.mode}] değer ${s.eq} | pozisyonlar ${Object.keys(R.positions).join(', ') || 'yok'} | fren ${R.halted ? R.halted.kind : 'yok'}`);
    for (const k in s.scan) console.log('  ', k, JSON.stringify(s.scan[k]));
    for (const e of s.events.slice(0, 5)) console.log(' -', new Date(e.t).toISOString(), e.msg);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${r.changed}\n`);
    process.exitCode = r.exitCode;
  }).catch(e => { console.error('Beklenmeyen hata:', e); process.exitCode = 1; });
}
module.exports = { main };
