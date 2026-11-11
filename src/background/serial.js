// Runs tasks one after another. Storage updates are read-modify-write, so two
// of them interleaving (two tabs, or a tab and a sync pull) would lose one.
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}
