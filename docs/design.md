# sol2tron: Phase 1 design

Written 2026-11-19, after the research in `docs/assumptions.md`. **The user chose option 3: both routes.** The page quotes Tether's
Legacy Mesh and NEAR Intents 1Click side by side, for both directions, and the user picks one per transfer.

This document is for review. No page code is written until the user approves it.

## 0. Decisions for the user

Each has a recommendation; nothing below depends on more than these.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | 1Click API key | (a) **No key.** The docs say unauthenticated quotes pay an extra 0.25% platform fee ([authentication](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md)). The quotes measured in Phase 0 were made this way and were still the cheapest. (b) **A partner key from partners.near-intents.org.** It gives about 0.01–0.20%, but a static page cannot hide it: anyone can copy it and use SwapMarket's partner account. | (a) No key. Nothing secret in the page. Revisit if SwapMarket gets a key meant for public use. |
| D2 | Tron allowance for the Legacy Mesh | (a) **Exact amount** each time: about 100k energy, about 10 TRX for a sender with no energy, on every transfer. (b) **Unlimited**, once: cheaper afterwards, but the OFT contract can move all the wallet's USDT for as long as the allowance stands. | (a) Exact amount, as sol2base does for Base. Show the approval's TRX cost separately. Whether Tron USDT needs the allowance reset to 0 first is **UNVERIFIED**: the page reads the current allowance, and tests cover both cases. |
| D3 | 1Click "send from another wallet" (an exchange or a GasFree wallet) | (a) **Only from the connected wallet.** (b) **Also show the deposit address, amount and deadline** for a manual send, with the refund address still the user's own. | (b) for Tron → Solana only, because it is the only way for a sender with no TRX to use the page. The page shows the exact amount and the deadline in large type, and warns that a different amount is refunded, minus a fee. |
| D4 | Which route is pre-selected | (a) **The one that leaves the user more** after every fee, valued in USD. (b) **Always the Legacy Mesh.** | (a), with each route's trust line always visible next to its numbers (§4). |
| D5 | 1Click slippage | A fixed `slippageTolerance`, or a user setting | Fixed at 50 bps (0.5%) for this USDT → USDT route, as sol2base fixes Aerodrome's. The page refuses any quote whose `minAmountOut` is below what it showed. |

## 1. The page in one paragraph

The user picks a direction (Solana → Tron or Tron → Solana), an amount, and a recipient: by default the connected wallet on the
other chain, or any address entered. The page shows two quotes:

- **Legacy Mesh:** what arrives, plus the separate fee in SOL or TRX.
- **1Click:** what arrives, plus the network fee.

The user picks one and signs. The page then tracks the transfer until it arrives, checks the arrival on the destination chain
itself, and remembers it in the browser so it can be resumed after a reload.

## 2. Files and libraries

Same shape as sol2base:

| File | Contents |
|---|---|
| `index.html`, `style.css` | Page and menu (copied from sol2base, with sol2tron added and in yellow) |
| `app.js` | Form, quotes, steps, status, localStorage, resume |
| `solana.js` | Solana RPC, wallet connection (Wallet Standard, injected, WalletConnect), SPL transfer, Legacy Mesh `quote_send` / `send`, and the LayerZero account resolution ported from Tether's WDK (Apache-2.0, notice kept) |
| `tron.js` | Tron node calls, TronLink and WalletConnect Tron, base58check, ABI calls (viem), **the protobuf reader that checks every transaction before signing**, broadcast and confirmation |
| `oneclick.js` | 1Click quote, quote checks, deposit submit, status |
| `lz.js` | LayerZero Scan polling, options encoding |
| `sw.js` | Service worker for notifications (as sol2base) |

- **Libraries** (bundled into `vendor/`, pinned by `package-lock.json`):
  - `viem` (ABI encoding, sha256);
  - `@solana/web3.js`;
  - `@walletconnect/sign-client` and `@walletconnect/modal`.
- **No TronWeb.** Transactions are built by a Tron node (`/wallet/triggersmartcontract`) and checked byte by byte in `tron.js`
  before the wallet sees them. TronLink signs them with `tronWeb.trx.sign`; WalletConnect wallets with `tron_signTransaction`.
- **Endpoints:**
  - Solana: publicnode, then api.mainnet-beta.solana.com, as sol2base.
  - Tron node: `tron-rpc.publicnode.com`, with `api.trongrid.io` as the second (kept under 3 requests/s).
  - Tron events: TronGrid `/v1`.
  - Status: `scan.layerzero-api.com` and `1click.chaindefuser.com`.

  All allow CORS (checked in Phase 0).

## 3. Wallets

- **Solana:** as sol2base: Wallet Standard, the older injected objects, or WalletConnect (`solana_signTransaction`).
- **Tron:**
  - **TronLink** and compatible extensions:
    - Discovery by TIP-6963, then `window.tron`, then `window.tronLink`.
    - Connect with `eth_requestAccounts`.
    - Sign with `provider.tronWeb.trx.sign(tx)`.
    - Listen to `accountsChanged` and `chainChanged`.
  - **WalletConnect** with the `tron` namespace:
    - Methods `tron_signTransaction` (required) and `tron_signMessage` (unused).
    - Chain `tron:0x2b6653dc`. This is the mainnet id: TronLink reports `0x2b6653dc`, which is also the last 4 bytes of the mainnet
      genesis block id `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc`.
    - It handles both transaction formats (`tron_method_version: "v1"` flat, otherwise nested).
- **One QR for both chains:** the WalletConnect proposal asks for `solana` (required for Solana → Tron) and `tron` (optional), or
  the reverse for Tron → Solana. A wallet holding both, such as Trust Wallet (**UNVERIFIED** until tested), connects both sides at
  once.
- **Network checks:**
  - Refuse to sign when TronLink's chain id is not `0x2b6653dc`, with the message "Switch TronLink to TRON Mainnet."
  - Read block 0 from each Tron node once and refuse a node whose genesis differs.
  - The Solana side checks the genesis hash as sol2base does.
- Phantom and MetaMask are not listed for Tron until tested (assumptions §5.1).

## 4. Choosing the route

For the amount entered, the page shows:

| | Legacy Mesh (Tether's network) | NEAR Intents (1Click) |
|---|---|---|
| Arrives | `amount − 0.03%` (exact) | `amountOut`, at least `minAmountOut` |
| You also pay | Solana: LayerZero fee in SOL + network fee. Tron: LayerZero fee + energy + bandwidth in TRX (+ approval) | Solana: network fee (+ token-account rent for the deposit address if missing). Tron: energy + bandwidth for one USDT transfer |
| Time | ~1–2 min | ~1–2 min (quoted) |
| Trust | "Tether's own bridge. The contracts enforce the amount; LayerZero Labs and USDT0 must both confirm." | "A solver network. You send to a one-time deposit address; if the swap isn't filled by the deadline, it is refunded to you." |

- Fees paid in SOL or TRX are converted to USD with a price, so the two routes can be compared. Prices come from the 1Click
  `/v0/tokens` list, which carries SOL and TRX prices (**UNVERIFIED**: to check that it lists both). The conversion is shown,
  never used in any amount the user signs.
- A route that cannot be used is greyed out with the reason:
  - below 1Click's minimum ("minimum swap amount is $100" for Tron origin);
  - above the Legacy Mesh's credits limit;
  - not enough SOL or TRX.

## 5. Solana → Tron

### 5.1 Legacy Mesh

**Before showing the quote**

1. Check the Tron recipient: base58check, prefix `0x41`, not all zeros. If `getcontract` says it is a contract, warn ("this is a
   contract; make sure it can receive USDT"), but allow it, since exchanges use contracts.
2. Read the OFT store, the Tron peer config and `Credits`.
   - Refuse unless the store's mint is USDT, its `fee_bps` is what the page uses (3; if it changes, the page shows the new value
     and recomputes), and the peer is `TFG4wB…LPt`.
   - Refuse if `amount × 0.9997 > credits[30420]`.
3. Simulate `quote_send` with the resolved endpoint accounts (`sigVerify: false`, `replaceRecentBlockhash: true`, payer = the
   user) and read `MessagingFee.nativeFee` from the return data.
4. Read the user's USDT and SOL. SOL needed = `nativeFee` + transaction fee + priority fee. Refuse if short, saying how much SOL
   is missing.

**Signing (one transaction)**

5. Re-quote `nativeFee`. If it rose by more than 10% since the user saw it, show the new fee and wait for a second click.
6. Build the transaction:
   - ComputeBudget limit (about 350k, from the 276k–301k measured) and priority fee (as sol2base);
   - `send` with `amount_ld = amount`, `min_amount_ld = amount − floor(amount × fee_bps / 10000)` (the exact amount; nothing else
     can be deducted), `extra_options = []`, `compose_msg = None`, `native_fee = quoted × 1.05` (a ceiling; the endpoint charges
     the actual fee, assumptions §2.2), `lz_token_fee = 0`;
   - `to` = 12 zero bytes ‖ the 20-byte Tron address.
7. Simulate it. Refuse to sign unless:
   - it succeeds;
   - the user's USDT account falls by exactly `amount`;
   - the user's SOL falls by no more than `native_fee` + fees;
   - the return data's `OFTReceipt.amount_received_ld` is the amount shown.
8. The wallet signs. The page sends and re-sends until confirmed or expired (sol2base's `sendWatched`), and saves the pending
   transfer (§8) the moment it has a signature.

**After**

9. Poll LayerZero Scan `/v1/messages/tx/<sig>` until `DELIVERED`.
10. Check the arrival on Tron itself: `gettransactioninfobyid(destination tx)` must succeed and carry the Tron OFT's `OFTReceived`
    log with this `guid`, `toAddress` = the recipient, and `amountReceivedLD` = the amount shown. Then show it as arrived, with
    a Tronscan link.

### 5.2 1Click

**Before showing the quote**

1. `POST /v0/quote` with `dry: true` and `EXACT_INPUT`:
   - origin `nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near`, destination
     `nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near` (both checked against `/v0/tokens`: their
     `contractAddress` must be the two USDT addresses);
   - `slippageTolerance: 50`, `refundTo` = the Solana wallet.

**Signing**

2. On the user's click, request the real quote (`dry: false`, deadline now + 30 min). Refuse it unless:
   - `quoteRequest` echoes exactly the assets, amount, recipient, `refundTo`, `recipientType: DESTINATION_CHAIN` and
     `refundType: ORIGIN_CHAIN` that were sent;
   - `quote.amountIn` = the amount;
   - `minAmountOut` ≥ the minimum shown;
   - `depositAddress` is a valid Solana public key and is not the user's own;
   - the deadline is at least 20 minutes away.
3. Save the whole response, including `signature` (which the API says to keep for disputes), in localStorage **before**
   signing (§8).
4. Build an SPL `transferChecked` of exactly `amountIn` USDT from the user's USDT account to the deposit address's USDT account.
   Create that account with `createAssociatedTokenAccountIdempotent` first if it doesn't exist (the user pays about 0.002 SOL; the
   page shows this).
5. Simulate. Refuse unless the user's USDT falls by exactly `amountIn` and the deposit account rises by the same.
6. Sign, send, confirm. Then `POST /v0/deposit/submit {txHash, depositAddress}`.

**After**

7. Poll `GET /v0/status?depositAddress=…`:
   - `PENDING_DEPOSIT` and `PROCESSING`: waiting.
   - `INCOMPLETE_DEPOSIT`: shows the shortfall.
   - `SUCCESS`: takes `swapDetails.destinationChainTxHashes`.
   - `REFUNDED`: shows `refundedAmount`, `refundReason`, and the refund transaction.
   - `FAILED`: shows the saved quote and its signature, and how to contact NEAR Intents support.
8. On `SUCCESS`, check on Tron that the destination transaction carries a USDT `Transfer` log to the recipient for at least
   `minAmountOut`.

## 6. Tron → Solana

### 6.1 Checking a Tron transaction before signing (both routes)

Every Tron transaction is built by a node with `/wallet/triggersmartcontract`. The node is not trusted, so `tron.js` decodes
`raw_data_hex` itself (protobuf: `Transaction.raw` → one `Contract` of type `TriggerSmartContract`) and refuses to ask for a
signature unless:

- there is exactly one contract, of type 31 (`TriggerSmartContract`);
- `owner_address` = the connected Tron account;
- `contract_address` = the expected contract (USDT for `approve` and `transfer`, the OFT for `send`);
- `data` = the calldata the page encoded itself with viem, byte for byte;
- `call_value` = the expected TRX: `nativeFee` for `send`, 0 otherwise;
- `fee_limit` ≤ the cap the page computed (energy estimate × 1.3 × energy price, at most 150 TRX);
- the expiration is in the future and less than 10 minutes away;
- `ref_block_bytes` / `ref_block_hash` match a recent block read from the *other* Tron node;
- `txID` = sha256(`raw_data_hex`), and the JSON `raw_data` the wallet will display agrees with the decoded bytes.

After signing, the signature is checked against the account (secp256k1 recovery, using viem) before broadcast. The page
broadcasts to both nodes and confirms with `gettransactioninfobyid` (`receipt.result = SUCCESS`).

### 6.2 What the page tells a Tron sender about TRX

Before any button is enabled, the page shows the TRX this transfer will cost. It reads `getaccountresource` (free and staked
energy, and bandwidth) and estimates each call's energy with `triggerconstantcontract`, then prints:

> You need about **29.4 TRX** (you have 12.0): 5.98 TRX LayerZero fee, 22.6 TRX for energy (226,460 energy at 100 sun; you have
> none staked), 0.8 TRX bandwidth. Get TRX: buy it on an exchange and withdraw to this address, or rent energy to cut the energy
> part. 1Click needs only the transfer: about 13.4 TRX here.

The numbers above are the measured mainnet values; the page always computes them live. The help text explains energy,
bandwidth and the daily free 600 bandwidth in two sentences, and why a Tron sender can't pay these fees in USDT on the mesh.

### 6.3 Legacy Mesh

**Before showing the quote**

1. Check the Solana recipient: a valid key that is not owned by the token program and not a program (refuse token accounts, as
   sol2base does). Read its USDT account (ATA). If it doesn't exist, `extraOptions` = `lzReceive {gas 0, value 2039280}`, encoded
   `0x0003 01 0021 01 <16-byte gas 0> <16-byte value>`. Otherwise `0x`.
2. Read `quoteOFT(sendParam)`: check `maxAmountLD ≥ amount` and `amountReceivedLD` = `amount − floor(amount × feeBps / 10000)`.
   Read `quoteSend(sendParam, false).nativeFee`. Read USDT balance, TRX balance, and `allowance(user, OFT)`.
3. Show the TRX needed (§6.2), including the approval if the allowance is short.

**Signing (one or two transactions)**

4. If the allowance < amount, the user approves exactly `amount` (D2). If Tron USDT refuses to change a non-zero allowance, the
   page first sets it to 0. Each transaction is checked as in §6.1, signed, broadcast and confirmed.
5. Re-quote `nativeFee`; ask again if it rose more than 10%. Build `send` with:
   - `to` = the 32-byte Solana key;
   - `minAmountLD` = the exact amount after the fee;
   - `refundAddress` = the user;
   - `call_value` = `nativeFee`.

   Check it, sign, broadcast, confirm. Save the pending transfer as soon as the txid is known.
6. Read the `OFTSent` log from the transaction info. Its `guid` and `amountReceivedLD` must match.

**After**

7. Poll LayerZero Scan with `0x<txid>` until `DELIVERED`.
8. Check on Solana that the destination transaction raised the recipient's USDT account by `amountReceivedLD`.

### 6.4 1Click

- Same as §5.2 with origin and destination swapped, `refundTo` = the Tron wallet, and the deposit a USDT `transfer(depositAddress,
  amountIn)` built and checked as in §6.1.
- The deposit address must be a valid Tron base58check address.
- 1Click's current minimum for Tron origin is $100.
- With D3(b), a sender may instead copy the deposit address and exact amount to another wallet. The page then waits on
  `/v0/status` as above, and offers a field to submit the deposit txid.

## 7. Failure cases

| Case | What the page does |
|---|---|
| Wrong network in TronLink (Nile, Shasta) | Refuses before building; asks to switch. |
| Tron node returns a different transaction than requested | §6.1 check fails. The page says so and tries the other node; it never asks for a signature. |
| Quote changed (mesh fee up > 10%, 1Click `minAmountOut` lower) | Shows old and new and waits for another click. |
| 1Click quote doesn't match the request, or the deadline is too near | Refused, with the field that differed. |
| Wallet refuses to sign, or closes | The status says "Cancelled in the wallet". Nothing is saved as pending unless a transaction was sent. An approval already confirmed stays and is reused. |
| Not enough SOL / TRX | The button is disabled, with the exact shortfall (§6.2). |
| Tron account too new: no free bandwidth, no energy | Covered by §6.2: all TRX burned is computed. An account that has never been activated cannot sign anything until it receives TRX; the page detects a missing account (`getaccount` empty) and says so. |
| Amount above Legacy Mesh credits | That route is disabled, with the current limit. |
| Recipient is a Solana token account | Refused (USDT would be lost). |
| Recipient has no Solana USDT account (Tron → Solana) | Rent value added to the LayerZero options (§6.3). |
| Mesh transfer stuck (Scan not `DELIVERED` after 15 min) | Shows Scan's status and DVN progress, the `guid`, and links. The money cannot be refunded at the source; it waits for verification. If Scan shows it verified but not executed: on Tron, the page offers to call the endpoint's `lzReceive` itself (permissionless in LayerZero V2, **UNVERIFIED** for this OFT, to test before shipping); on Solana, it links to LayerZero Scan and USDT0 support. |
| 1Click `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED` | Shows what the API says. For `REFUNDED`, checks the refund arrived on-chain. For `FAILED`, shows the saved quote, its signature, and where to ask for help. |
| A Solana transaction expires | Re-sent until its blockhash expires (sol2base). Then the page checks whether it landed before offering to retry. |
| The user reloads or closes the page | Resume from localStorage (§8), or from a pasted signature, txid or deposit address. |

## 8. What the page remembers (localStorage)

| Key | Contents |
|---|---|
| `sol2tron:transfers` | Array of the last 20 transfers, newest first (below) |
| `sol2tron:form` | Direction, amount, chosen route |
| `sol2tron:recipientTron`, `sol2tron:recipientSol` | Last recipient entered on each side |
| `sol2tron:qrSession`, `sol2tron:solDisconnected`, `sol2tron:tronWallet` | Wallet sessions, as sol2base |

A transfer record:

```json
{
  "id": "<source signature / 0x-txid / deposit address>",
  "route": "mesh" | "oneclick",
  "dir": "s2t" | "t2s",
  "from": "<sender>", "to": "<recipient>",
  "amount": "100000000", "expected": "99970000",
  "created": 1795100707000,
  "mesh": { "nativeFee": "…", "guid": "0x…", "extraOptions": "0x…" },
  "oneclick": { "quoteResponse": { … the whole response, with signature … }, "depositTx": "…" },
  "approveTx": "…",
  "status": "signed" | "sent" | "verifying" | "delivered" | "refunded" | "failed",
  "destTx": "…"
}
```

- A record is written **before** anything is signed for 1Click (the quote and signature), and as soon as a signature or txid
  exists for the mesh.
- On load, the page resumes every record that isn't finished.
- A "Recent transfers" list shows them, with links, and a field accepts any id to resume one this browser doesn't know: a Solana
  signature, a Tron txid, or a 1Click deposit address.

## 9. Build, pinning and deploy

Copied from sol2base:

- `build.sh <commit>`: `npm ci --ignore-scripts`, esbuild bundles of the four libraries, commit stamped into the footer, SHA-384
  integrity on every script and the stylesheet (entry tags and the import map). The build must be reproducible: two builds give the
  same bytes, and the test suite checks this.
- `check-page.sh [SITE_URL]` rebuilds the footer's commit and compares every file with the live site. The README documents it.
- `.github/workflows/pages.yml` publishes `_site/` from `main`.
- No frames: the page refuses to run if `window.top !== window.self`, as liq2sol.
- **Elsewhere, each in its own repository, after the user's approval:**
  - the `sol2tron` logo entry in `~/src/liq2sol/scripts/make-logo.py`;
  - the `sol2tron` case in `publish-nsite.sh`;
  - the menu link in sol2base, eth2base, liq2sol and BTC Swaps (`Nav.tsx` on `test`, then a PR);
  - the Reown allowlist entry for the nsite origin, which only the user can add.

## 10. Tests

Node's built-in `node:test`, no network, run by `npm test` and in the Pages workflow before the build.

**Codecs, against mainnet fixtures** (transactions from Phase 0, saved as JSON in `test/fixtures/`)

- Tron base58check ⇄ hex, including a bad checksum and the wrong prefix.
- The Tron protobuf reader decodes the saved `send` and `approve` transactions to the same fields TronGrid reports. Then every
  mutation is refused, one at a time:
  - another contract;
  - another owner;
  - a changed byte of calldata;
  - a higher `call_value`;
  - a higher `fee_limit`;
  - an expired or too-distant expiration;
  - two contracts;
  - a `txID` that doesn't match.
- `send` calldata encoded by `tron.js` equals mainnet transaction `93280e90…`'s calldata, given its parameters.
- The Solana `send` instruction data encoded by `solana.js` equals mainnet `5HRRJh…`'s, given its parameters.
- LayerZero options: `0x0003` + the rent-value option encodes to the bytes seen on mainnet.
- Fee math: `floor(amount × 3 / 10000)` at 0, 1, 3333, 10⁶ and u64 max.

**Checks that must refuse (adversarial)**

- 1Click quote responses with, each in turn:
  - another recipient;
  - another `refundTo`;
  - another origin or destination asset;
  - `amountIn` ≠ amount;
  - `minAmountOut` below the shown one;
  - a deposit address on the wrong chain or equal to the user's;
  - a deadline in 5 minutes;
  - a missing signature.
- Wrong Tron chain id from TronLink; a node with another genesis.
- Solana simulation results where the USDT delta or the SOL delta is off by one.
- A recipient that is a token account; a Tron recipient with a bad checksum.
- A mesh quote whose fee rose by 11% (needs a second click) or 9% (doesn't).
- A wallet that throws on sign: state stays recoverable, and no record is marked sent.
- LayerZero Scan and 1Click status responses for every status value, including unknown ones (treated as "still waiting").

**LayerZero account resolution (Solana):** the account list built from saved account data (`OFTStore`, peer, ULN configs, worker
configs, lookup table) equals the list in mainnet transaction `5HRRJh…`, in order and with the same writable and signer flags.

**Browser tests** with `playwright-core` and `chrome-headless-shell` (as sibling projects):

- the page against mocked wallets (Wallet Standard and a fake `window.tron`) and mocked HTTP;
- each flow to its end;
- resume after reload;
- the frame refusal;
- the menu at phone width.

**Read-only mainnet check** (`test/mainnet.mjs`, run by hand, never in CI, no keys):

- simulate `quote_send` and `send` on Solana with a funded address as payer (`sigVerify: false`);
- read `quoteOFT` / `quoteSend` on Tron;
- request `dry` 1Click quotes;
- confirm that every address, fee and enforced option still matches what the page assumes.

This is where UNVERIFIED item 13 gets closed before the first real transfer.

**Before release:** the user makes one small real transfer per route and direction (four in all) with their own wallets, and
checks the page's numbers against the explorers.

## 11. Still open from Phase 0

These affect the code but not this design. Each is resolved before the code that relies on it ships:

- whether Tron USDT needs the allowance set to 0 before a new one (§6.3 step 4);
- the 1Click `/v0/tokens` price list for SOL and TRX (§4);
- whether TronLink's `window.tron` flow and Trust Wallet's WalletConnect `tron` namespace behave as documented (§3);
- manual `lzReceive` on Tron for a verified but unexecuted message (§7).
