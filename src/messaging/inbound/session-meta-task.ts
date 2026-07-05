export function createBncrSessionMetaTaskBarrier() {
  const pending = new Set<Promise<unknown>>();

  return {
    track(task: Promise<unknown>) {
      if (!task || typeof task.then !== 'function') return;
      pending.add(task);
      void task.finally(() => {
        pending.delete(task);
      });
    },
    async wait() {
      if (pending.size === 0) return;
      await Promise.allSettled([...pending]);
    },
  };
}
