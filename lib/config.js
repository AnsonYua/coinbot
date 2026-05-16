import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBABILITY_MAP_PATH = path.resolve(
  LIB_DIR,
  "../data/btc_probability_map_365d.json",
);

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
  const probabilityField = optional("PROBABILITY_FIELD", "win_rate");
  return {
    cronSecret: required("CRON_SECRET"),
    mongoUri: required("MONGODB_URI"),
    signalBotToken: required("TELEGRAM_SIGNAL_BOT_TOKEN"),
    signalChatId: required("TELEGRAM_SIGNAL_CHAT_ID"),
    actionBotToken: required("TELEGRAM_ACTION_BOT_TOKEN"),
    actionChatId: required("TELEGRAM_ACTION_CHAT_ID"),
    autoBuyEnabled: optionalBool("AUTO_BUY_ENABLED", false),
    polymarketPrivateKey: optionalAny(["POLYMARKET_PRIVATE_KEY", "POLYMARKET_PK"]),
    polymarketFunderAddress: optional("POLYMARKET_FUNDER_ADDRESS"),
    polymarketUserAddress: optional("POLYMARKET_USER_ADDRESS"),
    polymarketSignatureType: optional("POLYMARKET_SIGNATURE_TYPE", "3"),
    dryRunDefault: optionalBool("DRY_RUN_DEFAULT", true),
    probabilityMapPath: optional("BTC_PROBABILITY_MAP_PATH", DEFAULT_PROBABILITY_MAP_PATH),
    minModelEdge: optionalNumber("MIN_MODEL_EDGE", 0.10),
    minProbabilitySupport: optionalNumber("MIN_PROBABILITY_SUPPORT", 5),
    probabilityField: probabilityField === "wilson_lower_95" ? "wilson_lower_95" : "win_rate",
  };
}

export function isAuthorized(req, query) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const bearer = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
  return query.get("secret") === expected || bearer === expected;
}
