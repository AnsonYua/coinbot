import { Wallet } from "ethers";
import {
  Chain,
  ClobClient,
  OrderType,
  Side as ClobSide,
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

export async function fetchCurrentMarket() {
  const slug = activeMarketSlug();
  return fetchMarketBySlug(slug);
}

export async function fetchMarketByStartTs(marketStartTs) {
  return fetchMarketBySlug(`btc-updown-15m-${marketStartTs}`);
}

async function fetchMarketBySlug(slug) {
  const market = await fetchJson(`${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`);
  const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);
  return {
    slug: market.slug,
    startTs: Number(market.slug.split("-").at(-1)),
    endTs: Number(market.slug.split("-").at(-1)) + 900,
    question: market.question,
    yesTokenId: String(yesTokenId),
    noTokenId: String(noTokenId),
    tickSize: String(market.orderPriceMinTickSize || market.tickSize || "0.01"),
    orderMinSize: Number(market.orderMinSize || 0),
    negRisk: Boolean(market.negRisk),
  };
}

export async function fetchOrderBook(tokenId) {
  const url = `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`;
  const book = await fetchJson(url);
  const bestBid = book.bids?.[0] ? Number(book.bids[0].price) : null;
  const bestBidSize = book.bids?.[0] ? Number(book.bids[0].size) : null;
  const bestAsk = book.asks?.[0] ? Number(book.asks[0].price) : null;
  const bestAskSize = book.asks?.[0] ? Number(book.asks[0].size) : null;
  const asks = Array.isArray(book.asks)
    ? book.asks.map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
    : [];
  return {
    bestBid,
    bestBidSize,
    bestAsk,
    bestAskSize,
    asks,
    raw: book,
  };
}

export function summarizeBuyLiquidity(orderBook, maxPrice, targetShares) {
  const cappedAsks = (orderBook?.asks || []).filter((level) => level.price <= maxPrice);
  let availableShares = 0;
  let availableNotional = 0;
  for (const level of cappedAsks) {
    availableShares += level.size;
    availableNotional += level.size * level.price;
  }
  return {
    bestAsk: orderBook?.bestAsk ?? null,
    maxPrice,
    targetShares,
    availableShares,
    availableNotional,
    canAttempt: cappedAsks.length > 0,
    canFullyFill: availableShares >= targetShares,
  };
}

export async function fetchMarketPrice(tokenId, side = "BUY") {
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=${encodeURIComponent(side)}`;
  const payload = await fetchJson(url);
  const price = payload?.price != null ? Number(payload.price) : null;
  return Number.isFinite(price) ? price : null;
}

let cachedClient = null;

function numberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createPolymarketSigner(privateKey) {
  const wallet = new Wallet(privateKey);
  return {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (domain, types, typedValue) => wallet.signTypedData(domain, types, typedValue),
  };
}

async function getTradingClient() {
  if (cachedClient) return cachedClient;
  const config = getConfig();
  if (!config.polymarketPrivateKey) {
    throw new Error("Missing POLYMARKET_PRIVATE_KEY");
  }
  const funderAddress = config.polymarketFunderAddress || config.polymarketUserAddress;
  if (!funderAddress) {
    throw new Error("Missing POLYMARKET_FUNDER_ADDRESS");
  }

  const signer = createPolymarketSigner(config.polymarketPrivateKey);
  const clientOptions = {
    host: CLOB_BASE,
    chain: Chain.POLYGON,
    signer,
    signatureType: numberEnv(config.polymarketSignatureType, 3),
    funderAddress,
  };
  const authClient = new ClobClient(clientOptions);
  const creds = await authClient.createOrDeriveApiKey();
  cachedClient = new ClobClient({
    ...clientOptions,
    creds,
  });
  return cachedClient;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function placeBuyOrder({ tokenId, maxPrice, shares, market }) {
  const client = await getTradingClient();
  const price = Number(maxPrice.toFixed(3));
  const size = round6(shares);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("Invalid buy size");
  }
  if (market.orderMinSize && size < market.orderMinSize) {
    throw new Error(`Buy size ${size} is below market minimum ${market.orderMinSize}`);
  }
  const amount = Number((size * price).toFixed(6));
  return client.createAndPostMarketOrder({
    tokenID: tokenId,
    price,
    side: ClobSide.BUY,
    amount,
    orderType: OrderType.FAK,
  }, {
    tickSize: market.tickSize,
    negRisk: Boolean(market.negRisk),
  }, OrderType.FAK);
}
