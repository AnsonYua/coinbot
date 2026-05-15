import { privateKeyToAccount } from "viem/accounts";
import {
  Chain,
  ClobClient,
  OrderType,
  Side as ClobSide,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { getConfig } from "./config.js";
import { activeMarketSlug } from "./time.js";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "btc-15m-wp-style-bot/1.0",
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

export async function fetchCurrentMarket(forceMarketSlug = "") {
  const slug = forceMarketSlug || activeMarketSlug();
  const market = await fetchJson(`${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`);
  const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);
  return {
    slug: market.slug,
    startTs: Number(market.slug.split("-").at(-1)),
    endTs: Number(market.slug.split("-").at(-1)) + 900,
    question: market.question,
    yesTokenId: String(yesTokenId),
    noTokenId: String(noTokenId),
  };
}

export async function fetchOrderBook(tokenId) {
  const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
  const book = await fetchJson(url);
  const bestBid = book.bids?.[0] ? Number(book.bids[0].price) : null;
  const bestBidSize = book.bids?.[0] ? Number(book.bids[0].size) : null;
  const bestAsk = book.asks?.[0] ? Number(book.asks[0].price) : null;
  const bestAskSize = book.asks?.[0] ? Number(book.asks[0].size) : null;
  return {
    bestBid,
    bestBidSize,
    bestAsk,
    bestAskSize,
    raw: book,
  };
}

let cachedClient = null;

async function getTradingClient() {
  if (cachedClient) return cachedClient;
  const config = getConfig();
  if (!config.polymarketPk || !config.polymarketApiKey || !config.polymarketApiSecret || !config.polymarketPassphrase) {
    throw new Error("Missing Polymarket credentials for live buy");
  }
  const account = privateKeyToAccount(`0x${config.polymarketPk.replace(/^0x/, "")}`);
  const client = new ClobClient({
    host: CLOB_BASE,
    chain: Chain.POLYGON,
    signer: account,
    signatureType: SignatureTypeV2.EOA,
    funderAddress: account.address,
    creds: {
      key: config.polymarketApiKey,
      secret: config.polymarketApiSecret,
      passphrase: config.polymarketPassphrase,
    },
  });
  cachedClient = client;
  return cachedClient;
}

export async function placeBuyOrder({ tokenId, entryPrice, stakeUsd }) {
  const client = await getTradingClient();
  const price = Number(entryPrice.toFixed(3));
  const amount = Number(stakeUsd.toFixed(2));
  return client.createAndPostMarketOrder({
    tokenID: tokenId,
    side: ClobSide.BUY,
    amount,
    price,
    orderType: OrderType.FOK,
  }, {}, OrderType.FOK);
}
