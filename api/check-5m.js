import { runCheck5m } from "../lib/check-bot-5m.js";
import { unauthorized, jsonResponse } from "../lib/http.js";
import { isAuthorized } from "../lib/config.js";
import { insertErrorLog } from "../lib/mongo.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams;

  if (!isAuthorized(req, query)) {
    return unauthorized(res);
  }

  try {
    const result = await runCheck5m({
      dryRunOverride: query.get("dryRun"),
    });
    return jsonResponse(res, 200, result);
  } catch (error) {
    try {
      await insertErrorLog({
        created_at: new Date(),
        source: "api_check_5m",
        message: error instanceof Error ? error.message : String(error),
        path: req.url,
      });
    } catch {}
    return jsonResponse(res, 500, {
      ok: false,
      error: "check_5m_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
