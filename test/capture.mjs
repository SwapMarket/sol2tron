// Saves the mainnet state the tests replay: every Solana account the Legacy Mesh route reads, and a mainnet send to Tron.
// Run by hand (node --import ./test/register.js test/capture.mjs); the tests never touch the network.
import { writeFileSync } from 'node:fs';
import * as S from 'solana';
import * as M from 'mesh';

const rpc = S.rpcClient();
const accounts = {};
const fetchAccounts = async (keys) => {
  const { value } = await rpc('getMultipleAccounts', [keys.map(String), { encoding: 'base64' }]);
  value.forEach((a, i) => { accounts[keys[i].toBase58()] = a; });
  return value.map((a) => (a ? { owner: a.owner, data: S.unb64(a.data[0]) } : null));
};
await M.loadRoute(fetchAccounts);
const SEND = process.argv[2] ?? '5HRRJhafCUUsqZDxnY89GMeX6YQuBoBQREM3MikgBYYfNpkw5CRLaYU1QvBCFD6nuKDgj5W1uFbgySt1w3jFmcRf';
const tx = await S.getTx(rpc, SEND);
const url = (f) => new URL(`fixtures/${f}`, import.meta.url);
writeFileSync(url('solana-accounts.json'), JSON.stringify(accounts, null, 1) + '\n');
writeFileSync(url('solana-send.json'), JSON.stringify({ signature: SEND, ...tx }, null, 1) + '\n');
console.log(Object.keys(accounts).length, 'accounts; send', SEND);
