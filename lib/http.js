export function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function unauthorized(res) {
  return jsonResponse(res, 401, { ok: false, error: "unauthorized" });
}
