// Long-poll wait registration that removes itself: the terminal transition
// bulk-clears job.waiters, so a timed-out waiter that stayed registered would
// linger (and accumulate across polls) for the remaining lifetime of a
// long-running job. All three wait surfaces (hub, standalone jobs, workflow
// runtime) share this one implementation so the cleanup invariant cannot
// drift again.

/**
 * Race the job's waiters against a timeout, always unregistering the waiter
 * afterwards. `timeoutMs <= 0` means "no timeout": wait forever unless
 * `immediateWithoutTimeout` is set, which resolves immediately (poll
 * semantics, used by the hub route).
 */
export async function raceWaiters(waiters, { timeoutMs = 0, immediateWithoutTimeout = false } = {}) {
  let waiter = null;
  let timer = null;
  try {
    await Promise.race([
      new Promise((resolve) => { waiter = resolve; waiters.push(resolve); }),
      timeoutMs > 0
        ? new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })
        : (immediateWithoutTimeout ? Promise.resolve() : new Promise(() => {})),
    ]);
  } finally {
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (timer !== null) clearTimeout(timer);
  }
}
