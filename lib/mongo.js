import { MongoClient } from "mongodb";
import { getConfig } from "./config.js";

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

export async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const db = await getDb();
      const decisions = db.collection("decisions");
      const actions = db.collection("actions");
      await dropIndexIfExists(decisions, "decision_once_per_market_side_strategy");
      await dropIndexIfExists(actions, "action_once_per_market_side_strategy");
      await decisions.createIndex(
        { market_slug: 1, side: 1 },
        { unique: true, name: "decision_once_per_market_side" },
      );
      await actions.createIndex(
        { market_slug: 1, side: 1 },
        { unique: true, name: "action_once_per_market_side" },
      );
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
  });
}

export async function insertDecision(doc) {
  const db = await getDb();
  return db.collection("decisions").insertOne(doc);
}

export async function updateDecision({ marketSlug, side, set }) {
  const db = await getDb();
  return db.collection("decisions").updateOne(
    {
      market_slug: marketSlug,
      side,
    },
    {
      $set: set,
    },
  );
}

export async function updateDecisionsForMarket({ marketSlug, set }) {
  const db = await getDb();
  return db.collection("decisions").updateMany(
    {
      market_slug: marketSlug,
    },
    {
      $set: set,
    },
  );
}

export async function claimDecisionForBuy({ marketSlug, side }) {
  const db = await getDb();
  return db.collection("decisions").findOneAndUpdate(
    {
      market_slug: marketSlug,
      side,
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
  return db.collection("actions").insertOne(doc);
}

export function isDuplicateKeyError(error) {
  return Boolean(error && typeof error === "object" && error.code === 11000);
}
