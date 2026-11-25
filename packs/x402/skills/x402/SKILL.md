---
name: x402
description: Pay for x402 paid HTTP APIs (402 Payment Required) in USDC with x402_quote, x402_fetch and x402_wallet. Use when a URL answers 402 with x402 payment options, or the user wants to call a pay-per-request API without an account.
---

# x402 payments

x402 lets an HTTP API charge per request: it answers `402 Payment Required` with its price, and the client pays in USDC by signing a transfer and sending the request again.

## Steps

1. `x402_quote` with the `url` (and `method`, `body`, `headers` if the request needs them). It pays nothing. It lists each option with `usd`, the network, and `payable` / `why_not`.
2. If an option is payable, call `x402_fetch` with the same request and `max_usd` set to the price you saw (or a little above). A person approves every payment before it is signed.
3. The result has the response (`body` for text, `artifact` for files), `payment.settlement.transaction` and `cost_usd`.

`x402_wallet` shows the wallet address to fund, the limits and the last payments.

## Rules

- Never raise `max_usd` above what the user agreed to. The pack also caps each payment (`maxPerCallUsd`, default $0.10) and every 24 hours (`dailyCapUsd`, default $1).
- Only USDC on the allowed networks (default Base and Base Sepolia) is paid. Other tokens or schemes come back as not payable.
- A refused or failed payment still counts against the 24-hour limit until its signature expires.
- Do not call `x402_fetch` again after a failure without telling the user: a second call is a second payment.

## Setup

Set `X402_PRIVATE_KEY` to the private key of a new wallet used only for this, with a few dollars of USDC on Base. To try it for free, allow only `eip155:84532` (Base Sepolia) and get test USDC from a faucet.
