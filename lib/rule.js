// Legacy file kept for compatibility with older imports.
// Trading decisions now come from the probability map in lib/probability-map.js.
export function evaluateYesRule() {
  throw new Error("evaluateYesRule is deprecated; use evaluateProbabilitySide from lib/probability-map.js");
}

export function evaluateNoRule() {
  throw new Error("evaluateNoRule is deprecated; use evaluateProbabilitySide from lib/probability-map.js");
}
