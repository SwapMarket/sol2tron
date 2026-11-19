import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as O from 'oneclick';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
const fetchJson = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body });

const NOW = Date.parse('2026-11-19T16:40:00Z');
const user = 'B7MByhstU2DrXCmhhfBbAu8zCJycDBCFdz7DthEze8WX';
const req = O.request({ from: 'sol', amount: 1_000_000_000n, recipient: 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV', refundTo: user, dry: false, now: NOW });
// A live quote, as the dry mainnet response (test/fixtures/oneclick-dry.json) plus what a non-dry one adds.
const live = () => {
  const d = fixture('oneclick-dry.json');
  return {
    ...d,
    quoteRequest: { ...d.quoteRequest, ...req, dry: false, deadline: '2026-11-19T17:40:00.000Z' },
    quote: { ...d.quote, depositAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', deadline: '2026-11-19T17:40:00.000Z', timeWhenInactive: '2026-11-19T17:40:00.000Z' },
  };
};
const opts = { minOut: 993_000_000n, user, now: NOW };

test('the request asks for exactly the route and amount', () => {
  assert.equal(req.originAsset, O.ASSET.sol);
  assert.equal(req.destinationAsset, O.ASSET.tron);
  assert.equal(req.amount, '1000000000');
  assert.equal(req.slippageTolerance, 50);
  assert.equal(O.request({ from: 'tron', amount: 1n, recipient: user, refundTo: 'T', dry: true }).originAsset, O.ASSET.tron);
});

test('checkQuote accepts a quote that says what was asked', () => {
  assert.equal(O.checkQuote(live(), req, opts).depositAddress, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
});

test('checkQuote refuses every mismatch', () => {
  const cases = [
    ['recipient', (r) => { r.quoteRequest.recipient = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; }],
    ['refundTo', (r) => { r.quoteRequest.refundTo = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; }],
    ['originAsset', (r) => { r.quoteRequest.originAsset = O.ASSET.tron; }],
    ['destinationAsset', (r) => { r.quoteRequest.destinationAsset = 'nep141:sol.omft.near'; }],
    ['amount', (r) => { r.quoteRequest.amount = '999999999'; }],
    ['amount in', (r) => { r.quote.amountIn = '1000000001'; }],
    ['minimum out', (r) => { r.quote.minAmountOut = '992999999'; }],
    ['deposit address', (r) => { r.quote.depositAddress = 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV'; }],
    ['deposit address is not a wallet', (r) => { r.quote.depositAddress = 'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN'; }],
    ['deposit address is your own', (r) => { r.quote.depositAddress = user; }],
    ['deadline too near', (r) => { r.quote.deadline = '2026-11-19T16:55:00.000Z'; }],
    ['no signature', (r) => { delete r.signature; }],
    ['dry run', (r) => { r.quoteRequest.dry = true; }],
    ['memo', (r) => { r.quote.depositMemo = '123'; }],
    ['recipientType', (r) => { r.quoteRequest.recipientType = 'INTENTS'; }],
  ];
  for (const [what, mutate] of cases) {
    const r = live();
    mutate(r);
    assert.throws(() => O.checkQuote(r, req, opts), new RegExp(`\\(${what}\\)`), what);
  }
});

test('Tron origin: the deposit address must be a Tron address', () => {
  const treq = O.request({ from: 'tron', amount: 1_000_000_000n, recipient: user, refundTo: 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV', dry: false, now: NOW });
  const r = live();
  r.quoteRequest = { ...r.quoteRequest, ...treq, dry: false };
  assert.throws(() => O.checkQuote(r, treq, { ...opts, user: 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV' }), /deposit address/);
  r.quote.depositAddress = 'TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt';
  assert.ok(O.checkQuote(r, treq, { ...opts, user: 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV' }));
});

test('tokens(): checks both USDT entries and reads the SOL and TRX prices', async () => {
  const list = fixture('oneclick-tokens.json');
  const p = await O.tokens(fetchJson(list));
  assert.ok(p.SOL > 1 && p.TRX > 0.01);
  const wrong = structuredClone(list);
  wrong.find((t) => t.assetId === O.ASSET.tron).contractAddress = 'TLEWroJmY4mS7HsgKDT8SwsPRJqnefugEV';
  await assert.rejects(O.tokens(fetchJson(wrong)), /tron USDT is not the expected token/);
});

test('status states, including unknown ones', async () => {
  assert.equal(O.statusState(null).state, 'waiting');
  assert.equal(O.statusState({ status: 'PENDING_DEPOSIT' }).state, 'waiting');
  assert.equal(O.statusState({ status: 'PROCESSING' }).state, 'processing');
  const ok = O.statusState({ status: 'SUCCESS', swapDetails: { amountOut: '998398021', destinationChainTxHashes: [{ hash: 'abc' }] } });
  assert.deepEqual([ok.state, ok.destTx], ['delivered', 'abc']);
  assert.equal(O.statusState({ status: 'REFUNDED', swapDetails: { refundedAmount: '1000000' } }).state, 'refunded');
  assert.equal(O.statusState({ status: 'INCOMPLETE_DEPOSIT', swapDetails: {} }).state, 'problem');
  assert.equal(O.statusState({ status: 'FAILED' }).state, 'problem');
  assert.equal(O.statusState({ status: 'SOMETHING_NEW' }).state, 'processing');
  assert.equal(await O.status('x', fetchJson({ message: 'not found' }, 404)), null);
});
