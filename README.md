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

## Deploy

1. Import this repo into Vercel.
2. Set the environment variables from `.env.example`.
3. Configure cron to call:

```bash
curl -fsS "https://your-domain.com/api/check?secret=YOUR_SECRET"
```

Dry run:

```bash
curl -fsS "https://your-domain.com/api/check?secret=YOUR_SECRET&dryRun=1"
```

## Local checks

```bash
npm install
npm test
npm run check
```
