# sol2tron

A static page that moves USDT between Solana and Tron, one of SwapMarket's sites (liq2sol, sol2base, eth2base, BTC Swaps).

**Read `docs/prompt.md` first.** It is the brief: what is known so far, and the phases. It governs the work.

## Rules

- **Phases 0 and 1 are documents only. Stop after Phase 1 and wait for the user's review before any page code.**
- Don't guess APIs, program ids, addresses or fees: verify them and cite sources. Mark anything unverified **UNVERIFIED**.
- When a decision is the user's, list the options with trade-offs instead of picking silently.
- Never generate, request or handle mainnet keys.
- Licence: AGPL-3.0-only (`LICENSE`).

## Repo conventions

- Commits are signed by SwapMarket (repo-local git config: user `SwapMarket`, key `01151A25AAE22F55`). Work on `main`. Commit
  when it makes sense, but **ask before each push**. The user approves a push by saying "push"; an "ok" is not enough.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- There is no GitHub repository yet. Creating `SwapMarket/sol2tron` (public, with Pages from `main`) is the user's call: ask first.
- Show the user screenshots of visual changes before committing them.

## Environment

- Node: `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`. Headless Chromium for screenshots and browser tests: the
  `playwright-core` in `~/src/liq2sol/client/node_modules`, with `chrome-headless-shell` from `~/.cache/ms-playwright`.
- Sister repositories to copy from: `~/src/sol2base` (closest: a Solana wallet, WalletConnect, and the build with SRI),
  `~/src/eth2base`, `~/src/liq2sol` (logo script, nsite publishing, `sites.js`), and `~/src/swapmarket.github.io` (BTC Swaps; its
  `test` branch takes the work, then a PR goes to `main`).
- `gh` is logged in as SwapMarket. It is version 2.45, which has no `gh attestation`.
- Never kill `elementsd` by name. The user's own node runs on this machine.
