// sol2tron: USDT between Solana and Tron, by Tether's Legacy Mesh or NEAR Intents 1Click. The design is docs/design.md.
import { encodeFunctionData, decodeEventLog } from 'viem';
import { PublicKey } from '@solana/web3.js';
import * as S from 'solana';
import * as T from 'tron';
import * as M from 'mesh';
import * as O from 'oneclick';

// Neither GitHub Pages nor the nsite gateways send X-Frame-Options, and a meta CSP can't set frame-ancestors. So the page won't run
// inside another page, where an overlay could steer the user's clicks (clickjacking), and offers itself in its own tab instead.
// As liq2sol.
function framed() {
  try { return window.top !== window.self; } catch { return true; }
}
if (framed()) {
  document.getElementById('main').innerHTML = `<section class="card"><p>This page does not run inside another page.</p><p><a href="${location.href}" target="_blank" rel="noopener noreferrer">Open it in its own tab</a></p></section>`;
  throw new Error('framed');
}

// SwapMarket's sites are on GitHub Pages, and also nsites (NIP-5A) under SwapMarket's key, each its own subdomain on a gateway:
// <key in base36><name>.<gateway>, or <npub>.<gateway> for the root site, BTC Swaps. A menu link opened on one of those stays on the
// same gateway; anywhere else, including a copy under another key, it goes to GitHub Pages. As liq2sol's client/site/js/sites.js,
// which has the tests.
const KEY36 = '1cdzwdkc0uepk5ll8mhpcbyw3xh8gakldbfdq8fphhqnv503bc';
const NPUB = 'npub1xhklzztd83v34zsf9da2gvfrctj5wcsvsx09er9v26jy7r0uq8yq4vme7d';
function siteUrl(name, hostname = location.hostname) {
  const [label, ...gateway] = hostname.split('.');
  if (gateway.length && (label === NPUB || (label.startsWith(KEY36) && /^[a-z0-9-]{1,13}$/.test(label.slice(KEY36.length))))) {
    return `https://${name ? KEY36 + name : NPUB}.${gateway.join('.')}/`;
  }
  return `https://swapmarket.github.io/${name ? `${name}/` : ''}`;
}
for (const a of document.querySelectorAll('a[data-site]')) a.href = siteUrl(a.dataset.site);
// The gateway the footer links to for the copy on Nostr (as NSITE_GATEWAY in liq2sol's client/site/js/sites.js): nsite.lol never
// picked up a later manifest of a site it had served, while nwb.tf showed each within minutes (2026-11-19).
const NSITE_GATEWAY = 'nwb.tf';
const nsiteUrl = (name, gateway = NSITE_GATEWAY) => `https://${name ? KEY36 + name : NPUB}.${gateway}/`;
for (const a of document.querySelectorAll('a[data-nsite]')) a.href = nsiteUrl(a.dataset.nsite);

// The menu: on narrow screens the burger opens it over the page, and choosing a page closes it.
{
  const burger = document.getElementById('burger');
  const menu = document.getElementById('collapse');
  const set = (open) => {
    menu.classList.toggle('open', open);
    burger.classList.toggle('active', open);
    document.body.classList.toggle('menu-open', open);
    burger.setAttribute('aria-expanded', String(open));
  };
  burger.addEventListener('click', () => set(!menu.classList.contains('open')));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
}

// ---------- constants ----------

const WALLETCONNECT_PROJECT_ID = 'c001d9e3d0c6308a5ce7e5932d40064a'; // Reown project shared with sol2base and eth2base
const WC_SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const WC_TRON = 'tron:' + T.CHAIN_ID;
const KEYS = {
  transfers: 'sol2tron:transfers', form: 'sol2tron:form', recipientTron: 'sol2tron:recipientTron', recipientSol: 'sol2tron:recipientSol',
  // (No "walletconnect", "wc@", "wc_" or "wallet_connect" in these names: WalletConnect moves such keys into its IndexedDB.)
  qr: 'sol2tron:qrSession', solOff: 'sol2tron:solDisconnected', tronWallet: 'sol2tron:tronWallet',
};
// Quotes made without a connected wallet use these as stand-in addresses: the Legacy Mesh's upgrade authority on Solana (a funded
// system account, which a simulation needs as fee payer), and the Tron OFT. Only for quotes; never sent anything.
const QUOTE_PAYER = new PublicKey('VHPQq7vmhCsTE6T5YKyEFRGL1krwyMzU54CJVXDwa33');
const QUOTE_TRON = T.OFT;
// Measured on mainnet (docs/assumptions.md §3), for estimates before a Tron wallet is connected.
const ENERGY = { approve: 99_764n, send: 226_460n, transfer: 130_000n };
const BYTES = { approve: 345n, send: 800n, transfer: 345n };
const SOL_TX_FEE = 10_000n; // base and priority fees, a generous allowance (lamports)
const FEE_RISE = 110n; // ask again when a fee rose by more than 10% since it was shown
const MAX_FEE_LIMIT = 150_000_000n; // the most TRX (in sun) any one Tron transaction may burn

const rpc = S.rpcClient();
const tron = T.client();
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v, d = 6) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });
const fmtNative = (v, d) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumSignificantDigits: 4 });
const usd = (x) => (x == null ? '' : `≈ $${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const solTx = (s) => `<a href="https://solscan.io/tx/${esc(s)}" target="_blank" rel="noopener">${esc(short(s))}</a>`;
const tronTx = (s) => `<a href="https://tronscan.org/#/transaction/${esc(s.replace(/^0x/, ''))}" target="_blank" rel="noopener">${esc(short(s.replace(/^0x/, '')))}</a>`;
const scanLink = (h) => `<a href="https://layerzeroscan.com/tx/${esc(h)}" target="_blank" rel="noopener">LayerZero Scan</a>`;
const errMsg = (e) => e?.shortMessage || e?.message || String(e);
const isRejection = (e) => /disapproved|rejected|denied|declined|cancel/i.test(errMsg(e)) || [4001, 5000, 5002].includes(e?.code ?? e?.cause?.code);
const dir = () => document.querySelector('input[name=dir]:checked').value; // 's2t' | 't2s'
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- state ----------

let sol = null; // { name, owner (PublicKey), signTransaction(VersionedTransaction), disconnect, wc }
let solBal = null; // { usdt, sol }
let tronW = null; // { name, address, sign(tx) → signed tx, disconnect, wc }
let tronBal = null; // { usdt, trx (sun), free: { freeEnergy, freeBandwidth }, exists }
let prices = { SOL: null, TRX: null };
let tronPrices = { energy: 100n, bandwidth: 1000n };
let quotes = {}; // { mesh, oneclick } for the form as it is now; each { ok, arrives, cost: [{ text, usd }], why, … }
let chosen = null; // the route the user picked, or null to follow the best
let busy = false;
let quoteSeq = 0;

// ---------- status and steps ----------

function setStatus(html, kind = '') {
  $('status').className = 'status ' + kind;
  $('status').innerHTML = html;
  notify($('status').textContent);
}
function setSteps(names) {
  $('steps').innerHTML = names.map((n, i) => `<li data-i="${i}">${esc(n)}</li>`).join('');
  $('progress').hidden = false;
  $('deposit').hidden = true;
  $('again').hidden = true;
}
function step(i, state) {
  const li = $('steps').children[i];
  if (!li) return;
  li.className = state ?? '';
  if (state === 'active') li.dataset.start = Date.now();
}
setInterval(() => {
  for (const li of document.querySelectorAll('#steps li.active')) {
    const secs = Math.floor((Date.now() - Number(li.dataset.start)) / 1000);
    let el = li.querySelector('.elapsed');
    if (!el) { el = document.createElement('span'); el.className = 'elapsed'; li.append(el); }
    el.textContent = ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}, 1000);

let swReg = null;
navigator.serviceWorker?.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
async function askNotifications() { try { if (window.Notification?.permission === 'default') await Notification.requestPermission(); } catch {} }
function notify(text) {
  if (!document.hidden || !swReg || window.Notification?.permission !== 'granted') return;
  swReg.showNotification('sol2tron', { body: text.split(/(?<=[.…])\s/)[0], tag: 'sol2tron', renotify: true, icon: 'icon.png' }).catch(() => {});
}

// Waits for the user to click "Confirm with the new numbers" (or anything else that cancels).
function confirmAgain(html) {
  setStatus(html, 'err');
  $('again').hidden = false;
  return new Promise((resolve) => {
    $('again').onclick = () => { $('again').hidden = true; resolve(true); };
  });
}

// ---------- Solana wallet (as sol2base) ----------

const standardWallets = [];
const registerWallet = (w) => {
  if (w.features?.['solana:signTransaction'] && w.features?.['standard:connect'] && w.chains?.some((c) => c.startsWith('solana:'))) standardWallets.push(w);
};
window.addEventListener('wallet-standard:register-wallet', ({ detail: callback }) => callback({ register: registerWallet }));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: registerWallet } }));
const findInjectedSol = () => window.phantom?.solana ?? window.solflare ?? window.backpack?.solana ?? window.trustwallet?.solana ?? window.solana ?? null;

async function connectSol(silent = false) {
  if (silent && store.get(KEYS.solOff)) return;
  if (!silent) store.del(KEYS.solOff);
  const w = standardWallets[0];
  if (w) {
    const { accounts } = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
    const account = accounts?.[0] ?? w.accounts[0];
    if (!account) throw new Error('No account');
    const off = w.features['standard:events']?.on('change', ({ accounts: a }) => { if (a && sol) setSol(a[0] ? { ...sol, owner: new PublicKey(a[0].address) } : null); });
    return setSol({
      name: w.name, owner: new PublicKey(account.address),
      signTransaction: async (tx) => {
        const [{ signedTransaction }] = await w.features['solana:signTransaction'].signTransaction({ account, transaction: tx.serialize(), chain: 'solana:mainnet' });
        return S.VersionedTransaction.deserialize(signedTransaction);
      },
      disconnect: async () => { off?.(); await w.features['standard:disconnect']?.disconnect(); },
    });
  }
  const p = findInjectedSol();
  if (p) {
    const res = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pk = res?.publicKey ?? p.publicKey;
    if (!pk) return;
    return setSol({
      name: p.isPhantom ? 'Phantom' : p.isSolflare ? 'Solflare' : 'wallet', owner: new PublicKey(pk.toString()),
      signTransaction: async (tx) => S.VersionedTransaction.deserialize((await p.signTransaction(tx)).serialize()),
      disconnect: async () => { await p.disconnect?.(); },
    });
  }
  if (!silent) showNoWallet();
}

function setSol(w) {
  sol = w;
  $('solAccount').textContent = sol ? `Solana${sol.name ? ` (${sol.name})` : ''}: ${short(sol.owner.toBase58())}` : 'Solana: not connected';
  $('connectSol').textContent = sol ? 'Disconnect' : 'Connect Solana';
  $('solBal').hidden = !sol;
  showQrRow();
  refreshBalances();
  fillRecipient();
}

// ---------- Tron wallet ----------

// TronLink and compatible extensions announce themselves by TIP-6963; older ones only inject window.tron or window.tronLink.
const tronProviders = [];
window.addEventListener('TIP6963:announceProvider', (e) => { if (e.detail?.provider && !tronProviders.includes(e.detail.provider)) tronProviders.push(e.detail.provider); });
window.dispatchEvent(new Event('TIP6963:requestProvider'));
const findTron = () => tronProviders[0] ?? window.tron ?? window.tronLink ?? null;

async function connectTron(silent = false) {
  const p = findTron();
  if (!p) { if (!silent) showNoWallet(); return; }
  if (silent) {
    if (store.get(KEYS.tronWallet) !== 'injected' || !p.tronWeb?.defaultAddress?.base58) return;
  } else {
    const res = await p.request({ method: 'eth_requestAccounts' });
    if (res?.code && res.code !== 200) throw new Error(res.message || 'TronLink refused the connection.');
  }
  const tw = p.tronWeb;
  if (!tw?.defaultAddress?.base58) throw new Error('TronLink is locked or has no account.');
  // The wallet's network: its node's genesis block must be mainnet's.
  const genesis = await tw.trx.getBlock(0).then((b) => b.blockID).catch(() => null);
  if (genesis !== T.GENESIS) throw new Error('Switch TronLink to TRON Mainnet, then connect again.');
  store.set(KEYS.tronWallet, 'injected');
  setTron({
    name: p.isTronLink ? 'TronLink' : 'Tron wallet', address: tw.defaultAddress.base58,
    sign: async (tx) => {
      const net = await tw.trx.getBlock(0).then((b) => b.blockID).catch(() => null);
      if (net !== T.GENESIS) throw new Error('Switch TronLink to TRON Mainnet. Nothing was signed.');
      return tw.trx.sign(tx);
    },
    disconnect: async () => { store.del(KEYS.tronWallet); },
  });
  if (!tronListening) {
    tronListening = true;
    p.on?.('accountsChanged', (accs) => { if (tronW && !tronW.wc) { const a = accs?.[0] ?? p.tronWeb?.defaultAddress?.base58; if (a) setTron({ ...tronW, address: a }); else setTron(null); } });
    p.on?.('chainChanged', () => { if (tronW && !tronW.wc) connectTron(true).catch(() => setTron(null)); });
  }
}
let tronListening = false;

function setTron(w) {
  tronW = w;
  $('tronAccount').textContent = tronW ? `Tron (${tronW.name}): ${short(tronW.address)}` : 'Tron: not connected';
  $('connectTron').textContent = tronW ? 'Disconnect' : 'Connect Tron';
  $('tronBal').hidden = !tronW;
  showQrRow();
  refreshBalances();
  fillRecipient();
}

// WalletConnect is offered until both chains are connected; a session already open covers whatever its wallet shared.
function showQrRow() { $('qrRow').hidden = Boolean((sol && tronW) || sol?.wc || tronW?.wc); }

function showNoWallet() {
  $('noWallet').innerHTML = 'No wallet found in this browser. Use <b>WalletConnect</b> to connect a phone wallet by QR code (Trust Wallet holds both Solana and Tron), '
    + 'or install a Solana wallet (Phantom, Solflare, Backpack) and TronLink.';
  $('noWallet').hidden = false;
}

// ---------- WalletConnect (both chains in one session) ----------

let wcClient = null;
async function wcInit() {
  if (wcClient) return wcClient;
  const { SignClient } = await import('@walletconnect/sign-client');
  wcClient = await SignClient.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    metadata: { name: 'sol2tron', description: 'Move USDT between Solana and Tron', url: new URL('.', location.href).href, icons: [new URL('icon.png', location.href).href] },
  });
  wcClient.on('session_delete', () => { store.del(KEYS.qr); if (sol?.wc) setSol(null); if (tronW?.wc) setTron(null); });
  return wcClient;
}
const wcStored = (client) => client.session.getAll().filter((s) => s.expiry * 1000 > Date.now() && (s.namespaces.solana || s.namespaces.tron)).sort((a, b) => b.expiry - a.expiry)[0];

async function restoreWalletConnect() {
  if (!store.get(KEYS.qr)) return false;
  const client = await wcInit();
  const session = wcStored(client);
  if (!session) { store.del(KEYS.qr); return false; }
  useSession(client, session);
  return true;
}

async function connectWalletConnect() {
  const [client, { WalletConnectModal }] = await Promise.all([wcInit(), import('@walletconnect/modal')]);
  const modal = new WalletConnectModal({ projectId: WALLETCONNECT_PROJECT_ID, chains: [WC_SOLANA, WC_TRON] });
  const { uri, approval } = await client.connect({
    optionalNamespaces: {
      solana: { chains: [WC_SOLANA], methods: ['solana_signTransaction'], events: [] },
      tron: { chains: [WC_TRON], methods: ['tron_signTransaction'], events: [] },
    },
  });
  if (uri) modal.openModal({ uri });
  let session;
  try { session = await approval(); } finally { modal.closeModal(); }
  useSession(client, session);
}

function useSession(client, session) {
  store.set(KEYS.qr, 1);
  const name = session.peer.metadata.name;
  const disconnect = async () => {
    store.del(KEYS.qr);
    try { await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } }); } catch {}
    if (sol?.wc) setSol(null);
    if (tronW?.wc) setTron(null);
  };
  const solAcct = session.namespaces.solana?.accounts.find((a) => a.startsWith(WC_SOLANA + ':'));
  if (solAcct) {
    const pk = new PublicKey(solAcct.split(':')[2]);
    setSol({
      wc: true, name, owner: pk, disconnect,
      signTransaction: async (tx) => {
        const res = await client.request({ topic: session.topic, chainId: WC_SOLANA, request: { method: 'solana_signTransaction', params: { transaction: S.b64(tx.serialize()) } } });
        if (res.transaction) return S.VersionedTransaction.deserialize(S.unb64(res.transaction));
        tx.addSignature(pk, T.base58Decode(res.signature));
        return tx;
      },
    });
  }
  const tronAcct = session.namespaces.tron?.accounts.find((a) => a.startsWith(WC_TRON + ':'));
  if (tronAcct) {
    const address = tronAcct.split(':')[2];
    // Wallets that set tron_method_version "v1" take the transaction itself; older ones expect it nested.
    const v1 = session.sessionProperties?.tron_method_version === 'v1';
    setTron({
      wc: true, name, address, disconnect,
      sign: async (tx) => {
        const res = await client.request({ topic: session.topic, chainId: WC_TRON, request: { method: 'tron_signTransaction', params: { address, transaction: v1 ? tx : { transaction: tx } } } });
        const signed = res?.signature ? res : res?.result?.signature ? res.result : res?.transaction?.signature ? res.transaction : null;
        if (!signed) throw new Error('The wallet returned no signature.');
        return { ...tx, signature: signed.signature };
      },
    });
  }
  if (!solAcct && !tronAcct) { disconnect(); throw new Error(`${name} shared no Solana or Tron mainnet account.`); }
}

// ---------- balances ----------

async function refreshBalances() {
  const jobs = [];
  if (sol) {
    jobs.push((async () => {
      const { value: [w, t] } = await rpc('getMultipleAccounts', [[sol.owner.toBase58(), S.ata(sol.owner).toBase58()], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 72 } }]);
      solBal = { sol: S.lamportsOf(w), usdt: S.tokenAmount(t) ?? 0n };
      $('balSolUsdt').textContent = fmt(solBal.usdt);
      $('balSol').textContent = fmtNative(solBal.sol, 9);
    })().catch((e) => console.warn('solana balances', e)));
  } else solBal = null;
  if (tronW) {
    jobs.push((async () => {
      const [acct, res, usdt] = await Promise.all([
        tron.account(tronW.address), tron.resources(tronW.address),
        tron.view(T.USDT, T.TRC20_ABI, 'balanceOf', [T.toEvm(tronW.address)]),
      ]);
      tronBal = { trx: BigInt(acct?.balance ?? 0), exists: !!acct?.address, usdt: usdt.value, free: T.available(res) };
      $('balTronUsdt').textContent = fmt(tronBal.usdt);
      $('balTrx').textContent = fmtNative(tronBal.trx, 6);
      $('balRes').textContent = `· ${tronBal.free.freeEnergy.toLocaleString()} energy, ${tronBal.free.freeBandwidth.toLocaleString()} bandwidth free`;
    })().catch((e) => console.warn('tron balances', e)));
  } else tronBal = null;
  await Promise.all(jobs);
  requote();
}

// ---------- the form ----------

function parseAmount() {
  const v = $('amount').value.trim().replace(',', '.');
  if (!/^\d+(\.\d{0,6})?$/.test(v)) return null;
  const [i, f = ''] = v.split('.');
  const a = BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'));
  return a > 0n ? a : null;
}

// The recipient field, checked for the destination chain: { ok, address, why }.
function recipient() {
  const v = $('recipient').value.trim();
  if (!v) return { ok: false, why: '' };
  if (dir() === 's2t') {
    try { T.decodeAddress(v); return { ok: true, address: v }; } catch (e) { return { ok: false, why: e.message }; }
  }
  try { new PublicKey(v); } catch { return { ok: false, why: 'Not a Solana address.' }; }
  return { ok: true, address: v };
}

// By default the recipient is the user's own wallet on the other chain.
function fillRecipient() {
  const el = $('recipient');
  const own = dir() === 's2t' ? tronW?.address : sol?.owner.toBase58();
  const saved = store.get(dir() === 's2t' ? KEYS.recipientTron : KEYS.recipientSol);
  if (!el.value.trim() || el.dataset.auto === '1') {
    el.value = saved ?? own ?? '';
    el.dataset.auto = saved ? '' : '1';
  }
  requote();
}

function showDirection() {
  const s2t = dir() === 's2t';
  $('recipientLabel').textContent = s2t ? 'Recipient on Tron' : 'Recipient on Solana';
  $('recipient').placeholder = s2t ? 'T… your Tron address' : 'your Solana wallet address';
  $('recipient').value = '';
  $('recipient').dataset.auto = '1';
  quotes = {};
  fillRecipient();
}

// ---------- quotes ----------

let routeCache = null; // { at, route }
async function meshRoute() {
  if (routeCache && Date.now() - routeCache.at < 60_000) return routeCache.route;
  const route = await M.loadRoute(async (keys) => (await rpc('getMultipleAccounts', [keys.map(String), { encoding: 'base64' }])).value
    .map((a) => (a ? { owner: a.owner, data: S.unb64(a.data[0]) } : null)));
  if (route.store.feeBps !== M.FEE_BPS) throw new Error(`The Legacy Mesh fee changed to ${route.store.feeBps} bps; this page expects ${M.FEE_BPS}. Nothing will be sent.`);
  routeCache = { at: Date.now(), route };
  return route;
}

async function solanaMeshFee(route, payer, to, amount) {
  const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = S.buildTx(payer, [...S.computeBudget(1_400_000, 0n), M.quoteSendIx(route, { to, amount, minAmount: M.received(amount) })], blockhash, route.lookupTables);
  return M.decodeQuoteReturn(M.returnDataOf(await S.simulate(rpc, tx, []))).nativeFee;
}

let tronFeeChecked = 0;
async function tronMeshQuote(amount, to, hasAccount) {
  if (Date.now() - tronFeeChecked > 60_000) {
    const fee = (await tron.view(T.OFT, T.OFT_ABI, 'feeBps')).value;
    if (BigInt(fee) !== M.FEE_BPS) throw new Error(`The Legacy Mesh fee on Tron changed to ${fee} bps; this page expects ${M.FEE_BPS}. Nothing will be sent.`);
    if ((await tron.view(T.OFT, T.OFT_ABI, 'peers', [M.SOLANA_EID])).value !== M.SOLANA_PEER) throw new Error('The Tron OFT\'s Solana peer is not the Solana OFT.');
    tronFeeChecked = Date.now();
  }
  const sp = M.tronSendParam({ to, amount, extraOptions: M.extraOptionsFor(hasAccount) });
  const [limit, , receipt] = (await tron.view(T.OFT, T.OFT_ABI, 'quoteOFT', [sp])).value;
  if (receipt.amountReceivedLD !== M.received(amount)) throw new Error('The Tron OFT quotes a different amount than the 0.03% fee gives.');
  const { nativeFee } = (await tron.view(T.OFT, T.OFT_ABI, 'quoteSend', [sp, false])).value;
  return { sp, nativeFee, limit: limit.maxAmountLD };
}

// TRX a Tron transaction will burn, given the wallet's free energy and bandwidth (zero when no wallet is connected).
const burn = (energy, bytes, free) => T.burnFor({ energy, bytes }, free ?? { freeEnergy: 0n, freeBandwidth: 0n }, tronPrices);

async function quoteMesh(amount, to) {
  if (dir() === 's2t') {
    const route = await meshRoute();
    if (M.received(amount) > (route.credits[M.TRON_EID] ?? 0n)) return { ok: false, why: `The Legacy Mesh can send at most ${fmt(route.credits[M.TRON_EID] ?? 0n)} USDT to Tron right now.` };
    const payer = sol && solBal?.sol > 10_000_000n ? sol.owner : QUOTE_PAYER;
    const nativeFee = await solanaMeshFee(route, payer, M.tronRecipient(to ?? QUOTE_TRON), amount);
    const lamports = nativeFee + SOL_TX_FEE;
    return {
      ok: true, arrives: M.received(amount), nativeFee, needSol: lamports, capacity: route.credits[M.TRON_EID] ?? 0n,
      cost: [{ text: `${fmtNative(lamports, 9)} SOL (LayerZero fee to deliver on Tron)`, usd: prices.SOL && (Number(lamports) / 1e9) * prices.SOL }],
    };
  }
  let hasAccount = true;
  if (to) {
    const r = await S.checkRecipient(rpc, to);
    if (!r.ok) return { ok: false, why: r.why };
    hasAccount = r.usdtAccount;
  }
  const q = await tronMeshQuote(amount, to ?? QUOTE_PAYER.toBase58(), hasAccount);
  if (amount > q.limit) return { ok: false, why: `The Legacy Mesh can send at most ${fmt(q.limit)} USDT to Solana right now.` };
  const free = tronBal?.free;
  let approve = null;
  if (tronW) {
    const allowance = (await tron.view(T.USDT, T.TRC20_ABI, 'allowance', [T.toEvm(tronW.address), T.toEvm(T.OFT)])).value;
    if (allowance < amount) approve = burn(ENERGY.approve, BYTES.approve, free);
  } else approve = burn(ENERGY.approve, BYTES.approve, null);
  // After an approval the free energy is spent; count the send as if paid in full then.
  const send = burn(ENERGY.send, BYTES.send, approve ? null : free);
  const total = q.nativeFee + send.total + (approve?.total ?? 0n);
  const trx = (sun) => prices.TRX && (Number(sun) / 1e6) * prices.TRX;
  return {
    ok: true, arrives: M.received(amount), nativeFee: q.nativeFee, needTrx: total, hasAccount, capacity: q.limit,
    cost: [{ text: `${fmtNative(total, 6)} TRX: LayerZero fee ${fmtNative(q.nativeFee, 6)}, send ${fmtNative(send.total, 6)}${approve ? `, approval ${fmtNative(approve.total, 6)}` : ''}`, usd: trx(total) }],
    breakdown: { nativeFee: q.nativeFee, send, approve },
  };
}

async function quoteOneClick(amount, to) {
  const from = dir() === 's2t' ? 'sol' : 'tron';
  const req = O.request({
    from, amount, dry: true,
    recipient: to ?? (from === 'sol' ? QUOTE_TRON : QUOTE_PAYER.toBase58()),
    refundTo: from === 'sol' ? (sol?.owner.toBase58() ?? QUOTE_PAYER.toBase58()) : (tronW?.address ?? QUOTE_TRON),
  });
  let resp;
  try { resp = await O.quote(req); } catch (e) { return { ok: false, why: e.message.replace(/^1Click: /, '1Click: ') }; }
  const q = resp.quote;
  if (from === 'sol') {
    // A plain SPL transfer, plus the deposit address's USDT account if it has none (known only from the real quote).
    const lamports = SOL_TX_FEE + S.TOKEN_ACCOUNT_RENT;
    return {
      ok: true, arrives: BigInt(q.amountOut), minOut: BigInt(q.minAmountOut), needSol: lamports,
      cost: [{ text: `up to ${fmtNative(lamports, 9)} SOL (network fee, and the deposit address's USDT account if missing)`, usd: prices.SOL && (Number(lamports) / 1e9) * prices.SOL }],
    };
  }
  const t = burn(ENERGY.transfer, BYTES.transfer, tronBal?.free);
  return {
    ok: true, arrives: BigInt(q.amountOut), minOut: BigInt(q.minAmountOut), needTrx: t.total,
    cost: [{ text: `about ${fmtNative(t.total, 6)} TRX (one USDT transfer)`, usd: prices.TRX && (Number(t.total) / 1e6) * prices.TRX }],
  };
}

const TRUST = {
  mesh: 'Tether\'s own network. The contracts enforce the amount; LayerZero Labs and USDT0 must both confirm.',
  oneclick: 'A solver network. You send to a one-time deposit address; if the swap isn\'t filled by the deadline, it is refunded to you.',
};
const NAMES = { mesh: 'Legacy Mesh', oneclick: 'NEAR Intents' };

// What the user ends up with, in USD: what arrives, less what they pay on the side (valued with 1Click's prices).
const net = (q) => (q?.ok ? Number(q.arrives) / 1e6 - q.cost.reduce((s, c) => s + (c.usd ?? 0), 0) : -Infinity);
// The all-in cost: the USDT that doesn't arrive, plus what is paid on the side in SOL or TRX, in USD (USDT counted at $1).
// (null while the SOL or TRX price is unknown.)
const allInCost = (q, amount) => (q.cost.some((c) => c.usd == null) ? null
  : Number(amount - q.arrives) / 1e6 + q.cost.reduce((s, c) => s + c.usd, 0));
function allIn(q, amount) {
  const cost = allInCost(q, amount);
  if (cost == null) return '';
  return `<span class="allin">All-in cost $${cost.toFixed(2)} <span class="pct">(${((cost / (Number(amount) / 1e6)) * 100).toFixed(2)}%)</span></span>`;
}
const best = () => (net(quotes.mesh) >= net(quotes.oneclick) ? 'mesh' : 'oneclick');
const selected = () => {
  const r = chosen ?? best();
  return quotes[r]?.ok ? r : ['mesh', 'oneclick'].find((k) => quotes[k]?.ok) ?? null;
};

let requoteTimer = null;
function requote() {
  clearTimeout(requoteTimer);
  requoteTimer = setTimeout(doQuote, 300);
  render();
}
async function doQuote() {
  const amount = parseAmount();
  const r = recipient();
  $('recipientHint').textContent = r.why ?? '';
  if (!amount || busy) { if (!amount) quotes = {}; render(); return; }
  const seq = ++quoteSeq;
  const to = r.ok ? r.address : null;
  for (const k of ['mesh', 'oneclick']) if (!quotes[k] || quotes[k].amount !== amount || quotes[k].dir !== dir()) quotes[k] = { loading: true };
  render();
  const run = async (k, f) => {
    let q;
    try { q = await f(amount, to); } catch (e) { console.warn(k, e); q = { ok: false, why: errMsg(e) }; }
    if (seq !== quoteSeq) return;
    const cost = q.ok ? allInCost(q, amount) : null;
    if (cost != null && cost > Number(amount) / 1e6) {
      q = { ok: false, why: `Not worth it: the all-in cost of $${cost.toFixed(2)} is more than the ${fmt(amount)} USDT you would send.` };
    }
    quotes[k] = { ...q, amount, dir: dir(), to, at: Date.now() };
    render();
  };
  await Promise.all([run('mesh', quoteMesh), run('oneclick', quoteOneClick)]);
}

function render() {
  const amount = parseAmount();
  const pick = selected();
  const html = ['mesh', 'oneclick'].map((k) => {
    const q = quotes[k];
    const lines = !amount ? '<span class="line">Enter an amount to see the quote.</span>'
      : !q || q.loading ? '<span class="line">Quoting…</span>'
      : !q.ok ? `<span class="why">${esc(q.why || 'Not available.')}</span>`
      : `${allIn(q, amount)}<span class="line">${fmt(q.arrives)} USDT arrives, and you pay ${q.cost.map((c) => `${esc(c.text)} ${usd(c.usd)}`).join('; ')} on top</span>`
        + (q.capacity != null ? `<span class="line">Liquidity: up to ${Math.floor(Number(q.capacity) / 1e6).toLocaleString('en')} USDT right now</span>` : '');
    const badge = q?.ok && quotes.mesh?.ok && quotes.oneclick?.ok && best() === k ? '<span class="badge">leaves you more</span>' : '';
    // The headline is what is left after every cost (amount − all-in cost), so the routes compare on one number;
    // without a SOL or TRX price, only the USDT that arrives.
    const cost = q?.ok ? allInCost(q, amount) : null;
    const arrives = !q?.ok ? ''
      : cost == null ? `<span class="arrives">${fmt(q.arrives)} USDT</span>`
      : `<span class="arrives">$${(Number(amount) / 1e6 - cost).toFixed(2)} <span class="net">left</span></span>`;
    return `<label class="route"><input type="radio" name="route" value="${k}" ${pick === k ? 'checked' : ''} ${q?.ok ? '' : 'disabled'}>`
      + `${arrives}<span class="name">${NAMES[k]}</span>${badge}${lines}<span class="trust">${esc(TRUST[k])}</span></label>`;
  }).join('');
  $('routes').innerHTML = html;
  for (const i of document.querySelectorAll('input[name=route]')) i.onchange = () => { chosen = i.value; render(); };
  const q = pick && quotes[pick];
  const r = recipient();
  let need = '';
  if (q?.ok) {
    if (dir() === 's2t' && sol && solBal) {
      if (solBal.usdt < amount) need = `You have ${fmt(solBal.usdt)} USDT on Solana.`;
      else if (solBal.sol < q.needSol) need = `You need about ${fmtNative(q.needSol, 9)} SOL for this route and have ${fmtNative(solBal.sol, 9)}.`;
    }
    if (dir() === 't2s' && tronW && tronBal) {
      if (!tronBal.exists) need = 'This Tron account has never received TRX, so it cannot send anything yet. Send it some TRX first.';
      else if (tronBal.usdt < amount) need = `You have ${fmt(tronBal.usdt)} USDT on Tron.`;
      else if (tronBal.trx < q.needTrx) need = `You need about ${fmtNative(q.needTrx, 6)} TRX for this route and have ${fmtNative(tronBal.trx, 6)}. See "About TRX on Tron" below.`;
    }
  }
  $('need').textContent = need;
  // A manual 1Click deposit from Tron (decision D3) needs the user's own Tron address for refunds.
  const manualRefund = pick === 'oneclick' && dir() === 't2s' && !tronW;
  $('refundRow').hidden = !manualRefund;
  const refundOk = !manualRefund || T.isAddress($('refundTron').value.trim());
  const wallet = dir() === 's2t' ? sol : tronW;
  const manual = pick === 'oneclick' && dir() === 't2s' && !tronW; // decision D3: send from another wallet
  $('go').disabled = busy || !q?.ok || !r.ok || !!need || (!wallet && !manual) || !refundOk;
  $('go').textContent = busy ? 'Working…' : !wallet && !manual ? `Connect a ${dir() === 's2t' ? 'Solana' : 'Tron'} wallet`
    : manual ? 'Get a deposit address' : `Send with ${NAMES[pick] ?? '…'}`;
}

// ---------- transfers (localStorage) ----------

const transfers = () => store.get(KEYS.transfers, []);
function saveTransfer(t) {
  const list = transfers().filter((x) => x.id !== t.id && x.id !== t.prevId);
  delete t.prevId;
  store.set(KEYS.transfers, [t, ...list].slice(0, 20));
  renderRecent();
}
const json = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

function renderRecent() {
  const list = transfers();
  $('recentCard').hidden = !list.length;
  $('recent').innerHTML = list.map((t) => {
    const src = t.route === 'mesh' ? (t.dir === 's2t' ? solTx(t.id) : tronTx(t.id)) : t.depositTx ? (t.dir === 's2t' ? solTx(t.depositTx) : tronTx(t.depositTx)) : `deposit <code>${esc(short(t.id))}</code>`;
    const dst = t.destTx ? ` → ${t.dir === 's2t' ? tronTx(t.destTx) : solTx(t.destTx)}` : '';
    const done = ['delivered', 'refunded', 'failed'].includes(t.status);
    return `<li><span class="st ${esc(t.status)}">${esc(t.status)}</span> · ${fmt(t.amount)} USDT ${t.dir === 's2t' ? 'Solana → Tron' : 'Tron → Solana'} · ${NAMES[t.route]} · `
      + `${new Date(t.created).toLocaleString()}<br>${src}${dst}${done ? '' : ` · <a href="#" data-resume="${esc(t.id)}">resume</a>`}</li>`;
  }).join('');
  for (const a of document.querySelectorAll('[data-resume]')) a.onclick = (e) => { e.preventDefault(); resume(a.dataset.resume); };
}

// ---------- Solana: sign and send ----------

async function solSign(tx) {
  const slow = setTimeout(() => setStatus(`Still waiting for ${sol.name ?? 'the wallet'}. If you already confirmed, switch to the wallet and check; if you rejected it, reload the page.`), 60_000);
  try { return await sol.signTransaction(tx); } finally { clearTimeout(slow); }
}

// ---------- Solana → Tron ----------

async function sendSolMesh(amount, to, shown) {
  const owner = sol.owner;
  setSteps(['Sign the send on Solana', 'LayerZero verifies (LayerZero Labs + USDT0)', 'USDT arrives on Tron']);
  step(0, 'active');
  setStatus('Checking the quote…');
  const route = await meshRoute();
  if (M.received(amount) > (route.credits[M.TRON_EID] ?? 0n)) throw new Error('The amount is above what the Legacy Mesh can send to Tron right now.');
  const toBytes = M.tronRecipient(to);
  let nativeFee = await solanaMeshFee(route, owner, toBytes, amount);
  if (nativeFee * 100n > shown.nativeFee * FEE_RISE) {
    await confirmAgain(`The LayerZero fee rose from ${fmtNative(shown.nativeFee, 9)} to ${fmtNative(nativeFee, 9)} SOL since the quote.`);
    nativeFee = await solanaMeshFee(route, owner, toBytes, amount);
  }
  const ceiling = (nativeFee * 105n) / 100n; // the endpoint charges the actual fee; this only caps it
  const priority = await S.priorityFee(rpc, [M.OFT_STORE]);
  const { value: { blockhash, lastValidBlockHeight } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const units = 400_000;
  const tx = S.buildTx(owner, [...S.computeBudget(units, priority), M.sendIx(route, owner, { to: toBytes, amount, minAmount: M.received(amount), nativeFee: ceiling })], blockhash, route.lookupTables);
  const sim = await S.simulate(rpc, tx, [S.ata(owner), owner]);
  const ret = M.decodeSendReturn(M.returnDataOf(sim));
  const usdtOut = (S.tokenAmount(sim.before[0]) ?? 0n) - (S.tokenAmount(sim.after[0]) ?? 0n);
  const solOut = S.lamportsOf(sim.before[1]) - S.lamportsOf(sim.after[1]);
  const maxSol = ceiling + 5000n + (BigInt(units) * priority) / 1_000_000n;
  if (usdtOut !== amount || ret.amountReceived !== M.received(amount) || solOut > maxSol) {
    throw new Error('The send failed its safety check in simulation (the amounts differ from the quote). Nothing was signed.');
  }
  setStatus(`Confirm in ${sol.name ?? 'your wallet'}: send ${fmt(amount)} USDT, ${fmt(ret.amountReceived)} arrive on Tron; LayerZero fee ${fmtNative(ret.nativeFee, 9)} SOL.`);
  const signed = await solSign(tx);
  const sig = T.base58Encode(signed.signatures[0]);
  const t = { id: sig, route: 'mesh', dir: 's2t', from: owner.toBase58(), to, amount: String(amount), expected: String(ret.amountReceived), created: Date.now(), status: 'sent', mesh: { nativeFee: String(ret.nativeFee) } };
  saveTransfer(t);
  await S.sendAndConfirm(rpc, signed, lastValidBlockHeight, (s) => setStatus(`Sent ${solTx(s)}, waiting for confirmation…`)).catch((e) => {
    if (e.expired) { t.status = 'failed'; t.note = 'expired; nothing was spent'; saveTransfer(t); }
    throw e;
  });
  step(0, 'done');
  refreshBalances();
  await trackMesh(t);
}

async function sendSolOneClick(amount, to, shown) {
  const owner = sol.owner;
  setSteps(['Get the deposit address', 'Sign the deposit on Solana', 'Solvers fill the swap', 'USDT arrives on Tron']);
  step(0, 'active');
  const req = O.request({ from: 'sol', amount, recipient: to, refundTo: owner.toBase58(), dry: false });
  let resp = await O.quote(req);
  if (BigInt(resp.quote?.minAmountOut ?? 0) < shown.minOut) {
    await confirmAgain(`The minimum to arrive fell from ${fmt(shown.minOut)} to ${fmt(BigInt(resp.quote?.minAmountOut ?? 0))} USDT since the quote.`);
    shown = { ...shown, minOut: BigInt(resp.quote.minAmountOut) };
  }
  const q = O.checkQuote(resp, req, { minOut: shown.minOut, user: owner.toBase58() });
  const deposit = new PublicKey(q.depositAddress);
  const t = { id: q.depositAddress, route: 'oneclick', dir: 's2t', from: owner.toBase58(), to, amount: String(amount), expected: q.amountOut, minOut: q.minAmountOut, created: Date.now(), status: 'quoted', oneclick: { quoteResponse: resp } };
  saveTransfer(t); // the quote and its signature are kept before anything is signed
  step(0, 'done');
  step(1, 'active');
  const priority = await S.priorityFee(rpc, [S.ata(owner)]);
  const { value: { blockhash, lastValidBlockHeight } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = S.buildTx(owner, [...S.computeBudget(60_000, priority), S.createAtaIdempotent(owner, deposit), S.transferUsdt(owner, deposit, amount)], blockhash);
  const sim = await S.simulate(rpc, tx, [S.ata(owner), S.ata(deposit)]);
  const out = (S.tokenAmount(sim.before[0]) ?? 0n) - (S.tokenAmount(sim.after[0]) ?? 0n);
  const inn = (S.tokenAmount(sim.after[1]) ?? 0n) - (S.tokenAmount(sim.before[1]) ?? 0n);
  if (out !== amount || inn !== amount) throw new Error('The deposit failed its safety check in simulation. Nothing was signed.');
  setStatus(`Confirm in ${sol.name ?? 'your wallet'}: send ${fmt(amount)} USDT to 1Click's deposit address ${esc(short(q.depositAddress))}; at least ${fmt(BigInt(q.minAmountOut))} USDT arrive on Tron.`);
  const signed = await solSign(tx);
  t.depositTx = T.base58Encode(signed.signatures[0]);
  t.status = 'sent';
  saveTransfer(t);
  await S.sendAndConfirm(rpc, signed, lastValidBlockHeight, (s) => setStatus(`Deposit sent ${solTx(s)}, waiting for confirmation…`)).catch((e) => {
    if (e.expired) { t.status = 'quoted'; delete t.depositTx; saveTransfer(t); }
    throw e;
  });
  O.submitDeposit(t.depositTx, t.id).catch((e) => console.warn('1Click deposit submit', e));
  step(1, 'done');
  refreshBalances();
  await trackOneClick(t);
}

// ---------- Tron → Solana ----------

// Builds, checks, signs and broadcasts one Tron call; waits until it is confirmed. Returns { txid, info }.
async function tronCall({ contract, data, callValue = 0n, label, onSigned }) {
  const owner = tronW.address;
  const energy = await tron.estimateEnergy(owner, contract, data, callValue);
  const feeLimit = (() => { const f = (energy * 13n / 10n) * tronPrices.energy; return f < 10_000_000n ? 10_000_000n : f; })();
  if (feeLimit > MAX_FEE_LIMIT) throw new Error(`The ${label} would burn more than ${fmt(MAX_FEE_LIMIT)} TRX of energy; stopped.`);
  const tx = await tron.build({ owner, contract, data, callValue, feeLimit });
  setStatus(`Confirm the ${label} in ${tronW.name}…`);
  const slow = setTimeout(() => setStatus(`Still waiting for ${tronW.name}. If you already confirmed, check the wallet; if you rejected it, reload the page.`), 60_000);
  let signed;
  try { signed = await tronW.sign(tx); } finally { clearTimeout(slow); }
  // The wallet must return the very transaction that was checked, signed by the connected account.
  if (signed?.txID !== tx.txID || signed.raw_data_hex !== tx.raw_data_hex) throw new Error('The wallet changed the transaction. Nothing was sent.');
  await T.checkSignature(signed, owner);
  onSigned?.(signed.txID);
  await tron.broadcast(signed);
  setStatus(`${label[0].toUpperCase() + label.slice(1)} sent ${tronTx(signed.txID)}, waiting for confirmation…`);
  const expires = T.decodeTrigger(tx.raw_data_hex).expiration;
  for (;;) {
    await sleep(3000);
    const info = await tron.info(signed.txID).catch(() => null);
    if (info?.receipt) {
      if (info.receipt.result !== 'SUCCESS') throw Object.assign(new Error(`The ${label} failed on Tron (${info.receipt.result}).`), { txid: signed.txID, failed: true });
      return { txid: signed.txID, info };
    }
    if (Date.now() > expires + 90_000) throw Object.assign(new Error(`The ${label} expired before it was confirmed; nothing was spent. Try again.`), { expired: true });
  }
}

async function sendTronMesh(amount, to, shown) {
  const owner = tronW.address;
  setSteps(['Approve USDT for the Legacy Mesh', 'Sign the send on Tron', 'LayerZero verifies (LayerZero Labs + USDT0)', 'USDT arrives on Solana']);
  const r = await S.checkRecipient(rpc, to);
  if (!r.ok) throw new Error(r.why);
  const q = await tronMeshQuote(amount, to, r.usdtAccount);
  if (amount > q.limit) throw new Error('The amount is above what the Legacy Mesh can send to Solana right now.');
  let nativeFee = q.nativeFee;
  if (nativeFee * 100n > shown.nativeFee * FEE_RISE) {
    await confirmAgain(`The LayerZero fee rose from ${fmtNative(shown.nativeFee, 6)} to ${fmtNative(nativeFee, 6)} TRX since the quote.`);
  }
  // Approval (decision D2: exactly the amount). If USDT refuses to change a non-zero allowance, it is set to 0 first.
  const allowance = (await tron.view(T.USDT, T.TRC20_ABI, 'allowance', [T.toEvm(owner), T.toEvm(T.OFT)])).value;
  if (allowance < amount) {
    step(0, 'active');
    const approve = (v) => encodeFunctionData({ abi: T.TRC20_ABI, functionName: 'approve', args: [T.toEvm(T.OFT), v] });
    if (allowance > 0n && await tron.estimateEnergy(owner, T.USDT, approve(amount)).then(() => false, () => true)) {
      await tronCall({ contract: T.USDT, data: approve(0n), label: 'reset of the old approval' });
    }
    await tronCall({ contract: T.USDT, data: approve(amount), label: `approval of ${fmt(amount)} USDT` });
    step(0, 'done');
  } else step(0, 'skipped');
  step(1, 'active');
  const data = encodeFunctionData({ abi: T.OFT_ABI, functionName: 'send', args: [q.sp, { nativeFee, lzTokenFee: 0n }, T.toEvm(owner)] });
  const t = { route: 'mesh', dir: 't2s', from: owner, to, amount: String(amount), expected: String(M.received(amount)), created: Date.now(), status: 'sent', mesh: { nativeFee: String(nativeFee), extraOptions: q.sp.extraOptions } };
  const { txid, info } = await tronCall({ contract: T.OFT, data, callValue: nativeFee, label: `send of ${fmt(amount)} USDT (LayerZero fee ${fmtNative(nativeFee, 6)} TRX)`, onSigned: (id) => { t.id = id; saveTransfer(t); } })
    .catch((e) => { if (t.id && (e.expired || e.failed)) { t.status = 'failed'; t.note = e.message; saveTransfer(t); } throw e; });
  const sent = T.logsOf(info).filter((l) => l.address === T.OFT).map((l) => { try { return decodeEventLog({ abi: T.OFT_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'OFTSent');
  if (!sent || sent.args.amountReceivedLD !== M.received(amount) || sent.args.dstEid !== M.SOLANA_EID) throw new Error('The send confirmed, but its OFTSent event is not what was asked. Check it on Tronscan.');
  t.mesh.guid = sent.args.guid;
  saveTransfer(t);
  step(1, 'done');
  refreshBalances();
  await trackMesh(t, txid);
}

async function sendTronOneClick(amount, to, shown) {
  const owner = tronW?.address ?? null;
  const manual = !owner;
  setSteps(['Get the deposit address', manual ? 'Send the deposit from your Tron wallet' : 'Sign the deposit on Tron', 'Solvers fill the swap', 'USDT arrives on Solana']);
  step(0, 'active');
  const r = await S.checkRecipient(rpc, to);
  if (!r.ok) throw new Error(r.why);
  const refundTo = owner ?? $('refundTron')?.value.trim();
  if (!refundTo || !T.isAddress(refundTo)) throw new Error('Enter your Tron address for refunds first.');
  const req = O.request({ from: 'tron', amount, recipient: to, refundTo, dry: false });
  const resp = await O.quote(req);
  if (BigInt(resp.quote?.minAmountOut ?? 0) < shown.minOut) {
    await confirmAgain(`The minimum to arrive fell from ${fmt(shown.minOut)} to ${fmt(BigInt(resp.quote?.minAmountOut ?? 0))} USDT since the quote.`);
    shown = { ...shown, minOut: BigInt(resp.quote.minAmountOut) };
  }
  const q = O.checkQuote(resp, req, { minOut: shown.minOut, user: refundTo });
  const t = { id: q.depositAddress, route: 'oneclick', dir: 't2s', from: refundTo, to, amount: String(amount), expected: q.amountOut, minOut: q.minAmountOut, created: Date.now(), status: 'quoted', oneclick: { quoteResponse: resp } };
  saveTransfer(t);
  step(0, 'done');
  step(1, 'active');
  if (manual) {
    showDeposit(t);
    setStatus('Waiting for your deposit…');
  } else {
    const data = encodeFunctionData({ abi: T.TRC20_ABI, functionName: 'transfer', args: [T.toEvm(q.depositAddress), amount] });
    const { txid } = await tronCall({ contract: T.USDT, data, label: `deposit of ${fmt(amount)} USDT to 1Click`, onSigned: (id) => { t.depositTx = id; t.status = 'sent'; saveTransfer(t); } })
      .catch((e) => { if (e.expired) { t.status = 'quoted'; delete t.depositTx; saveTransfer(t); } throw e; });
    O.submitDeposit(txid, t.id).catch((e) => console.warn('1Click deposit submit', e));
    step(1, 'done');
    refreshBalances();
  }
  await trackOneClick(t);
}

// Decision D3: the deposit address, exact amount and deadline, for a send from another wallet.
function showDeposit(t) {
  const q = t.oneclick.quoteResponse.quote;
  $('deposit').innerHTML = `<p>Send <span class="big">exactly ${fmt(BigInt(t.amount))} USDT</span> (TRC-20) on Tron to</p>`
    + `<p><code>${esc(q.depositAddress)}</code></p>`
    + `<p>before <b>${new Date(q.deadline).toLocaleString()}</b>. A different amount, or a deposit after that, is refunded to ${esc(short(t.from))}, less a fee.</p>`
    + '<div class="row"><input id="depositTx" type="text" placeholder="the deposit\'s transaction id (optional, speeds it up)" spellcheck="false"><button id="depositSubmit" class="ghost" type="button">Submit</button></div>';
  $('deposit').hidden = false;
  $('depositSubmit').onclick = async () => {
    const id = $('depositTx').value.trim().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/i.test(id)) return;
    t.depositTx = id; t.status = 'sent'; saveTransfer(t);
    await O.submitDeposit(id, t.id).catch((e) => console.warn('1Click deposit submit', e));
    $('depositSubmit').disabled = true;
  };
}

// ---------- tracking ----------

// Follows a Legacy Mesh message on LayerZero Scan until it's delivered, then checks the delivery on the destination chain itself.
async function trackMesh(t, hash = t.id) {
  const n = $('steps').children.length;
  step(n - 2, 'active');
  const scanHash = t.dir === 't2s' ? '0x' + hash.replace(/^0x/, '') : hash;
  const started = Date.now();
  let warned = false;
  for (;;) {
    let m = null;
    try { m = await M.scanMessage(scanHash); } catch (e) { console.warn('scan', e); }
    const s = M.scanState(m);
    if (s.state === 'delivered') {
      step(n - 2, 'done');
      step(n - 1, 'active');
      setStatus('Delivered according to LayerZero; checking on the destination chain…');
      const got = await checkArrival(t, s.destTx, BigInt(t.expected), s.guid);
      t.status = 'delivered';
      t.destTx = s.destTx.replace(/^0x/, '');
      saveTransfer(t);
      step(n - 1, 'done');
      setStatus(`Done: ${fmt(got)} USDT arrived ${t.dir === 's2t' ? `on Tron at ${esc(short(t.to))} (${tronTx(t.destTx)})` : `on Solana at ${esc(short(t.to))} (${solTx(t.destTx)})`}.`, 'ok');
      refreshBalances();
      return;
    }
    if (s.state === 'problem') {
      t.status = 'problem';
      saveTransfer(t);
      setStatus(`${esc(s.text)} The USDT can't be refunded at the source; it waits to be delivered. See ${scanLink(scanHash)}${s.guid ? ` (message <code>${esc(short(s.guid))}</code>)` : ''}, and ask USDT0 support if it stays like this.`, 'err');
      return;
    }
    const slowNote = Date.now() - started > 15 * 60_000
      ? ` This is taking longer than usual. The USDT can't be refunded at the source; it waits for the verifiers. Follow it on ${scanLink(scanHash)}.` : '';
    if (slowNote && !warned) warned = true;
    setStatus(`${esc(s.text)} Usually 1–2 minutes. You can close this page; it resumes from "Recent transfers".${slowNote}`);
    await sleep(5000);
  }
}

async function trackOneClick(t) {
  const n = $('steps').children.length;
  for (;;) {
    let s = null;
    try { s = await O.status(t.id); } catch (e) { console.warn('1click status', e); }
    const st = O.statusState(s);
    if (st.state === 'processing' && t.status !== 'processing') {
      t.status = 'processing';
      saveTransfer(t);
      step(n - 3, 'done');
      step(n - 2, 'active');
    }
    if (st.state === 'delivered') {
      step(n - 3, 'done'); step(n - 2, 'done'); step(n - 1, 'active');
      setStatus('Delivered according to 1Click; checking on the destination chain…');
      const got = await checkArrival(t, st.destTx, BigInt(t.minOut));
      t.status = 'delivered';
      t.destTx = st.destTx;
      saveTransfer(t);
      step(n - 1, 'done');
      setStatus(`Done: ${fmt(got)} USDT arrived ${t.dir === 's2t' ? `on Tron (${tronTx(st.destTx)})` : `on Solana (${solTx(st.destTx)})`}.`, 'ok');
      refreshBalances();
      return;
    }
    if (st.state === 'refunded') {
      t.status = 'refunded';
      saveTransfer(t);
      setStatus(`${esc(st.text)}${st.refundTx ? ` Refund: ${t.dir === 's2t' ? solTx(st.refundTx) : tronTx(st.refundTx)}.` : ''}`, 'err');
      refreshBalances();
      return;
    }
    if (st.state === 'problem' && s?.status === 'FAILED') {
      t.status = 'failed';
      saveTransfer(t);
      const q = t.oneclick.quoteResponse;
      setStatus(`${esc(st.text)} Keep this quote and its signature for NEAR Intents support: deposit address <code>${esc(t.id)}</code>, signature <code>${esc(q.signature)}</code>, correlation id <code>${esc(q.correlationId ?? '')}</code>.`, 'err');
      return;
    }
    setStatus(`${esc(st.text)} Usually 1–2 minutes. You can close this page; it resumes from "Recent transfers".`, st.state === 'problem' ? 'err' : '');
    await sleep(5000);
  }
}

// Checks on the destination chain that the recipient got at least `min` USDT in `destTx`; returns the amount.
async function checkArrival(t, destTx, min, guid) {
  if (!destTx) throw new Error('No destination transaction was reported.');
  if (t.dir === 's2t') {
    const info = await tron.info(destTx.replace(/^0x/, ''));
    if (info?.receipt?.result !== 'SUCCESS') throw new Error(`The delivery transaction ${destTx} isn't a success on Tron.`);
    const logs = T.logsOf(info);
    let got = 0n;
    if (t.route === 'mesh') {
      for (const l of logs.filter((x) => x.address === T.OFT)) {
        try {
          const e = decodeEventLog({ abi: T.OFT_ABI, ...l });
          if (e.eventName === 'OFTReceived' && T.fromEvm(e.args.toAddress) === t.to && (!guid || e.args.guid === guid)) got += e.args.amountReceivedLD;
        } catch {}
      }
    } else {
      for (const l of logs.filter((x) => x.address === T.USDT)) {
        try {
          const e = decodeEventLog({ abi: T.TRC20_ABI, ...l });
          if (e.eventName === 'Transfer' && T.fromEvm(e.args.to) === t.to) got += e.args.value;
        } catch {}
      }
    }
    if (got < min) throw new Error(`The delivery ${destTx} paid ${fmt(got)} USDT to the recipient, less than ${fmt(min)}.`);
    return got;
  }
  const tx = await S.getTx(rpc, destTx);
  if (!tx || tx.meta.err) throw new Error(`The delivery transaction ${destTx} isn't a success on Solana.`);
  const got = S.usdtDelta(tx, t.to);
  if (got < min) throw new Error(`The delivery ${destTx} paid ${fmt(got)} USDT to the recipient, less than ${fmt(min)}.`);
  return got;
}

// ---------- go, resume ----------

async function go() {
  if (busy) return;
  const amount = parseAmount();
  const r = recipient();
  const k = selected();
  const shown = quotes[k];
  if (!amount || !r.ok || !shown?.ok) return;
  busy = true;
  render();
  await askNotifications();
  store.set(dir() === 's2t' ? KEYS.recipientTron : KEYS.recipientSol, r.address);
  try {
    if (dir() === 's2t') await (k === 'mesh' ? sendSolMesh : sendSolOneClick)(amount, r.address, shown);
    else await (k === 'mesh' ? sendTronMesh : sendTronOneClick)(amount, r.address, shown);
  } catch (e) {
    console.error(e);
    setStatus(isRejection(e) ? 'Cancelled in the wallet. Nothing was sent.' : esc(errMsg(e)), 'err');
  } finally {
    busy = false;
    render();
  }
}

async function resume(id) {
  if (busy || !id) return;
  id = id.trim();
  let t = transfers().find((x) => x.id === id || x.depositTx === id);
  if (!t) {
    // One this browser doesn't know: a Solana signature or Tron txid is a Legacy Mesh send; an address is a 1Click deposit.
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(id)) t = await meshFromSolana(id);
    else if (/^(0x)?[0-9a-fA-F]{64}$/.test(id)) t = await meshFromTron(id.replace(/^0x/, ''));
    else if (T.isAddress(id) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) t = await oneClickFromDeposit(id);
    else { setStatus('Not a signature, transaction id or deposit address.', 'err'); $('progress').hidden = false; return; }
  }
  busy = true;
  render();
  try {
    if (t.route === 'mesh') {
      setSteps([t.dir === 's2t' ? 'Sign the send on Solana' : 'Sign the send on Tron', 'LayerZero verifies (LayerZero Labs + USDT0)', `USDT arrives on ${t.dir === 's2t' ? 'Tron' : 'Solana'}`]);
      step(0, 'done');
      await trackMesh(t);
    } else {
      setSteps(['Get the deposit address', 'Deposit', 'Solvers fill the swap', `USDT arrives on ${t.dir === 's2t' ? 'Tron' : 'Solana'}`]);
      step(0, 'done');
      step(1, t.depositTx ? 'done' : 'active');
      if (!t.depositTx && t.dir === 't2s') showDeposit(t);
      await trackOneClick(t);
    }
  } catch (e) {
    console.error(e);
    setStatus(esc(errMsg(e)), 'err');
  } finally {
    busy = false;
    render();
  }
}

async function meshFromSolana(sig) {
  const tx = await S.getTx(rpc, sig);
  if (!tx) throw new Error('That Solana transaction was not found.');
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const ix = tx.transaction.message.instructions.find((i) => keys[i.programIdIndex] === M.PROGRAM.toBase58());
  const p = ix && M.decodeSendData(T.base58Decode(ix.data));
  if (!p || p.dstEid !== M.TRON_EID) throw new Error('That transaction is not a Legacy Mesh send to Tron.');
  const t = { id: sig, route: 'mesh', dir: 's2t', from: keys[0], to: T.fromEvm('0x' + T.bytesToHex(p.to.slice(12))), amount: String(p.amount), expected: String(M.received(p.amount)), created: (tx.blockTime ?? 0) * 1000, status: 'sent', mesh: {} };
  saveTransfer(t);
  return t;
}
async function meshFromTron(txid) {
  const info = await tron.info(txid);
  const sent = info && T.logsOf(info).filter((l) => l.address === T.OFT).map((l) => { try { return decodeEventLog({ abi: T.OFT_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === 'OFTSent');
  if (!sent || sent.args.dstEid !== M.SOLANA_EID) throw new Error('That transaction is not a Legacy Mesh send to Solana.');
  const m = await M.scanMessage('0x' + txid);
  const to = m?.source?.tx?.payload ? new PublicKey(T.hexToBytes(m.source.tx.payload.slice(2 + 4, 2 + 4 + 64))).toBase58() : null;
  if (!to) throw new Error('LayerZero Scan hasn\'t seen this send yet; try again in a minute.');
  const t = { id: txid, route: 'mesh', dir: 't2s', from: T.fromEvm(sent.args.fromAddress), to, amount: String(sent.args.amountSentLD), expected: String(sent.args.amountReceivedLD), created: info.blockTimeStamp, status: 'sent', mesh: { guid: sent.args.guid } };
  saveTransfer(t);
  return t;
}
async function oneClickFromDeposit(address) {
  const s = await O.status(address);
  if (!s?.quoteResponse) throw new Error('1Click knows no transfer with that deposit address.');
  const req = s.quoteResponse.quoteRequest, q = s.quoteResponse.quote;
  const dirOf = req.originAsset === O.ASSET.sol && req.destinationAsset === O.ASSET.tron ? 's2t' : req.originAsset === O.ASSET.tron && req.destinationAsset === O.ASSET.sol ? 't2s' : null;
  if (!dirOf) throw new Error('That 1Click transfer is not USDT between Solana and Tron.');
  const t = { id: address, route: 'oneclick', dir: dirOf, from: req.refundTo, to: req.recipient, amount: q.amountIn, expected: q.amountOut, minOut: q.minAmountOut, created: Date.parse(s.quoteResponse.timestamp) || Date.now(), status: 'sent', oneclick: { quoteResponse: s.quoteResponse } };
  saveTransfer(t);
  return t;
}

// ---------- wiring ----------

$('connectSol').onclick = async () => {
  if (sol) { const w = sol; store.set(KEYS.solOff, 1); setSol(null); try { await w.disconnect?.(); } catch {} return; }
  try { await connectSol(); } catch (e) { if (!isRejection(e)) alertStatus(e); }
};
$('connectTron').onclick = async () => {
  if (tronW) { const w = tronW; setTron(null); try { await w.disconnect?.(); } catch {} return; }
  try { await connectTron(); } catch (e) { if (!isRejection(e)) alertStatus(e); }
};
$('connectQr').onclick = async () => { try { await connectWalletConnect(); } catch (e) { if (!isRejection(e)) alertStatus(e); } };
function alertStatus(e) { $('noWallet').textContent = errMsg(e); $('noWallet').hidden = false; }

$('amount').oninput = () => { saveForm(); requote(); };
$('recipient').oninput = () => { $('recipient').dataset.auto = ''; requote(); };
$('max').onclick = () => {
  const b = dir() === 's2t' ? solBal?.usdt : tronBal?.usdt;
  if (b == null) return;
  $('amount').value = (Number(b) / 1e6).toString();
  saveForm();
  requote();
};
for (const r of document.querySelectorAll('input[name=dir]')) r.onchange = () => { chosen = null; saveForm(); showDirection(); };
$('go').onclick = () => {
  const wallet = dir() === 's2t' ? sol : tronW;
  if (!wallet && !(selected() === 'oneclick' && dir() === 't2s')) return;
  go();
};
$('resume').onclick = () => resume($('resumeId').value);

function saveForm() { store.set(KEYS.form, { dir: dir(), amount: $('amount').value }); }
function loadForm() {
  const f = store.get(KEYS.form);
  if (f?.dir) document.querySelector(`input[name=dir][value=${f.dir === 't2s' ? 't2s' : 's2t'}]`).checked = true;
  if (f?.amount) $('amount').value = f.amount;
}

if ($('commit').textContent.startsWith('__')) {
  $('commit').textContent = 'dev';
  $('commit').href = 'https://github.com/SwapMarket/sol2tron';
}

$('refundTron').oninput = () => render();

loadForm();
showDirection();
renderRecent();
O.tokens().then((p) => { prices = p; render(); }).catch((e) => console.warn('1Click tokens', e));
tron.prices().then((p) => { tronPrices = p; }).catch((e) => console.warn('tron prices', e));
setInterval(() => { if (!busy) refreshBalances(); }, 30_000);
setTimeout(async () => {
  const restored = await restoreWalletConnect().catch((e) => { console.warn('walletconnect restore', e); return false; });
  if (!restored || !sol) connectSol(true).catch(() => {});
  if (!restored || !tronW) connectTron(true).catch(() => {});
  // Unfinished transfers carry on.
  const open = transfers().find((t) => !['delivered', 'refunded', 'failed', 'quoted'].includes(t.status));
  if (open) resume(open.id);
}, 300);
