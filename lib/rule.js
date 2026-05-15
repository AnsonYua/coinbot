export function evaluateYesRule({ yesPrice, features }) {
  return (
    yesPrice >= 0.65 &&
    yesPrice < 0.75 &&
    features.btcTriggerPrice > features.btcStart &&
    features.aboveStartMinutes >= 9 &&
    features.ret10mToTrigger > 0
  );
}

export function evaluateNoRule({ noPrice, features }) {
  return (
    noPrice >= 0.65 &&
    noPrice < 0.75 &&
    features.btcTriggerPrice < features.btcStart &&
    features.belowStartMinutes >= 9 &&
    features.ret10mToTrigger <= 0
  );
}
