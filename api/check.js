import { runCheck } from "../lib/check-bot.js";
import { unauthorized, jsonResponse } from "../lib/http.js";
import { isAuthorized } from "../lib/config.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams;

  if (!isAuthorized(req, query)) {
    return unauthorized(res);
  }

  try {
    const result = await runCheck({
      dryRunOverride: query.get("dryRun"),
    });
    return jsonResponse(res, 200, result);
  } catch (error) {
    return jsonResponse(res, 500, {
      ok: false,
      error: "check_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
