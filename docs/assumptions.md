# sol2tron: Phase 0 research

Written 2026-11-19. Every finding has a source: a document, source code at a pinned commit, or a mainnet read or transaction
that anyone can repeat. Anything not checked that way is marked **UNVERIFIED** and listed again at the end.

Prices used to convert to dollars (CoinGecko, 2026-11-19 ~16:00 UTC): SOL $73.61, TRX $0.3096, ETH $1776.

## 1. The route: USDT0 Legacy Mesh

### 1.1 What it is, checked against the contracts

- The mesh is **credit-based and direct**. A Solana → Tron transfer is **one** LayerZero message from the Solana program to the
  Tron contract; it does not go through Arbitrum. The sender's USDT is locked in the source pool, and the destination pool pays
  out its own USDT. Each pool keeps a "credits" ledger per chain, which caps how much can go to each destination. Source: the
  Solana program's `send` (`programs/oft/src/instructions/send.rs` in
  [LayerZero-Labs/usdt-native-mesh@4ce9a59](https://github.com/LayerZero-Labs/usdt-native-mesh/tree/4ce9a592e178a333a451a3d464cee3bd782fbaf1))
  transfers to escrow, calls `credits.decrease_credits(dst_eid, …)`, and sends to `params.dst_eid`. The Tron contract's ABI has the same
  design (`credits(uint32)`, `CreditsSent`, `InsufficientCredits`).
- The docs say transfers "can take two hops" through Arbitrum ([the-legacy-mesh](https://docs.usdt0.to/overview/the-legacy-mesh.md)).
  That is for USDT0 chains. Between two legacy chains, mainnet transactions show a single hop (§3).
- **Fee: 3 bps (0.03%)**, taken from the amount: `received = amount − floor(amount × 3 / 10000)`.
  - Tron `feeBps()` = 3 (TronGrid read).
  - Solana `OFTStore.fee_bps` = 3 (account read).
  - `debit_view` in `quote_send.rs`.
- **The fee for the cross-chain message itself is paid in the source chain's native coin**: SOL from Solana, TRX from Tron
  (`MessagingFee.nativeFee`; `payInLzToken` is not used). Neither pool can take it in USDT.
- **Capacity on 2026-11-19:**
  - Solana → Tron: up to 789,199 USDT (Solana `Credits` account `6trV82jqtcqrsMd5ZXKvR6QzLX6bHstBK4wZFx1qrffC`, entry 30420).
  - Tron → Solana: up to 110,540 USDT (Tron `credits(30168)` and `quoteOFT().maxAmountLD`).
  - A send above the limit fails at the source (`InsufficientCredits` / Solana error 6007). Funds are never stuck for lack of
    liquidity.

### 1.2 Addresses

From [the USDT0 deployments API](https://docs.usdt0.to/api/deployments) (key `usdt0.legacyMesh`), each confirmed on-chain:

| What | Address | On-chain check |
|---|---|---|
| Solana OFT program | `Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7` | Upgradeable BPF program. OtterSec [verified build](https://verify.osec.io/status/Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7) of `usdt-native-mesh@4ce9a59`, hash `87172a14…d7f7` |
| Solana OFT store (PDA `["OFT"]`) | `HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN` | mint = USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, escrow `F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG`, endpoint `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6` |
| Solana peer config for Tron (PDA `["Peer", 30420 BE]`) | `8hR8fuankSi5ihaUeQCj6ydCF7rmZzqaznZsUjeDxuh8` | peer = `0x…3a08f767…0e97` = `TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt` |
| Tron OFT (`UsdtOFT`) | `TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt` (hex `413a08f767…0e97`) | `getcontract` name `UsdtOFT`; `token()` = USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`; `peers(30168)` = the Solana OFT store above; `endpoint()` = `TAy9xwjYjBBN6kutzrZJaAZJHCAejjK1V9` |
| LayerZero endpoint (Tron) | `TAy9xwjYjBBN6kutzrZJaAZJHCAejjK1V9` | Matches `tron-mainnet.endpointV2` in [LayerZero's metadata](https://metadata.layerzero-api.com/v1/metadata/deployments) |
| LayerZero endpoint, ULN (Solana) | `76y77prs…gEn6`, `7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH` | Matches `solana-mainnet` in the same metadata |
| Endpoint ids | Solana 30168, Tron 30420 | `SOLANA_EID()` / `TRON_EID()` on the Tron contract; `constants.rs` |

Who controls them:

- The Solana program's upgrade authority is `VHPQq7vmhCsTE6T5YKyEFRGL1krwyMzU54CJVXDwa33`, a system-owned account with no data,
  probably a Squads multisig vault (**UNVERIFIED**).
- The Tron contract's `owner()` is `TPiajmYGJChFxtUoLRnNQ3aXCkq9VwPvZu`, which is a contract (**UNVERIFIED** which multisig).

The roles in the code:

- `owner` / `super_admin` set peers and the fee.
- `lpAdmin` can `withdrawLocal` from the pool.
- `burnAndNilifyAdmin` can `burn` / `nilify` an inbound message (that is, cancel it).

USDT0 says the whole mesh is upgraded together and asks contract-level integrators to contact integrations@usdt0.to
([developer docs](https://docs.usdt0.to/technical-documentation/developer.md)).

### 1.3 Who verifies a transfer

These configs are read from the chains; they are what a transfer actually depends on:

| Path | Required verifiers (all must sign) | Confirmations | Executor |
|---|---|---|---|
| Solana → Tron | LayerZero Labs (`4VDjp6…Lfhb`) + USDT0 (`JBt34G…3wZs`) | 128 Solana slots (Solana `SendConfig` and Tron receive config agree) | LayerZero default `AwrbHe…Y7xK` |
| Tron → Solana | LayerZero Labs (`0x8bc1d368…a24e`) + USDT0 (`0xe13b0667…44df`) | 5 Tron blocks (both sides agree) | LayerZero `0x67de40af…c1bc` |

Where these come from:

- Tron: the endpoint's `getConfig(oft, lib, 30168, 2)`.
- Solana: the ULN `SendConfig` / `ReceiveConfig` PDAs seeded with the OFT store.
- DVN names: [LayerZero DVN metadata](https://metadata.layerzero-api.com/v1/metadata/dvns).

The brief listed three verifiers including Canary. This route requires **two**. Canary appears only in LayerZero's
*default* Solana config, which this OFT overrides. If either verifier stops, transfers stop; a single one cannot release funds.

### 1.4 Wire format

- **Message:** `u16 msgType (2 = SendOFT; 1 is WithdrawRemote, 3 SendCredits, 4 SendOFTAndCall) ‖ bytes32 to ‖ u64 amountSD`,
  with shared decimals 6 = USDT's decimals, so `amountSD = amountLD`. Source: `types.rs` and `codec/msg_codec.rs`. Observed on
  LayerZero Scan as the payload `0x0002` (type) + `000…6f0e388f…58b4` (to) + `0000000031473b9c` (amount).
  (Corrected on 2026-11-19: an earlier version of this document said type 1.)
- **Tron recipient from Solana:** `to` is the 20-byte Tron address, left-padded with 12 zero bytes. All mainnet Solana → Tron sends
  looked at (§3) use this form and arrived. Tether's WDK pads the 21-byte form with the `0x41` prefix instead
  ([`_encodeRecipient`](https://github.com/tetherto/wdk-protocol-bridge-usdt0-solana/blob/14d40bd4f57aaf901f7d19ae297746d0a6783b1c/src/usdt0-protocol-solana.js)).
  We use the 20-byte form, which is proven on mainnet.
- **Solana recipient from Tron:** `to` is the 32-byte wallet (owner) key. The program pays to the **associated token account
  (ATA) of that owner** and creates it if missing (`init_if_needed`, `payer` = the LayerZero executor; `lz_receive.rs`). If
  someone enters a *token-account* address as the recipient, the program creates an ATA owned by that token account, and the
  USDT is effectively lost. The page must refuse token accounts, as sol2base does.
- **Enforced options:** both directions enforce `lzReceive` gas 200,000 with value 0 (`0x0003 01 0011 01 …030d40`). Source:
  Tron `enforcedOptions(30168, 1)` and `enforcedOptions(30168, 2)` (identical), and Solana peer config `send_oft`.

## 2. Solana → Tron

### 2.1 What the page has to build

There is no published IDL on-chain (Anchor IDL account `8m373EdfR1VX5CKWX9iXYnEt6HLm2ave6VwB3pdVdGTj` does not exist). The
source and Tether's own client give everything:

- **`quote_oft`** and **`quote_send`** are view instructions, run by `simulateTransaction`:
  - `quote_oft` returns the limits and the amount received.
  - `quote_send` returns `MessagingFee { nativeFee, lzTokenFee }` as return data. Its accounts are `oft_store`, `credits`, `peer`,
    plus the endpoint's quote accounts.
- **`send`** (discriminator `66fb14bb414b0c45`). Its args are `{dst_eid u32, to [u8;32], amount_ld u64, min_amount_ld u64,
  extra_options Vec<u8>, compose_msg Option<Vec<u8>>, native_fee u64, lz_token_fee u64}`. Its fixed accounts are:
  1. `signer`
  2. `peer`
  3. `oft_store` (w)
  4. `credits` (w)
  5. `token_source` = the signer's USDT ATA (w)
  6. `token_escrow` (w)
  7. `token_mint`
  8. `token_program`
  9. `event_authority`
  10. the program itself

  After those come about 22 remaining accounts for the LayerZero endpoint and ULN: send-library configs, nonce, the ULN send
  config, treasury, and executor and DVN config and price-feed accounts. The OFT store's address lookup table carries most of them.
- The resolution of the remaining accounts is in Tether's
  [`wdk-protocol-bridge-usdt0-solana`](https://github.com/tetherto/wdk-protocol-bridge-usdt0-solana) (Apache-2.0, commit
  `14d40bd`): `_getEndpointRoute`, `_getQuoteEndpointAccounts` and `_getSendEndpointAccounts` (about 250 lines), plus the
  account decoders in `src/layerzero.js`. It is a port of LayerZero's `SendHelper` that avoids the heavy
  `@layerzerolabs/lz-solana-sdk-v2`. Apache-2.0 code can go into an AGPL-3.0 work, keeping its notice.
- Mainnet sends use 276k–301k compute units. WDK sets its own limit (`SEND_COMPUTE_UNIT_LIMIT`).
- **We have not yet simulated a send ourselves**; the account list is taken from WDK and from mainnet transactions.

### 2.2 What it costs (mainnet, 2026-11-19)

The 13 most recent `send` instructions on the OFT store, decoded (script in §8):

| Destination | LayerZero fee actually charged | In USD |
|---|---|---|
| **Tron (30420)** | **0.14782 SOL** (147,820,541 lamports, the same on all 8 sends) | **≈ $10.88** |
| Arbitrum (30110) | 0.0010–0.0020 SOL | ≈ $0.07–0.15 |
| Ethereum (30101) | 0.0084 SOL | ≈ $0.62 |
| TON (30343) | 0.0014 SOL | ≈ $0.10 |

- The Tron fee is high because the executor must pay Tron energy to run `lzReceive` there. It depends on Tron's energy price and
  the SOL/TRX price feed, not on the source. An Arbitrum → Tron quote at the same time was 0.00591 ETH ≈ $10.50.
- `native_fee` in the instruction is a ceiling. Two sends passed 0.4435 SOL and were charged 0.1479 SOL. (Their payer's balance
  fell by 147,915,493 lamports: the 0.1478 SOL fee plus the transaction fee.)
- The Solana transaction fee itself is 25,000–95,000 lamports (< $0.01).
- **The Tron recipient needs no TRX to receive**: the executor pays the delivery, and the USDT arrives by a TRC-20 transfer from
  the pool. To *move* it later the recipient needs TRX or a gas-free service, like any USDT on Tron.
- Whether receiving USDT activates a new Tron account is **UNVERIFIED**.

## 3. Tron → Solana

### 3.1 The calls

- **ABI:** from `wallet/getcontract` (94 entries; the tuple components are not in Tron's ABI). The `SendParam` struct is
  LayerZero's standard `(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg,
  bytes oftCmd)`. The selector of `send(SendParam,MessagingFee,address)` is `0xc7c7f5b3`, which matches the mainnet transactions,
  and `quoteOFT` / `quoteSend` decode correctly with that layout.
- **Step 1, approve:** `approvalRequired()` = true. The user approves USDT `TR7NHq…Lj6t` to spender `TFG4wB…LPt`.
  - On mainnet this approval cost **99,764 energy** plus 345 bytes of bandwidth (3 senders, transactions `8ce0ac57…`,
    `0d52d21a…`, `95a2c5f2…`). That is about 10.0 TRX if burned.
  - It is needed once if the allowance is large enough. Exact approvals cost it every time.
- **Step 2, send:** `quoteSend` gives `nativeFee` in **sun** (TRX × 10⁶). `send{value: nativeFee}(sendParam, {nativeFee, 0}, refundAddress)`.
  - Mainnet `send`s used **226,460 energy**. That includes 68,976 of "energy penalty", Tron's dynamic energy for busy contracts
    such as USDT. They also used about 800 bytes of bandwidth: more than the 600 free bandwidth a day, so 0.8 TRX is burned.
  - The three senders paid 22.6 TRX, 9.5 TRX (partly from staked energy) and 0 TRX (all staked) for energy.
- **The Solana recipient's token account:** when the recipient has no USDT ATA, the fee must carry rent for it. Other front ends
  add `extraOptions` = `lzReceive` gas 0, value **2,039,280 lamports** (`0x0003 01 0021 01 <16 zero bytes> <0x1f1df0>`).
  - Both mainnet transactions decoded did this, and LayerZero Scan shows `lzReceive {gas 200000, value 2039280}`.
  - With it, the fee was 5.976 TRX. Without it, `quoteSend` gave 4.925 TRX.
  - LayerZero says to add this value only when the ATA is missing
    ([Solana options](https://docs.layerzero.network/v2/developers/solana/gas-settings/options),
    [FAQ](https://docs.layerzero.network/v2/developers/solana/troubleshooting/faq)).
  - What happens if the value is missing and the ATA does not exist (delivery stuck until someone executes with rent, or the
    executor fronts it): **UNVERIFIED**. The page will add the value whenever the ATA is missing.

### 3.2 What a Tron sender needs, in TRX

| | Approve (first time) | Send | LayerZero fee | Total |
|---|---|---|---|---|
| No staked energy | ≈ 10.0 + 0.35 | ≈ 22.6 + 0.8 | 4.9–6.0 | **≈ 39 TRX (≈ $12) the first time, ≈ 29 TRX (≈ $9) after** |
| Enough staked or rented energy | bandwidth only | ≈ 0.8 | 4.9–6.0 | **≈ 6–7 TRX** |

- These are measured amounts. The energy penalty changes with USDT's load.
- The page should estimate the energy with `triggerconstantcontract` (it returns `energy_used`) and read the account's
  energy and bandwidth (`getaccountresource`), not hard-code them.
- **A sender with no TRX cannot send through the mesh.** The LayerZero fee must be paid as TRX `call_value`.
- GasFree, Tron's gas-free USDT service, signs plain USDT transfers only, so it cannot call `send` ([overview](https://tr.energy/en/blog/gas-free-tron-explained); **UNVERIFIED** in GasFree's own docs).
- Energy rental (renting staked energy for a few TRX) cuts the energy part but not the LayerZero fee. Specific rental services
  were not researched: **UNVERIFIED**.
- LI.FI's "$21 of TRX" estimate (§6) matches this table's no-energy case plus a margin. It is not a mystery fee.

## 4. Tracking a transfer

- **LayerZero Scan API:** `GET https://scan.layerzero-api.com/v1/messages/tx/<source tx hash>`. A Tron hash needs the `0x`
  prefix; without it the API answers `code 4040`.
  - No API key. `Access-Control-Allow-Origin: *`, so a static page can call it.
  - The response has `status.name` (`DELIVERED`, …), `source.tx`, the options, per-DVN verification transactions, and
    `destination.tx.txHash`.
- **Measured end-to-end times** (source block to destination block):
  - Solana → Tron: 71 s (`5HRRJh…`).
  - Tron → Solana: 98 s and 100 s (`93280e90…`, `a45e94e7…`).

  These fit the reported 1–5 minutes.
- **On-chain confirmation, without trusting Scan:**
  - Tron emits `OFTReceived(guid, srcEid, toAddress, amountReceivedLD)`. The TronGrid events API indexes it.
  - Solana emits `OFTReceived` by `emit_cpi`, so it is in the delivery transaction's inner instructions.
  - The `guid` links the two sides. It is returned by the source `send` and shown by Scan.
- **Status names other than `DELIVERED`** (`INFLIGHT`, `CONFIRMING`, `PAYLOAD_STORED`, `BLOCKED`, `FAILED`): **UNVERIFIED**. Only
  `DELIVERED` was observed.
- **If a transfer is stuck:**
  - There is **no refund at the source**: once sent, the USDT is in the source pool and can only be released at the destination.
  - Verification needs both DVNs.
  - Once a message is verified, LayerZero execution is permissionless: anyone can call the endpoint's `lzReceive` with the
    message and pay the gas. This is general LayerZero V2 behaviour, **UNVERIFIED** for these OFTs.
  - On Tron, a manual `lzReceive` is a single contract call the page could offer. On Solana it needs the `lz_receive_types_v2`
    account list.
  - The `burnAndNilifyAdmin` role can cancel an inbound message (`burn` / `nilify`).
  - What USDT0 support does for stuck transfers: **UNVERIFIED**.

## 5. Tron from a static page

### 5.1 Wallets

- **TronLink** ([TRON's integration guide](https://developers.tron.network/docs/tronlink-integration), [TIP-1193](https://github.com/tronprotocol/tips/blob/master/tip-1193.md)):
  - Discovery: TIP-6963 `TIP6963:announceProvider`, falling back to `window.tron`. The legacy `window.tronLink` still works.
  - Connect: `provider.request({ method: 'eth_requestAccounts' })`. The older `tron_requestAccounts` is deprecated.
  - After connecting, `provider.tronWeb` is a TronWeb instance; sign with `tronWeb.trx.sign(tx)`.
  - Events: `accountsChanged`, `chainChanged`. Mainnet chain id is `0x2b6653dc` (Nile `0xcd8690dc`, Shasta `0x94a9059e`).
  - We checked these from the guide only, not yet against a live TronLink: **UNVERIFIED** in practice.
- **WalletConnect, Tron namespace** ([Reown Tron RPC reference](https://docs.reown.com/advanced/multichain/rpc-reference/tron-rpc)):
  - Methods `tron_signTransaction` (params `{address, transaction}`; returns the transaction with `signature[]`) and
    `tron_signMessage`. `tron_sendTransaction` and `tron_getBalance` are optional, and dApps should broadcast themselves.
  - Wallets that send `sessionProperties.tron_method_version = "v1"` take the flat transaction. Older ones expect
    `params.transaction.transaction`.
  - Reown's examples use `tron:0xcd8690dc`, which is **Nile testnet**. The mainnet CAIP-2 id `tron:0x2b6653dc` is inferred from the
    chain id: **UNVERIFIED**.
  - Trust Wallet supports Tron through WalletConnect
    ([news](https://cryptobriefing.com/trust-wallet-tron-walletconnect-support/)). Whether one session can carry both the `solana`
    and `tron` namespaces, as sol2base's carries Solana and Base: **UNVERIFIED**.
- **Phantom:** no reliable source that Phantom holds Tron. Wallet tables list it as Solana-only for TRON ([Cobo](https://www.cobo.com/payments/en/guides/third-party-wallet-support));
  a 2025 claim came from a tweet. Treat as **no** until tested.
- **MetaMask** added Tron in January 2026 ([The Block](https://www.theblock.co/post/385768/metamask-native-tron-support-mobile-app-browser-extension)).
  How a dApp talks to it is **UNVERIFIED**.
- **Bundling TronWeb is not needed.**
  - A Tron node builds an unsigned transaction with `POST /wallet/triggersmartcontract` (returns `txID`, `raw_data`,
    `raw_data_hex`). The wallet signs it, and the page broadcasts it with `/wallet/broadcasttransaction`.
  - The node is untrusted, so the page must **decode `raw_data_hex` itself** before asking for a signature: a small protobuf
    reader for `TriggerSmartContract`. It checks:
    - the owner, the contract address and the calldata;
    - `call_value` and `fee_limit`;
    - the expiration;
    - `txID = sha256(raw_data_hex)`.

    ABI encoding can use viem, which the build already bundles.

### 5.2 Public Tron APIs (CORS checked from origin `https://swapmarket.github.io`)

| Endpoint | CORS | Notes |
|---|---|---|
| `https://api.trongrid.io` | `*` | Full node (`/wallet/*`) **and** the `/v1` indexer (events, account transactions). **Without an API key: 3 requests/s.** Above that it answers "request rate exceeded the allowed_rps(3), and the query server is suspended for 5 s". Seen in this research. |
| `https://tron-rpc.publicnode.com` | `*` (preflight OK) | Full node only: `triggerconstantcontract` and `triggersmartcontract` work; `/v1/...` returns 404. |
| `tron.drpc.org`, `rpc.ankr.com/http/tron` | `*` | 400 / 403 without a key. Not usable. |

The page should use publicnode for node calls and TronGrid (paced) for events, with LayerZero Scan as the main status source.

## 6. Alternatives, compared now that the mesh's cost is known

Live quotes, 2026-11-19 ~16:10 UTC. "Received" is USDT at the destination. "Sender pays" is on top of the amount.

**Solana → Tron**

| Route | 100 | 1,000 | 10,000 | Sender pays | Time |
|---|---|---|---|---|---|
| Legacy Mesh | 99.97 | 999.70 | 9,997.00 | **0.148 SOL ≈ $10.88** + < $0.01 | ~71 s measured |
| NEAR Intents 1Click, direct (`dry: true` quotes) | 98.29 | 998.38 | 9,998.19 | a USDT transfer, < $0.01 (+ ≈ $0.15 if the deposit address needs a token account, **UNVERIFIED**) | 75 s quoted |
| LI.FI (picked NEAR Intents; includes LI.FI's 0.25%) | 98.14 | 995.79 | – | $0.003 | 75 s quoted |

**Tron → Solana**

| Route | 100 | 1,000 | 10,000 | Sender pays | Time |
|---|---|---|---|---|---|
| Legacy Mesh | 99.97 | 999.70 | 9,997.00 | 5–6 TRX LayerZero fee + energy: **≈ 29 TRX ($9) with no energy, ≈ 39 TRX ($12) the first time**, ≈ 6–7 TRX with energy | ~100 s measured |
| NEAR Intents 1Click, direct | min $100 ("temporary swap limits") | 999.79 | 9,997.97 | a plain USDT transfer: ≈ 6.5–13 TRX with no energy (65k–130k energy; [figures](https://tr.energy/en/blog/gas-free-tron-explained)), or GasFree, about 1–1.5 USDT and **no TRX** | 77 s quoted |
| LI.FI (picked Layerswap) | 99.22 | 996.52 | – | LI.FI estimates $20.9 of TRX | 39 s quoted |

**Allbridge Core:** `core.api.allbridgecoreapi.net` still does not resolve (checked again 2026-11-19), and its docs say Solana
routes now go through NEAR Intents and LI.FI Intents anyway. Allbridge drops out.

### Trust and code

| | Legacy Mesh | NEAR Intents 1Click |
|---|---|---|
| Who holds the funds in flight | The two pools (Tether/USDT0 contracts). Release needs **both** LayerZero Labs and USDT0 to verify. | The user sends USDT to a **deposit address** that 1Click gives. Solvers fill, and NEAR Intents' bridge (`omft.near`, "PoA" bridge) holds custody in between. On failure, the deposit is refunded to `refundTo`. Operator and custody model: **UNVERIFIED** in detail. |
| What the user signs | A contract call whose minimum amount the program enforces | A plain USDT transfer to an address the API returned; the quote is the operator's promise, not enforced on-chain |
| Same issuer as the token | Yes (Tether's own network, like CCTP for sol2base) | No |
| API dependence | None needed to send (LayerZero Scan only for status) | The 1Click API for every quote, deposit address and status. No key needed today; terms and fees without a key are **UNVERIFIED**. |
| Sender with no gas coin | Solana: needs ~0.15 SOL. Tron: needs TRX, no way around it. | Solana: a few thousand lamports. Tron: can use a GasFree wallet with no TRX. |
| Page code (estimate) | Larger: LayerZero account resolution on Solana (port of ~250 lines from WDK), Tron transaction building and protobuf check, approval | Small: two token transfers and status polling |

### Permission, screening and tainted coins (checked 2026-11-19)

Neither route asks the user to identify themselves: no account, no API key, no KYC for the end user. Neither is
censorship-resistant.

**USDT itself, on both routes** (read from the chains):

- Tron `TetherToken` (`TR7NHq…jLj6t`): the on-chain ABI has `addBlackList`, `removeBlackList`, `isBlackListed`,
  `destroyBlackFunds`, `pause` and `unpause`.
- Solana USDT mint (`Es9vMF…wNYB`): `freezeAuthority` and `mintAuthority` are both `Q6XprfkF8RQQKoQVG33xT88H7wi8Uk1B1CC7YAs69Gi`.
- So coins that are already frozen can't leave by either route: the source transfer fails and only the network fee is lost.
  Coins that arrive can be frozen where they land.

**Legacy Mesh:**

- The contracts take no list of users. The Tron `UsdtOFT` ABI has no blacklist or screening function. Its admin functions are
  `transferOwnership`/`renounceOwnership`, `setPeer`, `setFeeBps`, `withdrawFees`, `setEnforcedOptions`, `setDelegate`,
  `setPlanner`, `setLpAdmin` and `setBurnAndNilifyAdmin`. The Solana `OFTStore` holds super admin, planner, LP admin and
  burn-and-nilify admin keys (`mesh.js` `parseOftStore`).
- The LayerZero executor config on Solana has allow and deny lists (`mesh.js` `parseExecutorPriceFeed`). Our reading is that
  they list applications (OApps), not end users. **UNVERIFIED.**
- Ways a transfer can still be stopped: the `burnAndNilifyAdmin` cancels the inbound message (§4), either DVN declines to
  verify, or an upgrade (the Solana program is upgradeable, §1.2). What happens to the money of a cancelled message is
  **UNVERIFIED**.
- USDT0's [terms of use](https://usdt0.to/terms) require users not to be sanctioned or in comprehensively sanctioned places.
  [LlamaRisk](https://research.llamarisk.com/research/regulatory-pressure-on-usdt-and-legal-features-of-usdt0) notes the terms
  don't describe freezing powers of USDT0's own.

**NEAR Intents 1Click** screens, and says it may hold:

- [1ClickSwap API Terms of Use](https://docs.near-intents.org/security-compliance/terms-of-service) (Intents Technology Limited,
  BVI; last updated 2026-10-07):
  - §10.5: "Transactions, assets, and addresses routed through or in connection with the 1Click Service are subject to
    transaction screening, sanctions, and other compliance, legal, and security controls." Also: "a Transaction may be delayed,
    blocked, or rejected, and assets to which it relates may be restricted or unavailable". Intents Technology "is not obliged
    to notify Developer or any End-User of a measure". It says it applies a measure itself "only where required by applicable
    law", and lifts it "where no grounds remain".
  - §7.7(f): bridging transfers "may be delayed, blocked, frozen, or rejected" on the basis of screening and KYT/AML controls.
  - §12.4: "no obligation to reverse, retry, refund, or recover any Transaction that fails".
  - §4.1(f): the *integrator* (here, SwapMarket's page) is to "conduct know-your-customer, know-your-business, and anti-money
    laundering compliance checks (including sanctions checks)". A static page with no server and no user accounts can't do
    this. **This is a terms question for the user to decide.**
- [NEAR Intents user terms](https://near.com/terms) (Intents Technology Ltd., updated 2026-11-13): refunds go to the refund
  address "subject to … compliance review and/or blocking or restriction", with no guarantee "that any refund will be available,
  complete, timely".
- [Risk and compliance](https://docs.near-intents.org/security-compliance/risk-and-compliance) (undated): quote requests are
  screened against the NEAR Intents AML Portal, Binance AML, AMLBot and PureFi, plus TRM Labs for non-dry quotes. "Coverage can
  vary by flow and integration path."
- An earlier version of that page, quoted on the
  [Zcash forum](https://forum.zcashcommunity.com/t/near-intents/54588) on 2026-02-07, said quotes are "automatically" refused for
  addresses TRM Labs flags for sanctions (`riskType: OWNERSHIP`) or "blocking behavior". It also said "When a match is
  detected, the quote request is immediately rejected". So a flagged address is normally refused *before* a deposit address is
  issued. The current page no longer lists the criteria.
- Custody in flight: a [third-party review](https://ethbeat.org/privacy/projects/zcash-near-intents) describes the PoA bridge
  as custodial, with operator-controlled deposit addresses and a multisig that can freeze accounts in the Verifier contract.
  **UNVERIFIED** against the contracts.
- Reported incident: [TokensFund](https://tokensfund.xyz/blog/near-intents-stuck-swap-incident-2026) reports about 5 BTC stuck
  in a 1Click swap since 2026-08-10, past its deadline and not refunded. This is a single third-party report, **UNVERIFIED**.

**What it means for a user with tainted coins:** on the Legacy Mesh, coins Tether hasn't frozen most likely go through: no
screening step was found, only rarely used admin powers. On 1Click, a flagged address is normally refused at the quote, before
any money moves. But a deposit flagged later can be held under the terms, with no duty to tell the user and no guaranteed
refund.

## 7. Recommendation

The trade-off is plain: **the Legacy Mesh is the trust-minimal route and the closest match to sol2base, but it costs about $11
per Solana → Tron transfer and about $9–12 of TRX per Tron → Solana transfer for a sender with no staked energy.** NEAR Intents
is cheaper at every amount quoted (about $1.7 for Solana → Tron), but the user hands the USDT to a third party's deposit address
and trusts its quote.

**Recommendation: build the Legacy Mesh as the route.** It moves Tether's own USDT through Tether's own network, enforces the
amount on-chain, needs no API key, and has no off-chain counterparty holding funds. That is why sol2base uses CCTP and not a
solver. The page must show the fixed fee prominently and in dollars before the user signs, and say plainly that small transfers
are expensive.

The user decides. The options:

1. **Legacy Mesh only** (recommended). Simplest to trust and audit. Poor value below about $1,000 Solana → Tron.
2. **NEAR Intents 1Click only.** Cheapest and least code; Tron senders can be gas-free. But it depends on a third party's API and
   custody, which is different from the other SwapMarket sites.
3. **Both**, showing the user both quotes. Best price for every amount, at the cost of two code paths, two trust models to explain,
   and twice the tests.

## 8. How this was checked (repeatable)

Scripts used were throw-away (scratchpad), but each step is a public call:

- USDT0 addresses: `curl https://docs.usdt0.to/api/deployments` → `usdt0.legacyMesh`.
- Tron reads: `POST https://api.trongrid.io/wallet/triggerconstantcontract` with viem-encoded calldata.
  - Views read: `feeBps`, `token`, `endpoint`, `owner`, `peers(30168)`, `credits`, `enforcedOptions`.
  - Quotes: `quoteOFT` / `quoteSend` for 10/100/1000 USDT, which gave 4,925,089 sun with no extra options.
  - The endpoint's `getSendLibrary` / `getReceiveLibrary` / `getConfig`.
- Tron transactions: `wallet/gettransactioninfobyid` and `gettransactionbyid` on the `OFTSent` events from
  `/v1/contracts/TFG4…/events?event_name=OFTSent`.
- Solana: `getSignaturesForAddress(OFT store)` → `getTransaction(…, maxSupportedTransactionVersion: 1)`. The Solana `send`
  instructions were decoded by discriminator. Accounts were read for `OFTStore`, the Tron peer, `Credits`, and the ULN
  `SendConfig` / `ReceiveConfig` PDAs.
  - Many Solana transactions on mainnet are now **version 1**. `@solana/web3.js` 1.x refuses them in `getTransaction`, so the page's
    history scans must use raw RPC or skip them.
- Program source: `verify.osec.io/status/<program>`, then the repo at the verified commit.
- LayerZero Scan: `GET /v1/messages/tx/<hash>`.
- Quotes: `https://li.quest/v1/quote`; `POST https://1click.chaindefuser.com/v0/quote` with `dry: true`.

## UNVERIFIED

1. Upgrade authority `VHPQq7…wa33` (Solana) and owner `TPiajm…vZu` (Tron) are multisigs, and of whom.
2. Receiving USDT on Tron activates a new Tron account (or not); what a new account needs to move it later.
3. Tron → Solana without the 2,039,280-lamport value when the recipient's ATA is missing: stuck, or fronted by the executor.
4. LayerZero Scan status names other than `DELIVERED`.
5. Permissionless `lzReceive` execution works for these OFTs; how the page would trigger it on each side.
6. What USDT0 support does for a stuck message.
7. TronLink's `window.tron` / `eth_requestAccounts` / `tronWeb.trx.sign` flow, tested against the live extension.
8. WalletConnect Tron mainnet chain id `tron:0x2b6653dc`, and whether one session can hold `solana` + `tron` (Trust Wallet).
9. Phantom and MetaMask Tron support for dApps.
10. GasFree cannot call contracts (only transfers), from GasFree's own docs; current GasFree fee.
11. Energy rental services and their prices.
12. NEAR Intents 1Click: custody model, fees and limits without an API key, and whether deposit addresses need a token account.
    Screening and holds are now sourced (§6, "Permission, screening and tainted coins"). Still unverified: the bridge's freeze
    powers against the contracts, and what happens to a deposit flagged after the quote.
15. What happens to the money of a Legacy Mesh message cancelled by the `burnAndNilifyAdmin`.
16. Whether the LayerZero executor's allow and deny lists on Solana list applications only, not end users.
13. Our own simulation of `quote_send` and `send` on Solana with WDK's account list. Not yet done; mainnet transactions show the
    list works.
14. Whether the Tron `UsdtOFT` source is published or verified anywhere; we used its on-chain ABI and Solana's sibling source.
