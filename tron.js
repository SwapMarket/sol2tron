// Tron side of sol2tron: addresses, the node's HTTP API, and the check every transaction passes before a wallet is asked to sign.
// No TronWeb: a Tron node builds each transaction (/wallet/triggersmartcontract), and since the node isn't trusted, checkTx()
// decodes the protobuf bytes that get signed and compares every field with what the page asked for.
import { encodeFunctionData, decodeFunctionResult, parseAbi, sha256, recoverAddress, keccak256 } from 'viem';

export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const OFT = 'TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt'; // USDT0 Legacy Mesh UsdtOFT
export const ENDPOINT = 'TAy9xwjYjBBN6kutzrZJaAZJHCAejjK1V9'; // LayerZero EndpointV2
export const CHAIN_ID = '0x2b6653dc'; // mainnet: the last 4 bytes of the genesis block id
export const GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
export const SOLANA_EID = 30168;
export const TRIGGER_SMART_CONTRACT = 31;

// ---------- bytes and addresses ----------

export const hexToBytes = (h) => {
  h = h.replace(/^0x/, '');
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('bad hex');
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
const sha = (bytes) => hexToBytes(sha256(bytes));

// A Tron address: base58check of 0x41 ‖ 20 bytes. Returns the 21 bytes, or throws.
export function decodeAddress(a) {
  if (typeof a !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) throw new Error('Not a Tron address (T…, 34 characters).');
  const raw = base58Decode(a);
  if (raw.length !== 25) throw new Error('Not a Tron address.');
  const body = raw.slice(0, 21);
  if (!equalBytes(sha(sha(body)).slice(0, 4), raw.slice(21))) throw new Error('This Tron address has a typo (its checksum is wrong).');
  if (body[0] !== 0x41) throw new Error('Not a Tron mainnet address.');
  if (body.slice(1).every((b) => b === 0)) throw new Error('That is the zero address.');
  return body;
}
export function encodeAddress(bytes21) {
  if (bytes21.length !== 21 || bytes21[0] !== 0x41) throw new Error('bad Tron address bytes');
  return base58Encode(Uint8Array.from([...bytes21, ...sha(sha(bytes21)).slice(0, 4)]));
}
export const isAddress = (a) => { try { decodeAddress(a); return true; } catch { return false; } };
// The EVM-style 0x address (20 bytes) that ABI encoding uses, and back.
export const toEvm = (a) => '0x' + bytesToHex(decodeAddress(a).slice(1));
export const fromEvm = (h) => encodeAddress(Uint8Array.from([0x41, ...hexToBytes(h)]));

// ---------- ABIs ----------

export const TRC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const OFT_ABI = parseAbi([
  'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }',
  'struct OFTFeeDetail { int256 feeAmountLD; string description; }',
  'struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }',
  'function quoteOFT(SendParam _sendParam) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)',
  'function quoteSend(SendParam _sendParam, bool _payInLzToken) view returns (MessagingFee)',
  'function send(SendParam _sendParam, MessagingFee _fee, address _refundAddress) payable',
  'function feeBps() view returns (uint16)',
  'function token() view returns (address)',
  'function peers(uint32) view returns (bytes32)',
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
]);

// ---------- protobuf ----------

// Reads the fields of one protobuf message: { [field number]: [values] }, each a bigint (varint, fixed) or bytes (length-delimited).
export function readProto(bytes) {
  const fields = {};
  let i = 0;
  const varint = () => {
    let v = 0n, shift = 0n;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated protobuf');
      const b = bytes[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 63n) throw new Error('bad varint');
    }
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Number(key >> 3n), wire = Number(key & 7n);
    let value;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const len = Number(varint());
      if (i + len > bytes.length) throw new Error('truncated protobuf');
      value = bytes.slice(i, i + len);
      i += len;
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > bytes.length) throw new Error('truncated protobuf');
      value = bytes.slice(i, i + n).reduceRight((acc, b) => acc * 256n + BigInt(b), 0n);
      i += n;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    (fields[field] ??= []).push(value);
  }
  return fields;
}

const one = (f, n, what) => {
  const v = f[n];
  if (!v) return undefined;
  if (v.length !== 1) throw new Error(`the transaction has ${v.length} ${what}`);
  return v[0];
};
const utf8 = (b) => new TextDecoder().decode(b);

// Decodes Transaction.raw as a TriggerSmartContract call; throws on anything else.
export function decodeTrigger(rawHex) {
  const raw = readProto(hexToBytes(rawHex));
  const contracts = raw[11] ?? [];
  if (contracts.length !== 1) throw new Error(`the transaction has ${contracts.length} contracts, not 1`);
  for (const n of [9, 10, 12]) if (raw[n]) throw new Error(`the transaction carries unexpected field ${n}`);
  const c = readProto(contracts[0]);
  const type = Number(one(c, 1, 'types') ?? 0n);
  if (type !== TRIGGER_SMART_CONTRACT) throw new Error(`the transaction is of type ${type}, not a contract call`);
  if (c[3] || c[4]) throw new Error('the transaction carries an unexpected provider or contract name');
  const permission = Number(one(c, 5, 'permission ids') ?? 0n);
  const any = readProto(one(c, 2, 'parameters'));
  const typeUrl = utf8(one(any, 1, 'type urls'));
  if (typeUrl !== 'type.googleapis.com/protocol.TriggerSmartContract') throw new Error(`unexpected parameter type ${typeUrl}`);
  const t = readProto(one(any, 2, 'values'));
  if (t[5] || t[6]) throw new Error('the call sends a TRC-10 token');
  return {
    refBlockBytes: bytesToHex(one(raw, 1, 'ref blocks') ?? new Uint8Array()),
    refBlockHash: bytesToHex(one(raw, 4, 'ref block hashes') ?? new Uint8Array()),
    expiration: Number(one(raw, 8, 'expirations') ?? 0n),
    timestamp: Number(one(raw, 14, 'timestamps') ?? 0n),
    feeLimit: one(raw, 18, 'fee limits') ?? 0n,
    permission,
    owner: encodeAddress(one(t, 1, 'owners')),
    contract: encodeAddress(one(t, 2, 'contract addresses')),
    callValue: one(t, 3, 'call values') ?? 0n,
    data: '0x' + bytesToHex(one(t, 4, 'call data') ?? new Uint8Array()),
  };
}

// The check every transaction from a node passes before the wallet sees it. `want`: { owner, contract, data, callValue, maxFeeLimit,
// now (ms), refBlock?: { bytes, hash } (from the other node) }. Returns the decoded call; throws naming the field that differs.
export function checkTx(tx, want) {
  if (!tx?.raw_data_hex || !tx.txID || !tx.raw_data) throw new Error('The node returned no transaction.');
  const d = decodeTrigger(tx.raw_data_hex);
  const bad = (field) => { throw new Error(`The Tron node returned a different transaction than requested (${field}). Nothing was signed.`); };
  if (sha256(hexToBytes(tx.raw_data_hex)).slice(2) !== tx.txID.toLowerCase()) bad('transaction id');
  if (d.owner !== want.owner) bad('sender');
  if (d.contract !== want.contract) bad('contract');
  if (d.data.toLowerCase() !== want.data.toLowerCase()) bad('call data');
  if (d.callValue !== BigInt(want.callValue ?? 0n)) bad('TRX sent');
  if (d.feeLimit <= 0n || d.feeLimit > BigInt(want.maxFeeLimit)) bad('fee limit');
  if (d.permission !== 0) bad('permission');
  if (!(d.expiration > want.now && d.expiration <= want.now + 10 * 60_000)) bad('expiration');
  if (want.refBlock && (d.refBlockBytes !== want.refBlock.bytes || d.refBlockHash !== want.refBlock.hash)) bad('reference block');
  // What the wallet shows comes from the JSON: it must say the same as the bytes it signs.
  const j = tx.raw_data;
  const v = j.contract?.[0]?.parameter?.value ?? {};
  const addr = (a) => (a?.startsWith?.('T') ? a : a ? encodeAddress(hexToBytes(a)) : undefined);
  if (j.contract?.length !== 1 || j.contract[0].type !== 'TriggerSmartContract') bad('displayed type');
  if (addr(v.owner_address) !== d.owner || addr(v.contract_address) !== d.contract) bad('displayed addresses');
  if (('0x' + (v.data ?? '')).toLowerCase() !== d.data.toLowerCase()) bad('displayed call data');
  if (BigInt(v.call_value ?? 0) !== d.callValue || BigInt(j.fee_limit ?? 0) !== d.feeLimit || Number(j.expiration) !== d.expiration) bad('displayed amounts');
  return d;
}

// The block a transaction's ref_block fields name: bytes 6..8 of the number and bytes 8..16 of the id.
export function refBlockOf(block) {
  const num = BigInt(block.block_header.raw_data.number);
  return { bytes: (num & 0xffffn).toString(16).padStart(4, '0'), hash: block.blockID.slice(16, 32) };
}

// A signed transaction's signer must be `owner`: recovers the key from the 65-byte signature over the transaction id.
export async function checkSignature(tx, owner) {
  const sig = tx.signature?.[0];
  if (!sig || tx.signature.length !== 1 || !/^[0-9a-f]{130}$/i.test(sig)) throw new Error('The wallet returned no valid signature.');
  const evm = await recoverAddress({ hash: '0x' + tx.txID, signature: '0x' + sig });
  if (fromEvm(evm) !== owner) throw new Error('The wallet signed with another account than the one connected.');
}

// keccak of a public key → address; exported for tests.
export const addressOfPublicKey = (pub65) => fromEvm('0x' + keccak256(pub65.slice(1)).slice(-40));

// ---------- the node ----------

// Full-node HTTP API endpoints that answer browsers (CORS checked). TronGrid allows 3 requests a second without a key, so calls to
// it are spaced; publicnode has no /v1 indexer, so events come from TronGrid.
export const NODES = ['https://tron-rpc.publicnode.com', 'https://api.trongrid.io'];
const TRONGRID = 'https://api.trongrid.io';
let gridNext = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function paced(url) {
  if (!url.startsWith(TRONGRID)) return;
  const now = Date.now();
  const at = Math.max(now, gridNext);
  gridNext = at + 400;
  if (at > now) await sleep(at - now);
}

export async function post(node, path, body, fetcher = fetch) {
  const url = node + path;
  await paced(url);
  const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Tron node ${new URL(node).host}: HTTP ${res.status}`);
  const j = await res.json();
  if (j?.Error) throw new Error(`Tron node ${new URL(node).host}: ${j.Error}`);
  return j;
}
export async function get(url, fetcher = fetch) {
  await paced(url);
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// A client over the nodes: the first that answers is used; each must be on mainnet (its genesis block checked once).
export function client(nodes = NODES, fetcher = fetch) {
  const checked = new Map();
  const onMainnet = async (node) => {
    if (!checked.has(node)) {
      checked.set(node, post(node, '/wallet/getblockbynum', { num: 0 }, fetcher).then((b) => {
        if (b.blockID !== GENESIS) throw new Error(`${new URL(node).host} is not a Tron mainnet node`);
      }));
      checked.get(node).catch(() => checked.delete(node));
    }
    return checked.get(node);
  };
  const call = async (path, body, { except } = {}) => {
    let last;
    for (const node of nodes) {
      if (node === except) continue;
      try {
        await onMainnet(node);
        return { node, result: await post(node, path, body, fetcher) };
      } catch (e) { last = e; }
    }
    throw last;
  };
  const view = async (contract, abi, functionName, args = [], from = OFT) => {
    const data = encodeFunctionData({ abi, functionName, args });
    const { result: r } = await call('/wallet/triggerconstantcontract', { owner_address: from, contract_address: contract, data: data.slice(2), visible: true });
    if (r.result?.result !== true || !r.constant_result?.[0]) {
      throw new Error(`${functionName} reverted: ${r.result?.message ? utf8(hexToBytes(r.result.message)) : JSON.stringify(r.result)}`);
    }
    return { value: decodeFunctionResult({ abi, functionName, data: '0x' + r.constant_result[0] }), energy: BigInt(r.energy_used ?? 0) };
  };
  return {
    call,
    view,
    // Energy a call would use from `owner`, with `callValue` sun attached.
    async estimateEnergy(owner, contract, data, callValue = 0n) {
      const { result: r } = await call('/wallet/triggerconstantcontract', { owner_address: owner, contract_address: contract, data: data.slice(2), call_value: Number(callValue), visible: true });
      if (r.result?.result !== true) throw new Error(`The call would fail: ${r.result?.message ? utf8(hexToBytes(r.result.message)) : JSON.stringify(r.result)}`);
      // energy_used already includes the dynamic-energy penalty (energy_penalty is the part of it that is penalty): an approve
      // estimated 99,764 with a penalty of 77,076, and mainnet charged energy_usage_total 99,764.
      return BigInt(r.energy_used ?? 0);
    },
    async account(address) {
      const { result: a } = await call('/wallet/getaccount', { address, visible: true });
      return a;
    },
    async resources(address) {
      const { result: r } = await call('/wallet/getaccountresource', { address, visible: true });
      return r;
    },
    async prices() {
      const { result: { chainParameter } } = await call('/wallet/getchainparameters', {});
      const p = Object.fromEntries(chainParameter.map(({ key, value }) => [key, BigInt(value ?? 0)]));
      return { energy: p.getEnergyFee, bandwidth: p.getTransactionFee }; // sun per unit
    },
    // An unsigned call built by one node, checked (with the reference block read from the other node, when there is one).
    async build({ owner, contract, data, callValue = 0n, feeLimit, now = Date.now() }) {
      const { node, result } = await call('/wallet/triggersmartcontract', {
        owner_address: owner, contract_address: contract, data: data.slice(2), call_value: Number(callValue), fee_limit: Number(feeLimit), visible: true,
      });
      if (result.result?.result !== true) throw new Error(`The Tron node refused to build the call: ${result.result?.message ? utf8(hexToBytes(result.result.message)) : JSON.stringify(result.result)}`);
      const tx = result.transaction;
      const d = decodeTrigger(tx.raw_data_hex);
      let refBlock;
      if (nodes.length > 1) {
        const num = await call('/wallet/getnowblock', {}, { except: node }).then(({ result: b }) => BigInt(b.block_header.raw_data.number));
        // The reference block is a recent one: find the block with those low 16 bits within the last 65536.
        let n = (num & ~0xffffn) | BigInt(parseInt(d.refBlockBytes, 16));
        if (n > num) n -= 0x10000n;
        const { result: b } = await call('/wallet/getblockbynum', { num: Number(n) }, { except: node });
        refBlock = refBlockOf(b);
      }
      checkTx(tx, { owner, contract, data, callValue, maxFeeLimit: feeLimit, now, refBlock });
      return tx;
    },
    async broadcast(signed) {
      const results = await Promise.allSettled(nodes.map((node) => post(node, '/wallet/broadcasttransaction', signed, fetcher)));
      const ok = results.find((r) => r.status === 'fulfilled' && (r.value.result === true || /DUP_TRANSACTION/.test(r.value.code ?? '')));
      if (ok) return signed.txID;
      const r = results.find((x) => x.status === 'fulfilled')?.value;
      throw new Error(`Tron refused the transaction: ${r?.message ? utf8(hexToBytes(r.message)) : r?.code ?? results[0].reason?.message}`);
    },
    async info(txid) {
      const { result } = await call('/wallet/gettransactioninfobyid', { value: txid });
      return result?.id ? result : null;
    },
  };
}

// Logs from a transaction's info: { address (base58), topics, data }.
export const logsOf = (info) => (info?.log ?? []).map((l) => ({ address: fromEvm('0x' + l.address), topics: l.topics.map((t) => '0x' + t), data: '0x' + (l.data ?? '') }));

// ---------- fees ----------

// TRX (sun) a call burns, given the account's free energy and bandwidth. Bandwidth is all-or-nothing: without enough for the whole
// transaction, all of its bytes are paid for.
export function burnFor({ energy, bytes }, { freeEnergy, freeBandwidth }, prices) {
  const energySun = (energy > freeEnergy ? energy - freeEnergy : 0n) * prices.energy;
  const bandwidthSun = bytes > freeBandwidth ? bytes * prices.bandwidth : 0n;
  return { energySun, bandwidthSun, total: energySun + bandwidthSun };
}

// Bandwidth a signed transaction uses: its protobuf size (raw data and one 65-byte signature) plus the 64 bytes Tron adds for the
// result (MAX_RESULT_SIZE_IN_TX).
export function txBytes(tx) {
  const raw = BigInt(tx.raw_data_hex.length / 2);
  const varintLen = (n) => { let l = 1n; while (n >= 128n) { n >>= 7n; l++; } return l; };
  return 1n + varintLen(raw) + raw + 1n + 1n + 65n + 64n;
}

// Free energy and bandwidth left today, from /wallet/getaccountresource.
export function available(r) {
  const n = (k) => BigInt(r?.[k] ?? 0);
  const staked = n('NetLimit') - n('NetUsed');
  const free = n('freeNetLimit') - n('freeNetUsed');
  return {
    freeEnergy: n('EnergyLimit') - n('EnergyUsed') > 0n ? n('EnergyLimit') - n('EnergyUsed') : 0n,
    freeBandwidth: (staked > free ? staked : free) > 0n ? (staked > free ? staked : free) : 0n,
  };
}
