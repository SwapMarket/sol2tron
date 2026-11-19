# sol2tron

Move USDT between Solana and Tron from a static page, one of SwapMarket's sites: https://swapmarket.github.io/sol2tron/

The page quotes two routes side by side, in both directions, and picks the one that leaves you more after every cost. You can
pick the other. Sources for everything below are in `docs/assumptions.md`; the design is in `docs/design.md`.

## The two routes

**USDT0 Legacy Mesh** is Tether's own network: USDT is locked in a pool on one chain and paid out of a pool on the other, with
the message carried by LayerZero. **NEAR Intents (1Click)** is a solver network: you send USDT to a one-time deposit address, and
a solver pays you on the other chain out of its own inventory.

| | Legacy Mesh | NEAR Intents |
|---|---|---|
| Cost | 0.03%, plus a flat fee per transfer: about $11 in SOL from Solana, about $12 in TRX from Tron | About $2 up to $10,000; then about 0.02%, rising to about 0.11% on very large amounts |
| Cheaper for | Large transfers: above roughly $100,000 from Tron, roughly $100,000–500,000 from Solana | Everything smaller |
| Minimum | None, but under about $12 the fee is more than the amount, and the page refuses | $100 from Tron (1Click's "temporary swap limit") |
| Liquidity | Published on chain, and shown on the page: on 2026-11-19, about 1,264,000 USDT to Tron and 244,000 to Solana | Not published; whatever solvers will fill. 1,000,000 USDT from Tron found no liquidity on 2026-11-19 |
| What you sign | A contract call; the program enforces the minimum you receive | A plain USDT transfer to an address the API gave; the quote is the operator's promise, not enforced on chain |
| Who holds the money in flight | Tether/USDT0's pools; delivery needs both LayerZero Labs and USDT0 to verify | NEAR Intents' bridge, until a solver fills. If no one does by the deadline, the deposit is refunded |
| Dependence on a service | None to send; LayerZero Scan only to follow it | The 1Click API for every quote, deposit address and status |
| Gas you need | SOL (about 0.15) from Solana; TRX from Tron, including an approval | A few thousand lamports from Solana; one USDT transfer's TRX from Tron |
| Time | 71–100 s measured on mainnet (1–5 minutes reported) | About 75 s, as quoted |

The costs are from live quotes on 2026-11-19 and move with SOL and TRX prices and with solver inventory. The page shows the
all-in cost of each route at the moment you look.

### Permission and tainted coins

Neither route asks who you are: no account, no API key, no KYC. Neither is censorship-resistant either.

- **USDT itself**, on both routes: Tether can blacklist a Tron address and erase its balance (`addBlackList`,
  `destroyBlackFunds`), and freeze any Solana USDT account (the mint's freeze authority is set). Frozen coins can't be sent by
  either route, and coins that arrive can be frozen where they land.
- **Legacy Mesh:** the contracts don't check who sends. But they have admins: the owner sets peers and fees, the Solana program
  is upgradeable, a `burnAndNilifyAdmin` can cancel a message in flight, and either verifier could refuse to verify. What
  happens to the money of a cancelled message is **UNVERIFIED**.
- **NEAR Intents:** an operated service that can refuse a quote, a deposit or a fill. Whether it screens deposits, and what it
  does with one it flags (refund, hold or seize), is **UNVERIFIED**.

## Build and check

`./build.sh` builds the site into `_site/`, with every script pinned by Subresource Integrity. `./check-page.sh` rebuilds the
commit the live page names and compares it with what is served, byte for byte. `npm test` runs the tests against mainnet
fixtures.

## Licence

AGPL-3.0-only (`LICENSE`).
