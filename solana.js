// Solana helpers shared by both routes: RPC, token accounts, an SPL transfer (the 1Click deposit), compute budget, and the check by
// simulation that every transaction passes before a wallet is asked to sign.
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
export const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; // mainnet-beta (its first 32 characters are the CAIP-2 chain id)
// Rent of a 165-byte token account, in lamports.
export const TOKEN_ACCOUNT_RENT = 2_039_280n;

export const ata = (owner, mint = USDT_MINT) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];

export const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// A JSON-RPC client over a list of public endpoints: the first that answers is used. Each must be on mainnet (genesis checked once).
export function rpcClient(urls = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'], fetcher = fetch) {
  let index = 0;
  const checked = new Map();
  const raw = async (url, method, params) => {
    const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { rpc: true, data: j.error.data });
    return j.result;
  };
  const onMainnet = (url) => {
    if (!checked.has(url)) {
      checked.set(url, raw(url, 'getGenesisHash', []).then((g) => { if (g !== GENESIS) throw new Error(`${new URL(url).host} is not Solana mainnet`); }));
      checked.get(url).catch(() => checked.delete(url));
    }
    return checked.get(url);
  };
  return async function rpc(method, params = []) {
    let last;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[(index + i) % urls.length];
      try {
        await onMainnet(url);
        const r = await raw(url, method, params);
        index = (index + i) % urls.length;
        return r;
      } catch (e) {
        // A transaction or simulation error is an answer, not an endpoint problem.
        if (e.rpc && (method === 'sendTransaction' || method === 'simulateTransaction')) throw e;
        last = e;
      }
    }
    throw last;
  };
}

// SPL token account: { mint, owner, amount } from base64 account info, or null.
export function parseTokenAccount(acct) {
  if (!acct?.data) return null;
  const d = unb64(acct.data[0]);
  if (d.length < 72) return null;
  return { mint: new PublicKey(d.subarray(0, 32)), owner: new PublicKey(d.subarray(32, 64)), amount: new DataView(d.buffer, d.byteOffset).getBigUint64(64, true) };
}
export const tokenAmount = (acct) => parseTokenAccount(acct)?.amount ?? null;

// What an address entered as a Solana recipient is. Funds sent "to" a token account or a program would be lost, so only wallets
// (system-owned accounts, or keys with no account yet) are accepted. Returns { ok, why, usdtAccount (exists) }.
export async function checkRecipient(rpc, address) {
  let pk;
  try { pk = new PublicKey(address); } catch { return { ok: false, why: 'Not a Solana address.' }; }
  const { value: [acct, usdt] } = await rpc('getMultipleAccounts', [[pk.toBase58(), ata(pk).toBase58()], { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  if (acct && acct.owner === TOKEN_PROGRAM.toBase58()) return { ok: false, why: 'That is a token account, not a wallet. Enter the wallet (owner) address.' };
  if (acct?.executable) return { ok: false, why: 'That is a program, not a wallet.' };
  if (acct && acct.owner !== SystemProgram.programId.toBase58()) return { ok: false, why: 'That address belongs to a program, not a wallet.' };
  return { ok: true, pk, usdtAccount: !!usdt };
}

// ---------- instructions ----------

export function computeBudget(units, microLamports) {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const out = [new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: limit })];
  if (microLamports > 0n) {
    const price = new Uint8Array(9);
    price[0] = 3;
    new DataView(price.buffer).setBigUint64(1, BigInt(microLamports), true);
    out.push(new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: price }));
  }
  return out;
}

// A priority fee: the median of recent fees paid around these accounts, capped, so a send lands without paying much (at the cap,
// 400k units cost 0.0004 SOL).
export async function priorityFee(rpc, accounts, cap = 1_000_000n) {
  try {
    const fees = (await rpc('getRecentPrioritizationFees', [accounts.map(String)])).map((f) => BigInt(f.prioritizationFee)).sort((a, b) => (a < b ? -1 : 1));
    const median = fees.length ? fees[Math.floor(fees.length / 2)] : 0n;
    return median > cap ? cap : median;
  } catch { return 0n; }
}

export function createAtaIdempotent(payer, owner, mint = USDT_MINT) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.from([1]),
  });
}

// transferChecked of `amount` USDT (6 decimals) from `owner`'s account to `to`'s.
export function transferUsdt(owner, to, amount) {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = 6;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: ata(owner), isSigner: false, isWritable: true },
      { pubkey: USDT_MINT, isSigner: false, isWritable: false },
      { pubkey: ata(to), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function buildTx(payer, instructions, blockhash, lookupTables = []) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(lookupTables));
}

// ---------- simulation ----------

// Simulates `tx` and reports what it would do to `watch` (addresses): { before, after } account infos, the logs, the return data,
// and the units used. Throws with the logs if it fails.
export async function simulate(rpc, tx, watch) {
  const addresses = watch.map(String);
  const [{ value: before }, sim] = await Promise.all([
    rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]),
    rpc('simulateTransaction', [b64(tx.serialize()), {
      encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    }]),
  ]);
  const v = sim.value;
  if (v.err) {
    const err = new Error(`Simulation failed: ${JSON.stringify(v.err)}`);
    err.logs = v.logs ?? [];
    err.simErr = v.err;
    throw err;
  }
  return { before, after: v.accounts, logs: v.logs ?? [], returnData: v.returnData, units: v.unitsConsumed };
}

export const lamportsOf = (acct) => BigInt(acct?.lamports ?? 0);

// Sends a signed transaction and waits for it; re-sends until confirmed or the blockhash expires (then nothing was spent).
export async function sendAndConfirm(rpc, signed, lastValidBlockHeight, onSent = () => {}) {
  const raw = b64(signed.serialize());
  const sig = await rpc('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }]);
  onSent(sig);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { value: [st] } = await rpc('getSignatureStatuses', [[sig]]);
    if (st?.err) throw Object.assign(new Error(`The transaction failed on Solana: ${JSON.stringify(st.err)}`), { sig });
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if ((await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lastValidBlockHeight) {
      // One last look: it may have landed just before expiring.
      const { value: [late] } = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      if (late && !late.err) return sig;
      throw Object.assign(new Error('The transaction expired before it was confirmed; nothing was spent. Try again.'), { sig, expired: true });
    }
    rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {});
  }
}

// A confirmed transaction (any version), or null.
export const getTx = (rpc, sig) => rpc('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);

// How much a transaction changed `owner`'s USDT, from its token balances.
export function usdtDelta(tx, owner) {
  const sum = (list) => (list ?? []).filter((b) => b.mint === USDT_MINT.toBase58() && b.owner === owner.toString())
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
}

export { PublicKey, VersionedTransaction, TransactionInstruction };
