export function createStarvationNudge({
  minVisibleRatio = 0.25,
  maxConsecutive = 5,
  scrollBy,
}) {
  let consecutive = 0;
  let lastNudgeTotal = null;
  let awaitingNudgeResult = false;

  return {
    onCounts({ hidden, visible }) {
      const total = hidden + visible;

      // Judge the previous nudge by what the next scan found. A growing total
      // means YouTube supplied more tiles, so the nudge was effective even if
      // the visible ratio is still low deep in a filtered feed.
      if (lastNudgeTotal !== null) {
        if (total > lastNudgeTotal) {
          consecutive = 0;
          lastNudgeTotal = null;
          awaitingNudgeResult = false;
        } else if (awaitingNudgeResult) {
          consecutive += 1;
          awaitingNudgeResult = false;
        }
      }

      // A short unfiltered feed is YouTube's doing, not ours.
      if (hidden === 0) {
        consecutive = 0;
        lastNudgeTotal = null;
        awaitingNudgeResult = false;
        return;
      }

      // Counts cover the whole document, so a ratio remains meaningful after
      // many continuation loads while an absolute visible-count floor does not.
      if (visible / (visible + hidden) >= minVisibleRatio) {
        consecutive = 0;
        lastNudgeTotal = null;
        awaitingNudgeResult = false;
        return;
      }
      if (consecutive >= maxConsecutive) return;
      scrollBy();
      lastNudgeTotal = total;
      awaitingNudgeResult = true;
    },
    reset() {
      consecutive = 0;
      lastNudgeTotal = null;
      awaitingNudgeResult = false;
    },
  };
}
