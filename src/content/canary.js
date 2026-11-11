// Notices when YouTube changed its markup so far that tiles stop being
// readable, so the popup can say so instead of silently not filtering.
export function createDomHealthCanary() {
  let degradedScanStreak = 0;
  let status = 'ok';

  function observe({
    totalMatchedTiles = 0,
    nullChannelNameTiles = 0,
  } = {}) {
    const degradedScan = totalMatchedTiles >= 8
      && nullChannelNameTiles / totalMatchedTiles > 0.75;
    degradedScanStreak = degradedScan ? degradedScanStreak + 1 : 0;
    status = degradedScanStreak >= 5 ? 'degraded' : 'ok';
    return status;
  }

  function reset() {
    degradedScanStreak = 0;
    status = 'ok';
    return status;
  }

  return {
    observe,
    reset,
    get status() {
      return status;
    },
  };
}
