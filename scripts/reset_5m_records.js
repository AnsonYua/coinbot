import { MongoClient } from "mongodb";

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  throw new Error("Missing MONGODB_URI");
}

const strategyKey = process.env.RESET_5M_STRATEGY_KEY || "btc_5m_price_band";
const archiveKey = `${strategyKey}_archived_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const since = process.env.RESET_5M_SINCE ? new Date(process.env.RESET_5M_SINCE) : null;

if (process.env.RESET_5M_CONFIRM !== "1") {
  throw new Error("Set RESET_5M_CONFIRM=1 to archive active 5m records");
}

if (since && Number.isNaN(since.getTime())) {
  throw new Error("RESET_5M_SINCE must be a valid date when provided");
}

const filter = {
  strategy_key: strategyKey,
  ...(since ? { created_at: { $gte: since } } : {}),
};

const client = await MongoClient.connect(mongoUri);
try {
  const db = client.db("btc_15m_bot");
  const [decisions, actions, botRuns] = await Promise.all([
    db.collection("decisions").updateMany(filter, {
      $set: {
        strategy_key: archiveKey,
        archived_from_strategy_key: strategyKey,
        archived_at: new Date(),
      },
    }),
    db.collection("actions").updateMany(filter, {
      $set: {
        strategy_key: archiveKey,
        archived_from_strategy_key: strategyKey,
        archived_at: new Date(),
      },
    }),
    db.collection("bot_runs").updateMany(filter, {
      $set: {
        strategy_key: archiveKey,
        archived_from_strategy_key: strategyKey,
        archived_at: new Date(),
      },
    }),
  ]);

  console.log(JSON.stringify({
    ok: true,
    archivedTo: archiveKey,
    since: since ? since.toISOString() : null,
    decisionsMatched: decisions.matchedCount,
    decisionsModified: decisions.modifiedCount,
    actionsMatched: actions.matchedCount,
    actionsModified: actions.modifiedCount,
    botRunsMatched: botRuns.matchedCount,
    botRunsModified: botRuns.modifiedCount,
  }, null, 2));
} finally {
  await client.close();
}
