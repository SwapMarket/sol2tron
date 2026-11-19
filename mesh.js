// USDT0 Legacy Mesh (Tether's LayerZero network) between Solana and Tron: one LayerZero message per transfer, from the source
// pool to the destination pool. See docs/assumptions.md for every address and where it was checked.
//
// The Solana instructions follow the program's source (LayerZero-Labs/usdt-native-mesh@4ce9a59, verified build of
// Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7). The LayerZero endpoint accounts a send needs are resolved as in Tether's
// @tetherto/wdk-protocol-bridge-usdt0-solana (src/usdt0-protocol-solana.js, _getEndpointRoute and _getSend/QuoteEndpointAccounts;
// Copyright 2024 Tether Operations Limited, Apache License 2.0), ported here to @solana/web3.js.
import { PublicKey, TransactionInstruction, AddressLookupTableAccount } from '@solana/web3.js';
import * as S from 'solana';
import * as T from 'tron';

export const FEE_BPS = 3n; // checked against the chains at every quote; the page refuses to go on if either side differs
export const SOLANA_EID = 30168;
export const TRON_EID = 30420;
export const PROGRAM = new PublicKey('Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7');
export const OFT_STORE = new PublicKey('HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN');
export const ENDPOINT = new PublicKey('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6');
export const ULN = new PublicKey('7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const ALT_PROGRAM = new PublicKey('AddressLookupTab1e1111111111111111111111111');
// The Tron OFT, as the Solana peer config stores it: 12 zero bytes, then its 20-byte address.
export const TRON_PEER = '0000000000000000000000003a08f76772e200653bb55c2a92998daca62e0e97';
// The Solana OFT store, as the Tron OFT's peers(30168) returns it.
export const SOLANA_PEER = '0x' + T.bytesToHex(OFT_STORE.toBytes());
export const SCAN = 'https://scan.layerzero-api.com/v1';

const DISC = {
  oftStore: 'c3d76886b9c3f072', peerConfig: 'b59d56c621c15ecb', quoteSend: 'cf0031d6a0d34cd3', send: '66fb14bb414b0c45',
  ulnSettings: 'e2c764fd2673a79a', sendLibraryConfig: '3dee1f48fb7542b0', ulnSendConfig: '5bdd878983c7ae19',
  executorConfig: '8611e2180aad9d4e', dvnConfig: '31512162eaa85d49',
};

export const oftFee = (amount, bps = FEE_BPS) => (amount * bps) / 10_000n;
export const received = (amount, bps = FEE_BPS) => amount - oftFee(amount, bps);

// ---------- Borsh ----------

class Reader {
  constructor(bytes, disc) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
    if (disc && T.bytesToHex(this.bytes(8)) !== disc) throw new Error('unexpected account type');
  }
  need(n) { if (this.o + n > this.b.length) throw new Error('truncated account'); }
  bytes(n) { this.need(n); const out = this.b.subarray(this.o, this.o + n); this.o += n; return out; }
  u8() { return this.bytes(1)[0]; }
  bool() { return this.u8() !== 0; }
  u16() { this.need(2); const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64() { this.need(8); const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  key() { return new PublicKey(this.bytes(32)); }
  vec(f) { const n = this.u32(); return Array.from({ length: n }, () => f()); }
  vecBytes() { return this.bytes(this.u32()); }
  option(f) { return this.u8() ? f() : null; }
}

class Writer {
  constructor() { this.parts = []; }
  raw(b) { this.parts.push(Uint8Array.from(b)); return this; }
  u32(x) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); return this.raw(b); }
  u64(x) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(x), true); return this.raw(b); }
  bool(x) { return this.raw([x ? 1 : 0]); }
  vecBytes(b) { return this.u32(b.length).raw(b); }
  done() { const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

export function parseOftStore(data) {
  const r = new Reader(data, DISC.oftStore);
  const s = { tokenMint: r.key(), tokenEscrow: r.key(), endpointProgram: r.key(), bump: r.u8(), feeBalance: r.u64() };
  r.key(); r.key(); r.key(); r.key(); // super admin, planner, lp admin, burn-and-nilify admin
  s.feeBps = BigInt(r.u16());
  s.alt = r.option(() => r.key());
  return s;
}
export function parsePeerConfig(data) {
  const r = new Reader(data, DISC.peerConfig);
  return { peerAddress: r.bytes(32), enforced: { withdrawRemote: r.vecBytes(), sendOft: r.vecBytes(), sendCredits: r.vecBytes(), sendOftAndCall: r.vecBytes() } };
}
// Credits: bump, then (eid u32, amount u64) entries. Returns { [eid]: amount }.
export function parseCredits(data) {
  const r = new Reader(data);
  r.bytes(8); r.u8();
  return Object.fromEntries(r.vec(() => [r.u32(), r.u64()]));
}
const parseSendLibraryConfig = (d) => new Reader(d, DISC.sendLibraryConfig).key();
function parseUlnSendConfig(d) {
  const r = new Reader(d, DISC.ulnSendConfig);
  r.u8(); r.u64(); r.u8(); r.u8(); r.u8();
  return { requiredDvns: r.vec(() => r.key()), optionalDvns: r.vec(() => r.key()), maxMessageSize: r.u32(), executor: r.key() };
}
function parseUlnTreasury(d) {
  const r = new Reader(d, DISC.ulnSettings);
  r.u32(); r.key(); r.key(); r.u8(); r.key();
  const t = r.option(() => { r.option(() => r.key()); return r.key(); });
  return t; // native receiver, or null
}
function parseExecutorPriceFeed(d) {
  const r = new Reader(d, DISC.executorConfig);
  r.u8(); r.key();
  for (let i = 0; i < 5; i++) r.vec(() => r.key()); // allow, deny, admins, executors, msglibs
  r.bool(); r.u16();
  return r.key();
}
function parseDvnPriceFeed(d) {
  const r = new Reader(d, DISC.dvnConfig);
  r.u32(); r.u8(); r.vec(() => r.bytes(64)); r.u8();
  r.vec(() => r.key()); r.vec(() => r.key()); r.bool(); r.vec(() => r.key()); r.vec(() => r.key());
  return r.key();
}
const parseAlt = (d) => {
  // Address lookup table: 56-byte header, then 32-byte addresses.
  if (d.length < 56 || (d.length - 56) % 32) throw new Error('bad lookup table');
  return Array.from({ length: (d.length - 56) / 32 }, (_, i) => new PublicKey(d.subarray(56 + 32 * i, 88 + 32 * i)));
};

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s) => new TextEncoder().encode(s);
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
export const peerAddress = (dstEid) => pda([enc('Peer'), be32(dstEid)], PROGRAM);
export const CREDITS = pda([enc('Credits')], PROGRAM);
const EVENT_AUTHORITY = pda([enc('__event_authority')], PROGRAM);

// ---------- the route on Solana ----------

// Reads everything a quote and a send to `dstEid` need, and checks each account's owner and type. `fetchAccounts(keys)` returns
// [{ owner (base58), data (Uint8Array) } | null]; on the page it is getMultipleAccounts.
export async function loadRoute(fetchAccounts, dstEid = TRON_EID) {
  const peer = peerAddress(dstEid);
  const [storeAcct, peerAcct, creditsAcct] = await fetchAccounts([OFT_STORE, peer, CREDITS]);
  const owned = (a, program, what) => { if (!a || a.owner !== program.toBase58()) throw new Error(`${what} not found on Solana`); return a.data; };
  const store = parseOftStore(owned(storeAcct, PROGRAM, 'Legacy Mesh OFT store'));
  if (!store.tokenMint.equals(S.USDT_MINT)) throw new Error('The Legacy Mesh OFT store is not for USDT.');
  if (!store.endpointProgram.equals(ENDPOINT)) throw new Error('The Legacy Mesh OFT store uses another LayerZero endpoint.');
  const peerConfig = parsePeerConfig(owned(peerAcct, PROGRAM, 'Legacy Mesh peer'));
  if (dstEid === TRON_EID && T.bytesToHex(peerConfig.peerAddress) !== TRON_PEER) throw new Error('The Legacy Mesh peer for Tron is not the Tron OFT.');
  const credits = parseCredits(owned(creditsAcct, PROGRAM, 'Legacy Mesh credits'));
  let lookupTables = [];
  if (store.alt) {
    const [alt] = await fetchAccounts([store.alt]);
    lookupTables = [new AddressLookupTableAccount({ key: store.alt, state: { addresses: parseAlt(owned(alt, ALT_PROGRAM, 'Lookup table')), deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 } })];
  }
  const endpoint = await endpointRoute(fetchAccounts, OFT_STORE, dstEid, peerConfig.peerAddress);
  return { dstEid, peer, store, peerConfig, credits, lookupTables, endpoint };
}

async function endpointRoute(fetchAccounts, sender, dstEid, receiver) {
  const eid = be32(dstEid), s = sender.toBytes();
  const sendLibraryConfig = pda([enc('SendLibraryConfig'), s, eid], ENDPOINT);
  const defaultSendLibraryConfig = pda([enc('SendLibraryConfig'), eid], ENDPOINT);
  const uln = pda([enc('MessageLib')], ULN);
  const sendConfig = pda([enc('SendConfig'), eid, s], ULN);
  const defaultSendConfig = pda([enc('SendConfig'), eid], ULN);
  const [lib, defLib, sc, defSc, ulnAcct] = await fetchAccounts([sendLibraryConfig, defaultSendLibraryConfig, sendConfig, defaultSendConfig, uln]);
  if (!lib || !defLib || lib.owner !== ENDPOINT.toBase58() || defLib.owner !== ENDPOINT.toBase58()) throw new Error('LayerZero send library not set up.');
  let messageLib = parseSendLibraryConfig(lib.data);
  if (messageLib.equals(SYSTEM)) messageLib = parseSendLibraryConfig(defLib.data);
  if (!messageLib.equals(uln)) throw new Error('Unsupported LayerZero message library.');
  if (!defSc || !ulnAcct || [defSc, ulnAcct, ...(sc ? [sc] : [])].some((a) => a.owner !== ULN.toBase58())) throw new Error('LayerZero ULN config not found.');
  const defaults = parseUlnSendConfig(defSc.data);
  const custom = sc ? parseUlnSendConfig(sc.data) : null;
  const executor = custom && !custom.executor.equals(SYSTEM) ? custom.executor : defaults.executor;
  const pick = (k) => (custom?.[k].length ? custom[k].filter((d) => !d.equals(SYSTEM)) : defaults[k]);
  const workers = [executor, ...pick('requiredDvns'), ...pick('optionalDvns')];
  const configs = await fetchAccounts(workers);
  const feeds = configs.map((c, i) => {
    if (!c) throw new Error(`LayerZero worker ${workers[i].toBase58()} not found.`);
    return { program: new PublicKey(c.owner), config: workers[i], priceFeed: i === 0 ? parseExecutorPriceFeed(c.data) : parseDvnPriceFeed(c.data) };
  });
  const feedAccts = await fetchAccounts(feeds.map((f) => f.priceFeed));
  for (const [i, f] of feeds.entries()) {
    if (!feedAccts[i]) throw new Error(`LayerZero price feed ${f.priceFeed.toBase58()} not found.`);
    f.priceFeedProgram = new PublicKey(feedAccts[i].owner);
  }
  return {
    sender, uln, sendLibraryConfig, defaultSendLibraryConfig, sendConfig, defaultSendConfig, workers: feeds,
    sendLibraryInfo: pda([enc('MessageLib'), uln.toBytes()], ENDPOINT),
    endpointSettings: pda([enc('Endpoint')], ENDPOINT),
    nonce: pda([enc('Nonce'), s, eid, receiver], ENDPOINT),
    endpointEventAuthority: pda([enc('__event_authority')], ENDPOINT),
    ulnEventAuthority: pda([enc('__event_authority')], ULN),
    treasury: parseUlnTreasury(ulnAcct.data),
  };
}

const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

function quoteEndpointAccounts(e) {
  return [
    meta(ENDPOINT), meta(ULN), meta(e.sendLibraryConfig), meta(e.defaultSendLibraryConfig), meta(e.sendLibraryInfo), meta(e.endpointSettings),
    meta(e.nonce), meta(e.uln), meta(e.sendConfig), meta(e.defaultSendConfig),
    ...e.workers.flatMap((w) => [meta(w.program), meta(w.config), meta(w.priceFeedProgram), meta(w.priceFeed)]),
  ];
}
function sendEndpointAccounts(payer, e) {
  return [
    meta(ENDPOINT), meta(e.sender), meta(ULN), meta(e.sendLibraryConfig), meta(e.defaultSendLibraryConfig), meta(e.sendLibraryInfo),
    meta(e.endpointSettings), meta(e.nonce, true), meta(e.endpointEventAuthority), meta(ENDPOINT), meta(e.uln), meta(e.sendConfig),
    meta(e.defaultSendConfig), meta(payer, true, true), e.treasury ? meta(e.treasury, true) : meta(ULN), meta(SYSTEM), meta(e.ulnEventAuthority), meta(ULN),
    ...e.workers.flatMap((w) => [meta(w.program), meta(w.config, true), meta(w.priceFeedProgram), meta(w.priceFeed)]),
  ];
}

// The 32-byte `to` of a Tron recipient: 12 zero bytes, then its 20-byte address (the form every mainnet send to Tron used).
export function tronRecipient(address) {
  const out = new Uint8Array(32);
  out.set(T.decodeAddress(address).slice(1), 12);
  return out;
}

function sendParams(w, { to, amount, minAmount, extraOptions = new Uint8Array() }) {
  return w.u32(TRON_EID).raw(to).u64(amount).u64(minAmount).vecBytes(extraOptions).raw([0]); // compose_msg: None
}

export function quoteSendIx(route, { to, amount, minAmount }) {
  const data = sendParams(new Writer().raw(T.hexToBytes(DISC.quoteSend)), { to, amount, minAmount }).bool(false).done();
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [meta(OFT_STORE), meta(CREDITS), meta(route.peer), ...quoteEndpointAccounts(route.endpoint)],
    data,
  });
}

export function sendIx(route, owner, { to, amount, minAmount, nativeFee }) {
  const data = sendParams(new Writer().raw(T.hexToBytes(DISC.send)), { to, amount, minAmount }).u64(nativeFee).u64(0n).done();
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      meta(owner, false, true), meta(route.peer), meta(OFT_STORE, true), meta(CREDITS, true), meta(S.ata(owner), true),
      meta(route.store.tokenEscrow, true), meta(route.store.tokenMint), meta(S.TOKEN_PROGRAM), meta(EVENT_AUTHORITY), meta(PROGRAM),
      ...sendEndpointAccounts(owner, route.endpoint),
    ],
    data,
  });
}

// The send instruction's arguments, decoded (for tests and for reading a send back from the chain).
export function decodeSendData(data) {
  const r = new Reader(data);
  if (T.bytesToHex(r.bytes(8)) !== DISC.send) throw new Error('not a send');
  const p = { dstEid: r.u32(), to: r.bytes(32), amount: r.u64(), minAmount: r.u64(), extraOptions: r.vecBytes() };
  if (r.u8()) r.vecBytes();
  p.nativeFee = r.u64();
  p.lzTokenFee = r.u64();
  return p;
}

// Return data of `send`: (MessagingReceipt { guid, nonce, fee { native, lz } }, OFTReceipt { sent, received }).
export function decodeSendReturn(bytes) {
  if (bytes.length !== 72) throw new Error('unexpected send return data');
  const r = new Reader(bytes);
  return { guid: '0x' + T.bytesToHex(r.bytes(32)), nonce: r.u64(), nativeFee: r.u64(), lzTokenFee: r.u64(), amountSent: r.u64(), amountReceived: r.u64() };
}
export function decodeQuoteReturn(bytes) {
  if (bytes.length !== 16) throw new Error('unexpected quote return data');
  const r = new Reader(bytes);
  return { nativeFee: r.u64(), lzTokenFee: r.u64() };
}
export function returnDataOf(sim) {
  const [data, encoding] = sim.returnData?.data ?? [];
  if (sim.returnData?.programId !== PROGRAM.toBase58() || encoding !== 'base64') throw new Error('The Legacy Mesh program returned nothing.');
  return S.unb64(data);
}

// ---------- Tron → Solana ----------

// LayerZero executor options: type 3, then for lzReceive: worker 1, length 33, option 1, gas u128, value u128.
export function lzReceiveOption(gas, value) {
  const hex16 = (n) => BigInt(n).toString(16).padStart(32, '0');
  return '0x0003' + '01' + '0021' + '01' + hex16(gas) + hex16(value);
}
// A Solana recipient without a USDT account needs its rent sent along, for the executor to create it (LayerZero's Solana docs).
export const extraOptionsFor = (hasUsdtAccount) => (hasUsdtAccount ? '0x' : lzReceiveOption(0, S.TOKEN_ACCOUNT_RENT));

export function tronSendParam({ to, amount, extraOptions }) {
  return {
    dstEid: SOLANA_EID, to: '0x' + T.bytesToHex(new PublicKey(to).toBytes()), amountLD: amount, minAmountLD: received(amount),
    extraOptions, composeMsg: '0x', oftCmd: '0x',
  };
}

// ---------- tracking ----------

// The LayerZero message a source transaction sent, from LayerZero Scan; null until Scan has seen it. Tron hashes take a 0x prefix.
export async function scanMessage(hash, fetcher = fetch) {
  const res = await fetcher(`${SCAN}/messages/tx/${hash}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LayerZero Scan: HTTP ${res.status}`);
  const j = await res.json();
  return j.data?.[0] ?? null;
}

// What a Scan message says, for the page: { state: 'waiting' | 'verifying' | 'delivered' | 'problem', text, destTx }.
export function scanState(m) {
  if (!m) return { state: 'waiting', text: 'Waiting for LayerZero to see the transfer…' };
  const name = m.status?.name;
  const dvns = Object.values(m.verification?.dvn?.dvns ?? {});
  const done = dvns.filter((d) => d.status === 'SUCCEEDED').length;
  if (name === 'DELIVERED') return { state: 'delivered', text: 'Delivered.', destTx: m.destination?.tx?.txHash, guid: m.guid };
  if (['FAILED', 'BLOCKED', 'PAYLOAD_STORED', 'APPLICATION_BURNED', 'APPLICATION_SKIPPED', 'UNRESOLVABLE_COMMAND', 'MALFORMED_COMMAND'].includes(name)) {
    return { state: 'problem', text: `LayerZero reports ${name}${m.status?.message ? `: ${m.status.message}` : ''}.`, guid: m.guid };
  }
  return { state: 'verifying', text: `Verifying: ${done} of ${dvns.length || 2} verifiers have confirmed.`, guid: m.guid };
}
