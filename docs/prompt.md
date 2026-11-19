# sol2tron: the brief

Move USDT between Solana and Tron from a static web page, the way `~/src/sol2base` moves USDC/USDT between Solana and Base. It is
one of SwapMarket's sites, next to liq2sol, sol2base, eth2base and BTC Swaps (https://swapmarket.github.io/).

This brief was written on 2026-11-19, at the end of a conversation in `~/src/liq2sol` that only looked at feasibility. Nothing here is
verified against code or contracts yet: treat every claim below as **UNVERIFIED** until a phase checks it and cites a source.

## Working rules

- **Phase 0 (research) and Phase 1 (design) are documents only.** Stop after Phase 1 and wait for the user's review before writing
  any page code.
- Don't guess APIs, program ids, contract addresses or fees: verify them against official docs, source code, or the chains
  themselves, and cite them. Mark anything unverified **UNVERIFIED**.
- When a decision is the user's, list the options with their trade-offs instead of picking silently.
- Small, auditable code over features. Tests for every component, including adversarial ones (wrong chain, wrong token, a quote
  that changed, a wallet that refuses).
- Never generate, request or handle mainnet keys. The user tests with their own wallets.
- Licence: AGPL-3.0-only (`LICENSE`), like sol2base, because the menu, burger and styles come from AGPL code.

## What is known so far

### Routes

1. **USDT0's Legacy Mesh** (Tether's LayerZero network; the closest match to sol2base, which uses the issuer's own bridge, Circle's CCTP).
   - It links native USDT on Tron, TON, Solana, Celo and Ethereum through a hub on Arbitrum.
   - Solana joined around October 2025.
   - Reported cost is 0.03% per transfer plus a LayerZero network fee, which nobody has priced yet. Reported time is 1 to 5 minutes.
   - Trust: the pools, LayerZero, and three verifiers (LayerZero, USDT0, Canary). If any one stops, transfers stop.
   - Sources:
     - https://blog.usdt0.to/introducing-the-legacy-mesh-your-usdt-anywhere-now-everywhere
     - https://blog.usdt0.to/solana-unlocks-interoperability-for-usdt-and-tether-gold-liquidityy
2. **Allbridge Core** (JS SDK `@allbridge/bridge-core-sdk`, which covers Tron and Solana).
   - Its docs say Solana routes now go through intents: NEAR Intents and LI.FI Intents. Each transfer gets a market-priced quote, and
     fees can't be paid in gas or stablecoin on those routes.
   - Docs: https://docs-core.allbridge.io/llms.txt, and fees at https://docs-core.allbridge.io/product/how-does-allbridge-core-work/fees.md.
   - Its API host `core.api.allbridgecoreapi.net` did not resolve from the dev machine on 2026-11-19.
3. **Atomic swaps like liq2sol.** These need no bridge operator. They do need:
   - an escrow contract on Tron (Solidity on the TVM), reusing liq2sol's Solana escrow;
   - a new chain in the maker daemon;
   - makers holding USDT on both chains.

   This is weeks of work. Consider it only if the user wants it trustless.

**Not possible:** Circle's CCTP has no Tron domain. Circle stopped minting USDC on Tron in 2024.

### Live quotes for comparison (LI.FI public API, 2026-11-19)

Quotes from `https://li.quest/v1/quote`. Chain ids: Solana `1151111081099710`, Tron `728126428`.

USDT on Solana is `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, and on Tron `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.

| Direction | Send | Receive | Route |
|---|---|---|---|
| Solana → Tron | 10 | 7.54 | LI.FI Intents |
| Solana → Tron | 100 | 97.14 | LI.FI Intents |
| Solana → Tron | 1000 | 993.15 | Layerswap |
| Tron → Solana | 10 | 9.48 | Layerswap |
| Tron → Solana | 100 | 99.21 | Layerswap |
| Tron → Solana | 1000 | 996.51 | Layerswap |

- Every quote includes LI.FI's 0.25% fee.
- On top of that, the sender pays network fees. From Solana that is under a cent. From Tron, LI.FI estimated about $21 in TRX, which
  looks too high for a USDT transfer and is unexplained (**UNVERIFIED**).

## Phase 0: research (documents only)

Write `docs/assumptions.md`, with a source for every finding and an UNVERIFIED list.

1. **Legacy Mesh on Solana:** the program id(s), the instruction to send USDT to Tron, its accounts, and an IDL or source.
   - How the fee is quoted: LayerZero's `quote` or its equivalent, and in which token.
   - What the recipient gets on Tron, and whether it needs TRX to receive.
2. **Legacy Mesh on Tron:** the contract address(es) and the call to send USDT to Solana.
   - The approval step, and the energy and bandwidth it costs.
   - Whether a sender without TRX has any way to send (energy rental, a gasless option, fees paid in USDT).
3. **Tracking a transfer:** how to find out it arrived (LayerZero Scan API, events). How long it takes. What happens if it is stuck, and
   how to refund or retry.
4. **Tron wallets in a static page:**
   - TronLink's injected provider (`window.tronLink` / `tronWeb`).
   - Reown WalletConnect's Tron namespace and methods, for example `tron_signTransaction` (verify the exact names).
   - Whether Phantom or other Solana wallets also hold Tron.
   - Which public Tron RPC endpoints allow CORS (TronGrid needs an API key? verify).
5. **Compare once more** with Allbridge and LI.FI on cost, trust and code size, now that the Legacy Mesh fee is known. Recommend one.

## Phase 1: design (documents only)

Write `docs/design.md`, then stop for the user's review. It should cover:

- the chosen route and why;
- both directions step by step, including what the user signs and when, and what the page checks before and after;
- failure cases: a stuck transfer, a changed quote, the wrong network in the wallet, a Tron account too new to have energy;
- what the page shows and remembers, kept in localStorage per transfer, the way sol2base keeps its pending burn;
- how the build pins files, and the tests to write.

## How the page must fit in with SwapMarket's other sites

These match what sol2base and eth2base have now. Copy from `~/src/sol2base`.

- **Static page** built by `build.sh <commit>` into `_site/`. Libraries come from `package-lock.json`, bundled by esbuild into `vendor/`,
  and every script and the stylesheet are pinned with Subresource Integrity. The build must be reproducible: two builds of a commit give
  the same bytes.
- **`check-page.sh [SITE_URL]`** rebuilds the commit the footer names and compares every file with the live site. Put instructions in the
  README.
- **Deploy** with GitHub Pages from `main`, in a workflow like sol2base's `.github/workflows/pages.yml`. The site will live at
  https://swapmarket.github.io/sol2tron/.
- **The menu** has the logo on the left, then liq2sol, sol2base, eth2base, sol2tron, BTC Swaps, the current page in yellow. It folds into
  the burger on narrow screens. Copy the menu markup, CSS and script from sol2base.
  - Each link carries `data-site`, and `siteUrl()` keeps links on the nsite gateway the page was opened from.
  - Add sol2tron to the menus of all the other sites.
  - In BTC Swaps, that menu is in `~/src/swapmarket.github.io/src/components/Nav.tsx`, worked on the `test` branch, then a PR to `main`,
    then a manual "Deploy main" run.
- **The logo** is drawn by `~/src/liq2sol/scripts/make-logo.py`. Add a `sol2tron` entry: "sol" in Solana's gradient, a white "2", and
  "tron" in a Tron red that reads on the dark navy.
- **Nostr:** add a `sol2tron` case to `~/src/liq2sol/scripts/publish-nsite.sh`, the same as sol2base. The user signs in Alby; the key
  never comes near the code.
- **WalletConnect** uses the same Reown project ID as sol2base (in its `app.js`). The user must add `https://swapmarket.github.io` (already
  there) and the nsite origin to the allowlist.
- **No frames:** the page refuses to run inside a frame, as liq2sol does.
- **Help on Tron fees:** say plainly how much TRX a Tron sender needs, and how to get it.
