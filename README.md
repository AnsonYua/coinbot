# coinbot

Minimal buy-only BTC 15-minute Polymarket bot for Vercel.

## What it does

- exposes one endpoint: `GET /api/check?secret=...`
- expects cron to run at `13,28,43,58 * * * *`
- checks the active BTC 15-minute Polymarket market
- reads YES/NO top-of-book ask prices
- computes the BTC filter from Binance 1-minute candles
- sends a signal Telegram message every run
- sends an action Telegram message when a side passes
- optionally places one buy order for the market/side
- exposes a second endpoint: `GET /api/check-5m?secret=...`
- the 5-minute endpoint checks `btc-updown-5m-*` markets
- the 5-minute rule buys a side when BUY price is `> 0.80` and `<= 0.92`, BTC has moved in that side's direction by `0.025%` to `0.07%`, and 60-second momentum is not worse than `-0.02%` against the side
- the 5-minute bot buys `5` shares per passing side
- the 5-minute bot uses dedicated Telegram bots/env vars
- after a fresh 5-minute buy, it settles older 5-minute bought trades and sends a today summary of wins/losses

## Deploy

1. Import this repo into Vercel.
2. Set the environment variables from `.env.example`.
   Use your existing Polymarket-style names:
   `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`,
   `POLYMARKET_USER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE`.
3. Configure cron to call:

```bash
curl -fsS "https://your-domain.com/api/check?secret=YOUR_SECRET"
```

For the 5-minute endpoint:

```bash
curl -fsS "https://your-domain.com/api/check-5m?secret=YOUR_SECRET"
```

Dry run:

```bash
curl -fsS "https://your-domain.com/api/check?secret=YOUR_SECRET&dryRun=1"
```

5-minute dry run:

```bash
curl -fsS "https://your-domain.com/api/check-5m?secret=YOUR_SECRET&dryRun=1"
```

Suggested cron:

- `13,28,43,58 * * * *` for `/api/check`
- `4,9,14,19,24,29,34,39,44,49,54,59 * * * *` for `/api/check-5m`

Additional env for the 5-minute bot:

```bash
TELEGRAM_SIGNAL_5M_BOT_TOKEN=
TELEGRAM_SIGNAL_5M_CHAT_ID=
TELEGRAM_ACTION_5M_BOT_TOKEN=
TELEGRAM_ACTION_5M_CHAT_ID=
AUTO_BUY_5M_ENABLED=false
BANKROLL_5M_START_USD=30
```

Reset the active 5-minute paper records while keeping an archive:

```bash
RESET_5M_CONFIRM=1 MONGODB_URI="..." npm run reset:5m-records
```

This archives active `btc_5m_price_band` records under a timestamped strategy key so new summaries start from zero.

## Local checks

```bash
npm install
npm test
npm run check
```
