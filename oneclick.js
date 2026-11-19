// NEAR Intents 1Click: a quote gives a one-time deposit address; the user sends USDT there, solvers fill the swap, and the USDT
// arrives on the other chain (or the deposit is refunded to the sender by the deadline). API: https://1click.chaindefuser.com,
// OpenAPI at /docs/v0/openapi.yaml. No API key: the docs say unauthenticated quotes pay an extra 0.25% (decision D1).
// The quote is the operator's promise, not enforced on chain, so the page checks that it says exactly what was asked (checkQuote),
// and keeps the whole signed response (the API says to keep it for disputes).
import * as T from 'tron';
import { PublicKey } from '@solana/web3.js';

export const API = 'https://1click.chaindefuser.com/v0';
export const ASSET = {
  sol: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
  tron: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
};
const CONTRACT = { sol: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' };
export const SLIPPAGE_BPS = 50; // decision D5
export const MIN_DEADLINE_MS = 20 * 60_000;

async function call(path, init, fetcher) {
  const res = await fetcher(API + path, init);
  const j = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`1Click: ${j?.message ?? `HTTP ${res.status}`}`), { status: res.status });
  return j;
}

// The token list, checked: both asset ids must be USDT at the expected contracts. Returns USD prices by symbol for SOL and TRX,
// used only to compare the routes' fees, never in an amount anyone signs.
export async function tokens(fetcher = fetch) {
  const list = await call('/tokens', {}, fetcher);
  for (const [chain, id] of Object.entries(ASSET)) {
    const t = list.find((x) => x.assetId === id);
    if (!t || t.contractAddress !== CONTRACT[chain] || t.decimals !== 6) throw new Error(`1Click's ${chain} USDT is not the expected token.`);
  }
  const price = (id) => list.find((x) => x.assetId === id)?.price ?? null;
  return { SOL: price('nep141:sol.omft.near'), TRX: price('nep141:tron.omft.near') };
}

// The request for `amount` USDT from `from` ('sol' | 'tron') to the other chain.
export function request({ from, amount, recipient, refundTo, dry, now = Date.now() }) {
  const to = from === 'sol' ? 'tron' : 'sol';
  return {
    dry, swapType: 'EXACT_INPUT', slippageTolerance: SLIPPAGE_BPS,
    originAsset: ASSET[from], depositType: 'ORIGIN_CHAIN', destinationAsset: ASSET[to], amount: String(amount),
    refundTo, refundType: 'ORIGIN_CHAIN', recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + 60 * 60_000).toISOString(), referral: 'swapmarket',
  };
}

export const quote = (req, fetcher = fetch) => call('/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, fetcher);

// Throws unless a (non-dry) quote response is exactly what `req` asked for, with at least `minOut` arriving and a deposit address
// on the origin chain that isn't one of the user's own. Returns the quote.
export function checkQuote(resp, req, { minOut, user, now = Date.now() }) {
  const q = resp?.quote, r = resp?.quoteRequest;
  const bad = (what) => { throw new Error(`1Click's quote doesn't match the request (${what}). Nothing was sent.`); };
  if (!q || !r) bad('no quote');
  for (const k of ['swapType', 'originAsset', 'destinationAsset', 'amount', 'recipient', 'refundTo', 'depositType', 'refundType', 'recipientType']) {
    if (String(r[k]) !== String(req[k])) bad(k);
  }
  if (r.dry) bad('dry run');
  if (!resp.signature) bad('no signature');
  if (q.amountIn !== req.amount) bad('amount in');
  if (BigInt(q.minAmountOut) < minOut) bad('minimum out');
  if (BigInt(q.amountOut) < BigInt(q.minAmountOut)) bad('amount out');
  if (q.depositMemo) bad('memo');
  const from = req.originAsset === ASSET.sol ? 'sol' : 'tron';
  const deposit = q.depositAddress;
  if (from === 'sol') {
    let pk;
    try { pk = new PublicKey(deposit); } catch { bad('deposit address'); }
    if (!PublicKey.isOnCurve(pk.toBytes())) bad('deposit address is not a wallet');
  } else if (!T.isAddress(deposit)) bad('deposit address');
  if ([user, req.recipient, req.refundTo].includes(deposit)) bad('deposit address is your own');
  if (!(Date.parse(q.deadline) >= now + MIN_DEADLINE_MS)) bad('deadline too near');
  return q;
}

export const submitDeposit = (txHash, depositAddress, fetcher = fetch) =>
  call('/deposit/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash, depositAddress }) }, fetcher);

export async function status(depositAddress, fetcher = fetch) {
  try {
    return await call(`/status?depositAddress=${encodeURIComponent(depositAddress)}`, {}, fetcher);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// What a status response says, for the page: { state: 'waiting' | 'processing' | 'delivered' | 'refunded' | 'problem', text, destTx }.
export function statusState(s) {
  const d = s?.swapDetails ?? {};
  const fmt = (v) => (v == null ? '?' : (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  switch (s?.status) {
    case undefined: case null: case 'PENDING_DEPOSIT': return { state: 'waiting', text: 'Waiting for 1Click to see the deposit…' };
    case 'KNOWN_DEPOSIT_TX': case 'PROCESSING': return { state: 'processing', text: 'Deposit received; the swap is being filled…' };
    case 'INCOMPLETE_DEPOSIT': return { state: 'problem', text: `1Click received ${fmt(d.depositedAmount)} USDT, less than the quote needs. It will be refunded after the deadline.` };
    case 'SUCCESS': return { state: 'delivered', text: `Delivered ${fmt(d.amountOut)} USDT.`, destTx: d.destinationChainTxHashes?.[0]?.hash, amountOut: d.amountOut };
    case 'REFUNDED': return { state: 'refunded', text: `Refunded ${fmt(d.refundedAmount)} USDT to the sender${d.refundReason ? ` (${d.refundReason})` : ''}.`, refundTx: d.originChainTxHashes?.at(-1)?.hash };
    case 'FAILED': return { state: 'problem', text: '1Click reports the swap FAILED.' };
    default: return { state: 'processing', text: `1Click status: ${s.status}.` };
  }
}
