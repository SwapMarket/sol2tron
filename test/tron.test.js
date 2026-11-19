import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, sha256 } from 'viem';
import * as T from '../tron.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const send = fixture('tron-send.json'); // mainnet 93280e90…: UsdtOFT.send to Solana
const approve = fixture('tron-approve.json'); // mainnet 8ce0ac57…: USDT.approve(UsdtOFT, …)

test('addresses: base58check both ways, and refusals', () => {
  assert.equal(T.toEvm(T.USDT), '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
  assert.equal(T.toEvm(T.OFT), '0x3a08f76772e200653bb55c2a92998daca62e0e97');
  assert.equal(T.fromEvm('0x3a08f76772e200653bb55c2a92998daca62e0e97'), T.OFT);
  assert.ok(T.isAddress('TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV'));
  // One character changed: the checksum catches it.
  assert.throws(() => T.decodeAddress('TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEW'), /checksum/);
  assert.throws(() => T.decodeAddress('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'), /Not a Tron address/);
  assert.throws(() => T.decodeAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'), /zero address/);
  // Valid base58check but another prefix (0xa0, Tron's old testnet).
  const other = T.base58Encode(Uint8Array.from([0xa0, ...new Uint8Array(19), 1, ...T.hexToBytes(sha256(sha256(Uint8Array.from([0xa0, ...new Uint8Array(19), 1]))).slice(2, 10))]));
  assert.throws(() => T.decodeAddress(other));
});

test('decodes the mainnet send and approve exactly as the node reported them', () => {
  for (const tx of [send, approve]) {
    const d = T.decodeTrigger(tx.raw_data_hex);
    const v = tx.raw_data.contract[0].parameter.value;
    assert.equal(T.toEvm(d.owner).slice(2), v.owner_address.slice(2));
    assert.equal(T.toEvm(d.contract).slice(2), v.contract_address.slice(2));
    assert.equal(d.data.slice(2), v.data);
    assert.equal(d.callValue, BigInt(v.call_value ?? 0));
    assert.equal(d.feeLimit, BigInt(tx.raw_data.fee_limit));
    assert.equal(d.expiration, tx.raw_data.expiration);
    assert.equal(d.refBlockBytes, tx.raw_data.ref_block_bytes);
    assert.equal(d.refBlockHash, tx.raw_data.ref_block_hash);
  }
});

// The send fixture, as checkTx expects to see it.
const owner = T.fromEvm('0x' + send.raw_data.contract[0].parameter.value.owner_address.slice(2));
const want = (over = {}) => ({
  owner, contract: T.OFT, data: '0x' + send.raw_data.contract[0].parameter.value.data,
  callValue: BigInt(send.raw_data.contract[0].parameter.value.call_value), maxFeeLimit: 100_000_000n,
  now: send.raw_data.expiration - 60_000, refBlock: { bytes: send.raw_data.ref_block_bytes, hash: send.raw_data.ref_block_hash }, ...over,
});

test('checkTx accepts the mainnet send', () => {
  const d = T.checkTx(send, want());
  assert.equal(d.contract, T.OFT);
});

test('checkTx refuses each field the page did not ask for', () => {
  const cases = {
    'sender': { owner: 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV' },
    'contract': { contract: T.USDT },
    'call data': { data: want().data.replace(/.$/, (c) => (c === '0' ? '1' : '0')) },
    'TRX sent': { callValue: want().callValue - 1n },
    'fee limit': { maxFeeLimit: 99_999_999n },
    'expiration': { now: send.raw_data.expiration },
    'reference block': { refBlock: { bytes: '0000', hash: send.raw_data.ref_block_hash } },
  };
  for (const [field, over] of Object.entries(cases)) {
    assert.throws(() => T.checkTx(send, want(over)), new RegExp(`\\(${field}\\)`), field);
  }
  // Expires too far ahead (a transaction the node could hold back and broadcast much later).
  assert.throws(() => T.checkTx(send, want({ now: send.raw_data.expiration - 11 * 60_000 })), /expiration/);
});

// Re-encode a TriggerSmartContract transaction with one field changed, as a malicious node would.
const enc = {
  varint(n) { n = BigInt(n); const out = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); return out; },
  field(num, wire, payload) { return [...enc.varint((num << 3) | wire), ...(wire === 2 ? [...enc.varint(payload.length), ...payload] : enc.varint(payload))]; },
};
function forge({ callValue, contracts = 1, extra = [] }) {
  const d = T.decodeTrigger(send.raw_data_hex);
  const trigger = [
    ...enc.field(1, 2, T.decodeAddress(d.owner)), ...enc.field(2, 2, T.decodeAddress(d.contract)),
    ...(callValue ?? d.callValue ? enc.field(3, 0, callValue ?? d.callValue) : []), ...enc.field(4, 2, T.hexToBytes(d.data)),
  ];
  const any = [...enc.field(1, 2, [...new TextEncoder().encode('type.googleapis.com/protocol.TriggerSmartContract')]), ...enc.field(2, 2, trigger)];
  const contract = [...enc.field(1, 0, 31), ...enc.field(2, 2, any)];
  const raw = [
    ...enc.field(1, 2, T.hexToBytes(d.refBlockBytes)), ...enc.field(4, 2, T.hexToBytes(d.refBlockHash)), ...enc.field(8, 0, d.expiration),
    ...Array.from({ length: contracts }, () => enc.field(11, 2, contract)).flat(), ...extra, ...enc.field(14, 0, d.timestamp), ...enc.field(18, 0, d.feeLimit),
  ];
  const hex = T.bytesToHex(Uint8Array.from(raw));
  return { ...send, raw_data_hex: hex, txID: sha256(Uint8Array.from(raw)).slice(2) };
}

test('the forger reproduces the mainnet bytes (so the forged cases below are faithful)', () => {
  assert.equal(forge({}).raw_data_hex, send.raw_data_hex);
});

test('checkTx refuses forged bytes: more TRX, two contracts, extra data, wrong id, a display that disagrees', () => {
  assert.throws(() => T.checkTx(forge({ callValue: want().callValue + 1n }), want()), /TRX sent/);
  assert.throws(() => T.checkTx(forge({ contracts: 2 }), want()), /2 contracts/);
  assert.throws(() => T.checkTx(forge({ extra: enc.field(10, 2, [1, 2, 3]) }), want()), /unexpected field 10/);
  assert.throws(() => T.checkTx({ ...send, txID: '00' + send.txID.slice(2) }, want()), /transaction id/);
  // Bytes say one thing, the JSON the wallet displays says another.
  const shown = structuredClone(send);
  shown.raw_data.contract[0].parameter.value.call_value = 1;
  assert.throws(() => T.checkTx(shown, want()), /displayed amounts/);
  const shown2 = structuredClone(send);
  shown2.raw_data.contract[0].parameter.value.contract_address = '41' + T.toEvm(T.USDT).slice(2);
  assert.throws(() => T.checkTx(shown2, want()), /displayed addresses/);
});

test('the mainnet send is OFT.send to Solana with the rent value in its options', () => {
  const { functionName, args } = decodeFunctionData({ abi: T.OFT_ABI, data: T.decodeTrigger(send.raw_data_hex).data });
  assert.equal(functionName, 'send');
  assert.equal(args[0].dstEid, T.SOLANA_EID);
  assert.equal(args[0].extraOptions, '0x00030100210100000000000000000000000000000000000000000000000000000000001f1df0');
  // Encoding the same arguments gives the same bytes.
  assert.equal(encodeFunctionData({ abi: T.OFT_ABI, functionName: 'send', args }), T.decodeTrigger(send.raw_data_hex).data);
});

test('signature: the mainnet signer is recovered, another account refused', async () => {
  await T.checkSignature(send, owner);
  await assert.rejects(T.checkSignature(send, 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV'), /another account/);
  await assert.rejects(T.checkSignature({ ...send, signature: [] }, owner), /no valid signature/);
});

test('the OFTSent log of the mainnet send decodes', () => {
  const info = fixture('tron-send-info.json');
  const logs = T.logsOf(info).filter((l) => l.address === T.OFT);
  assert.ok(logs.length >= 1);
});

test('fees: TRX burned for energy and bandwidth, measured against mainnet', () => {
  const info = fixture('tron-send-info.json');
  // This sender had 131,102 energy of its own; 95,358 more was burned at 100 sun (9.5358 TRX), and 800 bytes of bandwidth at 1000 sun.
  const r = T.burnFor({ energy: 226_460n, bytes: 800n }, { freeEnergy: 131_102n, freeBandwidth: 600n }, { energy: 100n, bandwidth: 1000n });
  assert.equal(r.energySun, BigInt(info.receipt.energy_fee));
  assert.equal(r.bandwidthSun, BigInt(info.receipt.net_fee));
});

test('a transaction of the send size is 800 bytes of bandwidth, as charged', () => {
  assert.equal(T.txBytes(send), 800n);
  assert.equal(T.txBytes(approve), 345n);
});

test('available(): staked and free bandwidth, energy', () => {
  assert.deepEqual(T.available({ freeNetLimit: 600, freeNetUsed: 100, EnergyLimit: 50, EnergyUsed: 60 }), { freeEnergy: 0n, freeBandwidth: 500n });
  assert.deepEqual(T.available({}), { freeEnergy: 0n, freeBandwidth: 0n });
});

test('refBlockOf: the low 16 bits of the number and bytes 8..16 of the id', () => {
  assert.deepEqual(T.refBlockOf({ blockID: '0000000005463ef22a1b2c3d4e5f60718293a4b5c6d7e8f9', block_header: { raw_data: { number: 88489714 } } }),
    { bytes: '3ef2', hash: '2a1b2c3d4e5f6071' });
});
