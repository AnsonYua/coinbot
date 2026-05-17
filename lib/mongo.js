import { MongoClient } from "mongodb";
import { getConfig, STRATEGY_KEY_15M } from "./config.js";

let clientPromise;
let indexesPromise;

async function dropIndexIfExists(collection, indexName) {
  try {
    await collection.dropIndex(indexName);
  } catch (error) {
    const ignorable =
      error?.codeName === "IndexNotFound" ||
      error?.codeName === "NamespaceNotFound" ||
      error?.code === 26;
    if (!ignorable) {
      throw error;
    }
  }
}

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

function strategyOrDefault(strategyKey) {
  return strategyKey || STRATEGY_KEY_15M;
}

function actualBoughtClause() {
  return {
    $or: [
      { buy_completed: true },
      { buy_partial_fill: true },
      { buy_matched_shares: { $gt: 0 } },
    ],
  };
}

async function backfillLegacyStrategyKeys(db) {
  await db.collection("decisions").updateMany(
    { strategy_key: { $exists: false } },
    {
      $set: {
        strategy_key: STRATEGY_KEY_15M,
      },
    },
  );
  await db.collection("actions").updateMany(
    { strategy_key: { $exists: false } },
    {
      $set: {
        strategy_key: STRATEGY_KEY_15M,
      },
    },
  );
}

export async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const db = await getDb();
      await backfillLegacyStrategyKeys(db);
      const decisions = db.collection("decisions");
      const actions = db.collection("actions");
      await dropIndexIfExists(decisions, "decision_once_per_market_side_strategy");
      await dropIndexIfExists(decisions, "decision_once_per_market_side");
      await dropIndexIfExists(actions, "action_once_per_market_side_strategy");
      await dropIndexIfExists(actions, "action_once_per_market_side");
      await decisions.createIndex(
        { strategy_key: 1, market_slug: 1, side: 1 },
        { unique: true, name: "decision_once_per_market_side_strategy" },
      );
      await actions.createIndex(
        { strategy_key: 1, market_slug: 1, side: 1 },
        { unique: true, name: "action_once_per_market_side_strategy" },
      );
      await decisions.createIndex({ strategy_key: 1, created_at: -1 });
      await decisions.createIndex({ strategy_key: 1, outcome_status: 1, created_at: -1 });
      await db.collection("bot_runs").createIndex({ created_at: -1 });
      await db.collection("redeem_runs").createIndex({ created_at: -1 });
      await db.collection("error_logs").createIndex({ created_at: -1 });
    })();
  }
  await indexesPromise;
}

export async function insertBotRun(doc) {
  const db = await getDb();
  await db.collection("bot_runs").insertOne(doc);
}

export async function insertRedeemRun(doc) {
  const db = await getDb();
  await db.collection("redeem_runs").insertOne(doc);
}

export async function insertErrorLog(doc) {
  const db = await getDb();
  await db.collection("error_logs").insertOne(doc);
}

export async function findDecision({ marketSlug, side }) {
  const db = await getDb();
  return db.collection("decisions").findOne({
    market_slug: marketSlug,
    side,
    strategy_key: strategyOrDefault(),
  });
}

export async function insertDecision(doc) {
  const db = await getDb();
  return db.collection("decisions").insertOne({
    strategy_key: strategyOrDefault(doc.strategy_key),
    ...doc,
  });
}

export async function updateDecision({ marketSlug, side, strategyKey, set }) {
  const db = await getDb();
  return db.collection("decisions").updateOne(
    {
      market_slug: marketSlug,
      side,
      strategy_key: strategyOrDefault(strategyKey),
    },
    {
      $set: set,
    },
  );
}

export async function updateDecisionsForMarket({ marketSlug, strategyKey, set }) {
  const db = await getDb();
  return db.collection("decisions").updateMany(
    {
      market_slug: marketSlug,
      strategy_key: strategyOrDefault(strategyKey),
    },
    {
      $set: set,
    },
  );
}

export async function claimDecisionForBuy({ marketSlug, side, strategyKey }) {
  const db = await getDb();
  return db.collection("decisions").findOneAndUpdate(
    {
      market_slug: marketSlug,
      side,
      strategy_key: strategyOrDefault(strategyKey),
      passed: true,
      buy_order_accepted: { $ne: true },
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
  return db.collection("actions").insertOne({
    strategy_key: strategyOrDefault(doc.strategy_key),
    ...doc,
  });
}

export function isDuplicateKeyError(error) {
  return Boolean(error && typeof error === "object" && error.code === 11000);
}

export async function findDecisionByStrategy({ marketSlug, side, strategyKey }) {
  const db = await getDb();
  return db.collection("decisions").findOne({
    market_slug: marketSlug,
    side,
    strategy_key: strategyOrDefault(strategyKey),
  });
}

export async function findUnsettledAcceptedDecisions({ strategyKey, before }) {
  const db = await getDb();
  return db.collection("decisions").find({
    strategy_key: strategyOrDefault(strategyKey),
    outcome_status: { $in: [null, "unresolved"] },
    ...(before ? { created_at: { $lt: before } } : {}),
    ...actualBoughtClause(),
  }).toArray();
}

export async function listDecisionsForDay({ strategyKey, start, end }) {
  const db = await getDb();
  return db.collection("decisions").find({
    strategy_key: strategyOrDefault(strategyKey),
    ...actualBoughtClause(),
    created_at: {
      $gte: start,
      $lt: end,
    },
  }).toArray();
}
