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

function optionalBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function getConfig() {
  return {
    cronSecret: required("CRON_SECRET"),
    mongoUri: required("MONGODB_URI"),
    signalBotToken: required("TELEGRAM_SIGNAL_BOT_TOKEN"),
    signalChatId: required("TELEGRAM_SIGNAL_CHAT_ID"),
    actionBotToken: required("TELEGRAM_ACTION_BOT_TOKEN"),
    actionChatId: required("TELEGRAM_ACTION_CHAT_ID"),
    autoBuyEnabled: optionalBool("AUTO_BUY_ENABLED", false),
    polymarketPk: optional("POLYMARKET_PK"),
    polymarketApiKey: optional("POLYMARKET_API_KEY"),
    polymarketApiSecret: optional("POLYMARKET_API_SECRET"),
    polymarketPassphrase: optional("POLYMARKET_PASSPHRASE"),
    strategyVersion: process.env.STRATEGY_VERSION || "btc-15m-v1",
    dryRunDefault: optionalBool("DRY_RUN_DEFAULT", true),
  };
}

export function isAuthorized(req, query) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  const bearer = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
  return query.get("secret") === expected || bearer === expected;
}
