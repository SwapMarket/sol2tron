// Read-only check against mainnet, run by hand before a release: node --import ./test/register.js test/mainnet.mjs [SOLANA_OWNER]
// It never signs anything. Solana transactions are simulated with sigVerify off, as SOLANA_OWNER (a wallet holding USDT
// and SOL, given on the command line), so the simulation runs the real programs with the page's own account lists.
import { PublicKey } from '@solana/web3.js';
import { encodeFunctionData } from 'viem';
import * as S from 'solana';
import * as M from 'mesh';
import * as T from 'tron';

const rpc = S.rpcClient();
const fetchAccounts = async (keys) => (await rpc('getMultipleAccounts', [keys.map(String), { encoding: 'base64' }])).value
  .map((a) => (a ? { owner: a.owner, data: S.unb64(a.data[0]) } : null));
const fmt = (n, d = 6) => (Number(n) / 10 ** d).toLocaleString('en', { maximumFractionDigits: d });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// ---------- Solana → Tron ----------
if (!process.argv[2]) { console.error('usage: node --import ./test/register.js test/mainnet.mjs SOLANA_OWNER  (a wallet holding 10+ USDT and 0.2+ SOL)'); process.exit(2); }
const owner = new PublicKey(process.argv[2]);
console.log('Solana sender (simulated):', owner.toBase58());
const route = await M.loadRoute(fetchAccounts);
check(route.store.feeBps === M.FEE_BPS, `Solana fee_bps = ${route.store.feeBps}`);
console.log('     credits to Tron:', fmt(route.credits[M.TRON_EID]), 'USDT');
const amount = 10_000_000n; // 10 USDT
const to = M.tronRecipient('TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV');
const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
const quoteTx = S.buildTx(owner, [...S.computeBudget(1_400_000, 0n), M.quoteSendIx(route, { to, amount, minAmount: M.received(amount) })], blockhash, route.lookupTables);
const q = M.decodeQuoteReturn(M.returnDataOf(await S.simulate(rpc, quoteTx, [])));
console.log(`     quote_send: ${fmt(q.nativeFee, 9)} SOL`);
check(q.nativeFee > 0n && q.lzTokenFee === 0n, 'quote_send returns a SOL fee');
const sendTx = S.buildTx(owner, [...S.computeBudget(400_000, 0n), M.sendIx(route, owner, { to, amount, minAmount: M.received(amount), nativeFee: (q.nativeFee * 105n) / 100n })], blockhash, route.lookupTables);
check(sendTx.serialize().length <= 1232, `send transaction is ${sendTx.serialize().length} bytes`);
const sim = await S.simulate(rpc, sendTx, [S.ata(owner), owner]);
const r = M.decodeSendReturn(M.returnDataOf(sim));
const usdtSpent = S.tokenAmount(sim.before[0]) - S.tokenAmount(sim.after[0]);
const solSpent = S.lamportsOf(sim.before[1]) - S.lamportsOf(sim.after[1]);
console.log(`     send: ${sim.units} units; USDT −${fmt(usdtSpent)}, SOL −${fmt(solSpent, 9)}; arrives ${fmt(r.amountReceived)}; guid ${r.guid}`);
check(usdtSpent === amount, 'send takes exactly the amount');
check(r.amountReceived === M.received(amount), 'send delivers amount − 0.03%');
check(r.nativeFee === q.nativeFee, 'send charges the quoted fee, not the ceiling passed');
check(solSpent <= (q.nativeFee * 105n) / 100n, 'SOL spent is within the ceiling (simulation charges no transaction fee)');

// ---------- Tron → Solana ----------
const tron = T.client();
const fee = await tron.view(T.OFT, T.OFT_ABI, 'feeBps');
check(BigInt(fee.value) === M.FEE_BPS, `Tron feeBps = ${fee.value}`);
check((await tron.view(T.OFT, T.OFT_ABI, 'peers', [M.SOLANA_EID])).value === M.SOLANA_PEER, 'Tron peer for Solana is the Solana OFT store');
for (const hasAccount of [true, false]) {
  const sp = M.tronSendParam({ to: owner.toBase58(), amount, extraOptions: M.extraOptionsFor(hasAccount) });
  const [limit, , receipt] = (await tron.view(T.OFT, T.OFT_ABI, 'quoteOFT', [sp])).value;
  const { nativeFee } = (await tron.view(T.OFT, T.OFT_ABI, 'quoteSend', [sp, false])).value;
  console.log(`     ${hasAccount ? 'recipient has a USDT account' : 'recipient needs a USDT account'}: LayerZero fee ${fmt(nativeFee)} TRX; limit ${fmt(limit.maxAmountLD)} USDT`);
  check(receipt.amountReceivedLD === M.received(amount), 'Tron quoteOFT delivers amount − 0.03%');
}
const prices = await tron.prices();
console.log(`     Tron prices: energy ${prices.energy} sun, bandwidth ${prices.bandwidth} sun`);
// Energy of an approve, estimated from a holder of Tron USDT.
const holder = 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV';
const approveData = encodeFunctionData({ abi: T.TRC20_ABI, functionName: 'approve', args: [T.toEvm(T.OFT), 1n] });
console.log('     approve energy (estimate):', String(await tron.estimateEnergy(holder, T.USDT, approveData)));

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
