import test from "node:test";
import assert from "node:assert/strict";

import { get5mTelegramConfig, getConfig, isAuthorized } from "../lib/config.js";

test("authorization accepts matching secret query", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: {} };
  const query = new URLSearchParams({ secret: "topsecret" });
  assert.equal(isAuthorized(req, query), true);
});

test("authorization accepts bearer token", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: { authorization: "Bearer topsecret" } };
  const query = new URLSearchParams();
  assert.equal(isAuthorized(req, query), true);
});

test("authorization rejects wrong secret", () => {
  process.env.CRON_SECRET = "topsecret";
  const req = { headers: {} };
  const query = new URLSearchParams({ secret: "wrong" });
  assert.equal(isAuthorized(req, query), false);
});

test("config exposes AUTO_BUY_5M_ENABLED and 5m telegram env", () => {
  process.env.CRON_SECRET = "topsecret";
  process.env.MONGODB_URI = "mongodb://localhost:27017/test";
  process.env.TELEGRAM_SIGNAL_BOT_TOKEN = "sig";
  process.env.TELEGRAM_SIGNAL_CHAT_ID = "100";
  process.env.TELEGRAM_ACTION_BOT_TOKEN = "act";
  process.env.TELEGRAM_ACTION_CHAT_ID = "200";
  process.env.TELEGRAM_SIGNAL_5M_BOT_TOKEN = "sig5";
  process.env.TELEGRAM_SIGNAL_5M_CHAT_ID = "300";
  process.env.TELEGRAM_ACTION_5M_BOT_TOKEN = "act5";
  process.env.TELEGRAM_ACTION_5M_CHAT_ID = "400";
  process.env.AUTO_BUY_5M_ENABLED = "true";
  process.env.BANKROLL_5M_START_USD = "42.5";

  const config = getConfig();
  assert.equal(config.autoBuy5mEnabled, true);
  assert.equal(config.bankroll5mStartUsd, 42.5);
  assert.equal(config.signal5mBotToken, "sig5");
  assert.equal(config.action5mChatId, "400");

  const telegram5m = get5mTelegramConfig(config);
  assert.deepEqual(telegram5m, {
    signalBotToken: "sig5",
    signalChatId: "300",
    actionBotToken: "sig5",
    actionChatId: "300",
  });
});
