import { isAuthorized } from "../lib/config.js";
import { jsonResponse, unauthorized } from "../lib/http.js";
import { insertErrorLog } from "../lib/mongo.js";
import { runRedeem } from "../lib/redeem.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams;

  if (!isAuthorized(req, query)) {
    return unauthorized(res);
  }

  try {
    const result = await runRedeem({
      dryRunOverride: query.get("dryRun"),
      maxConditionsOverride: query.get("maxConditions"),
    });
    return jsonResponse(res, 200, result);
  } catch (error) {
    try {
      await insertErrorLog({
        created_at: new Date(),
        source: "api_redeem",
        message: error instanceof Error ? error.message : String(error),
        path: req.url,
      });
    } catch {}
    return jsonResponse(res, 500, {
      ok: false,
      error: "redeem_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
