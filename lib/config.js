import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBABILITY_MAP_PATH = path.resolve(
  LIB_DIR,
  "../data/btc_probability_map_365d_coarse.json",
);
const DEFAULT_TA_5M_PROBABILITY_MAP_PATH = path.resolve(
  LIB_DIR,
  "../data/btc_5m_ta_probability_map_90d.json",
);
const DEFAULT_MIN_MODEL_EDGE = 0.10;
const DEFAULT_MIN_MODEL_PROBABILITY = 0.70;
const DEFAULT_MIN_PROBABILITY_SUPPORT = 5;
const DEFAULT_PROBABILITY_FIELD = "win_rate";
const DEFAULT_BANKROLL_5M_START_USD = 30;
export const STRATEGY_KEY_15M = "btc_15m_model";
export const STRATEGY_KEY_5M = "btc_5m_price_band";
export const STRATEGY_KEY_5M_V2 = "btc_5m_ta_v2";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value == null ? fallback : value;
}

function optionalAny(names, fallback = "") {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") return value;
  }
  return fallback;
}

function optionalBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function optionalNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getConfig() {
  return {
    cronSecret: required("CRON_SECRET"),
    mongoUri: required("MONGODB_URI"),
    signalBotToken: required("TELEGRAM_SIGNAL_BOT_TOKEN"),
    signalChatId: required("TELEGRAM_SIGNAL_CHAT_ID"),
    actionBotToken: required("TELEGRAM_ACTION_BOT_TOKEN"),
    actionChatId: required("TELEGRAM_ACTION_CHAT_ID"),
    signal5mBotToken: optional("TELEGRAM_SIGNAL_5M_BOT_TOKEN"),
    signal5mChatId: optional("TELEGRAM_SIGNAL_5M_CHAT_ID"),
    action5mBotToken: optional("TELEGRAM_ACTION_5M_BOT_TOKEN"),
    action5mChatId: optional("TELEGRAM_ACTION_5M_CHAT_ID"),
    autoBuyEnabled: optionalBool("AUTO_BUY_ENABLED", false),
    autoBuy5mEnabled: optionalBool("AUTO_BUY_5M_ENABLED", false),
    polymarketPrivateKey: optionalAny(["POLYMARKET_PRIVATE_KEY", "POLYMARKET_PK"]),
    polymarketFunderAddress: optional("POLYMARKET_FUNDER_ADDRESS"),
    polymarketUserAddress: optional("POLYMARKET_USER_ADDRESS"),
    polymarketSignatureType: optional("POLYMARKET_SIGNATURE_TYPE", "3"),
    polygonRpcUrl: optional("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com"),
    dryRunDefault: optionalBool("DRY_RUN_DEFAULT", true),
    bankroll5mStartUsd: optionalNumber("BANKROLL_5M_START_USD", DEFAULT_BANKROLL_5M_START_USD),
    probabilityMapPath: DEFAULT_PROBABILITY_MAP_PATH,
    ta5mProbabilityMapPath: DEFAULT_TA_5M_PROBABILITY_MAP_PATH,
    minModelEdge: DEFAULT_MIN_MODEL_EDGE,
    minModelProbability: DEFAULT_MIN_MODEL_PROBABILITY,
    minProbabilitySupport: DEFAULT_MIN_PROBABILITY_SUPPORT,
    probabilityField: DEFAULT_PROBABILITY_FIELD,
  };
}

export function get5mTelegramConfig(config = getConfig()) {
  const missing = [];
  if (!config.signal5mBotToken) missing.push("TELEGRAM_SIGNAL_5M_BOT_TOKEN");
  if (!config.signal5mChatId) missing.push("TELEGRAM_SIGNAL_5M_CHAT_ID");
  if (missing.length > 0) {
    throw new Error(`Missing required 5m Telegram environment variables: ${missing.join(", ")}`);
  }
  return {
    signalBotToken: config.signal5mBotToken,
    signalChatId: config.signal5mChatId,
    actionBotToken: config.action5mBotToken || config.signal5mBotToken,
    actionChatId: config.action5mChatId || config.signal5mChatId,
  };
}

export function isAuthorized(req, query) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const bearer = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
  return query.get("secret") === expected || bearer === expected;
}
