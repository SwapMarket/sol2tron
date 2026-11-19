import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import * as S from 'solana';
import * as M from 'mesh';
import * as T from 'tron';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const saved = fixture('solana-accounts.json'); // what loadRoute read from mainnet (test/capture.mjs)
const fetchAccounts = async (keys) => keys.map((k) => {
  const a = saved[k.toBase58()];
  return a ? { owner: a.owner, data: S.unb64(a.data[0]) } : null;
});
const sendTx = fixture('solana-send.json'); // mainnet 5HRRJh…: 827 USDT from Solana to Tron

// The mainnet transaction's accounts, with their flags, as a v0 message lays them out.
function txAccounts(tx) {
  const m = tx.transaction.message;
  const { numRequiredSignatures: sig, numReadonlySignedAccounts: roSig, numReadonlyUnsignedAccounts: roUnsig } = m.header;
  const n = m.accountKeys.length;
  const statics = m.accountKeys.map((k, i) => ({
    pubkey: k, isSigner: i < sig, isWritable: i < sig ? i < sig - roSig : i < n - roUnsig,
  }));
  return [
    ...statics,
    ...tx.meta.loadedAddresses.writable.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
    ...tx.meta.loadedAddresses.readonly.map((k) => ({ pubkey: k, isSigner: false, isWritable: false })),
  ];
}
const mainnetSend = () => {
  const keys = txAccounts(sendTx);
  const ix = sendTx.transaction.message.instructions.find((i) => keys[i.programIdIndex].pubkey === M.PROGRAM.toBase58());
  return { keys: ix.accounts.map((i) => keys[i]), data: T.base58Decode(ix.data) };
};

test('loadRoute reads the saved mainnet state and checks it', async () => {
  const route = await M.loadRoute(fetchAccounts);
  assert.equal(route.store.feeBps, 3n);
  assert.ok(route.store.tokenMint.equals(S.USDT_MINT));
  assert.equal(T.bytesToHex(route.peerConfig.peerAddress), M.TRON_PEER);
  assert.ok(route.credits[M.TRON_EID] > 0n);
  // Executor + LayerZero Labs + USDT0, the two required verifiers.
  assert.equal(route.endpoint.workers.length, 3);
  assert.ok(route.lookupTables[0].state.addresses.length > 0);
});

test('the send instruction matches mainnet send 5HRRJh… account for account and byte for byte', async () => {
  const route = await M.loadRoute(fetchAccounts);
  const real = mainnetSend();
  const p = M.decodeSendData(real.data);
  const owner = new PublicKey(real.keys[0].pubkey);
  assert.equal(p.dstEid, M.TRON_EID);
  // That send's recipient: 12 zero bytes then a Tron address.
  const to = T.fromEvm('0x' + T.bytesToHex(p.to.slice(12)));
  assert.deepEqual(M.tronRecipient(to), p.to);
  const ix = M.sendIx(route, owner, { to: p.to, amount: p.amount, minAmount: p.minAmount, nativeFee: p.nativeFee });
  // Its extra options were "0x0003" (an empty type-3 option), which changes nothing; ours are empty.
  const ours = M.decodeSendData(ix.data);
  assert.deepEqual({ ...ours, extraOptions: null }, { ...p, extraOptions: null });
  // Same accounts in the same order. A compiled transaction keeps one flag per key, merged over its instructions (the signer is
  // writable because it pays), so the flags are compared merged, with the signer as fee payer.
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), real.keys.map((k) => k.pubkey));
  const merged = new Map([[owner.toBase58(), { isSigner: true, isWritable: true }]]);
  for (const k of ix.keys) {
    const m = merged.get(k.pubkey.toBase58()) ?? { isSigner: false, isWritable: false };
    merged.set(k.pubkey.toBase58(), { isSigner: m.isSigner || k.isSigner, isWritable: m.isWritable || k.isWritable });
  }
  for (const k of real.keys) assert.deepEqual(merged.get(k.pubkey), { isSigner: k.isSigner, isWritable: k.isWritable }, k.pubkey);
});

test('the send compiles through the lookup table to a transaction small enough to send', async () => {
  const route = await M.loadRoute(fetchAccounts);
  const owner = new PublicKey('B7MByhstU2DrXCmhhfBbAu8zCJycDBCFdz7DthEze8WX');
  const to = M.tronRecipient('TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV');
  const ix = M.sendIx(route, owner, { to, amount: 100_000_000n, minAmount: M.received(100_000_000n), nativeFee: 160_000_000n });
  const tx = S.buildTx(owner, [...S.computeBudget(400_000, 1000n), ix], '11111111111111111111111111111111', route.lookupTables);
  assert.ok(tx.serialize().length <= 1232);
});

test('fee math: 3 bps, rounded down, as the program computes it', () => {
  assert.equal(M.received(0n), 0n);
  assert.equal(M.received(1n), 1n);
  assert.equal(M.received(3333n), 3333n); // 3333 × 3 / 10000 rounds down to 0
  assert.equal(M.received(3334n), 3333n);
  assert.equal(M.received(1_000_000n), 999_700n);
  assert.equal(M.received(827_000_000n), 826_751_900n);
  const max = 2n ** 64n - 1n;
  assert.equal(M.oftFee(max), (max * 3n) / 10_000n);
});

test('options: the rent value for a missing Solana account encodes as on mainnet', () => {
  assert.equal(M.extraOptionsFor(false), '0x00030100210100000000000000000000000000000000000000000000000000000000001f1df0');
  assert.equal(M.extraOptionsFor(true), '0x');
});

test('return data: send and quote decode; wrong sizes are refused', () => {
  // A send's return data, from a mainnet simulation in BoltzExchange/boltz-web-app's tests.
  const r = M.decodeSendReturn(S.unb64('RAYfEjUX28McJNZS29+yNa3JaNehFEaKBZ0WYsGMxBPhBAAAAAAAAA3PDQAAAAAAAAAAAAAAAAApqB4AAAAAAM+lHgAAAAAA'));
  assert.equal(r.amountSent - r.amountReceived, M.oftFee(r.amountSent));
  assert.throws(() => M.decodeSendReturn(new Uint8Array(71)));
  assert.deepEqual(M.decodeQuoteReturn(new Uint8Array(16)), { nativeFee: 0n, lzTokenFee: 0n });
});

test('Scan states, including statuses never seen', () => {
  assert.equal(M.scanState(null).state, 'waiting');
  assert.equal(M.scanState({ status: { name: 'DELIVERED' }, destination: { tx: { txHash: '0xab' } } }).destTx, '0xab');
  assert.equal(M.scanState({ status: { name: 'INFLIGHT' }, verification: { dvn: { dvns: { a: { status: 'SUCCEEDED' }, b: {} } } } }).text, 'Verifying: 1 of 2 verifiers have confirmed.');
  assert.equal(M.scanState({ status: { name: 'BLOCKED' } }).state, 'problem');
  assert.equal(M.scanState({ status: { name: 'SOMETHING_NEW' } }).state, 'verifying');
});

test('loadRoute refuses a store for another token, or another peer', async () => {
  const tamper = (address, offset, byte) => async (keys) => (await fetchAccounts(keys)).map((a, i) => {
    if (!a || keys[i].toBase58() !== address) return a;
    const data = a.data.slice();
    data[offset] ^= byte;
    return { ...a, data };
  });
  await assert.rejects(M.loadRoute(tamper(M.OFT_STORE.toBase58(), 8, 1)), /not for USDT/);
  await assert.rejects(M.loadRoute(tamper(M.peerAddress(M.TRON_EID).toBase58(), 8 + 31, 1)), /not the Tron OFT/);
  await assert.rejects(M.loadRoute(async (keys) => (await fetchAccounts(keys)).map((a) => a && { ...a, owner: '11111111111111111111111111111111' })), /not found/);
});
