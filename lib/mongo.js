import { MongoClient } from "mongodb";
import { getConfig } from "./config.js";

let clientPromise;
let indexesPromise;

async function getClient() {
  if (!clientPromise) {
    clientPromise = MongoClient.connect(getConfig().mongoUri);
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db("btc_15m_bot");
}

export async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const db = await getDb();
      await db.collection("decisions").createIndex(
        { market_slug: 1, side: 1, strategy_version: 1 },
        { unique: true, name: "decision_once_per_market_side_strategy" },
      );
      await db.collection("actions").createIndex(
        { market_slug: 1, side: 1, strategy_version: 1 },
        { unique: true, name: "action_once_per_market_side_strategy" },
      );
      await db.collection("bot_runs").createIndex({ created_at: -1 });
    })();
  }
  await indexesPromise;
}

export async function insertBotRun(doc) {
  const db = await getDb();
  await db.collection("bot_runs").insertOne(doc);
}

export async function findDecision({ marketSlug, side, strategyVersion }) {
  const db = await getDb();
  return db.collection("decisions").findOne({
    market_slug: marketSlug,
    side,
    strategy_version: strategyVersion,
  });
}

export async function insertDecision(doc) {
  const db = await getDb();
  return db.collection("decisions").insertOne(doc);
}

export async function updateDecision({ marketSlug, side, strategyVersion, set }) {
  const db = await getDb();
  return db.collection("decisions").updateOne(
    {
      market_slug: marketSlug,
      side,
      strategy_version: strategyVersion,
    },
    {
      $set: set,
    },
  );
}

export async function claimDecisionForBuy({ marketSlug, side, strategyVersion }) {
  const db = await getDb();
  return db.collection("decisions").findOneAndUpdate(
    {
      market_slug: marketSlug,
      side,
      strategy_version: strategyVersion,
      passed: true,
      buy_completed: { $ne: true },
      buy_in_progress: { $ne: true },
      buy_retry_blocked: { $ne: true },
    },
    {
      $set: {
        buy_in_progress: true,
        buy_claimed_at: new Date(),
      },
    },
    {
      returnDocument: "after",
    },
  );
}

export async function insertAction(doc) {
  const db = await getDb();
  return db.collection("actions").insertOne(doc);
}

export function isDuplicateKeyError(error) {
  return Boolean(error && typeof error === "object" && error.code === 11000);
}
