const localLockTails = new Map<string, Promise<void>>();

async function withLocalLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = localLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localLockTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (localLockTails.get(key) === tail) localLockTails.delete(key);
  }
}

/** Serializes full-stage saves and atomic overtime appends, including across browser tabs. */
export async function withStagePersistenceLock<T>(
  stageId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `maic-stage-write:${stageId}`;
  const lockManager =
    typeof navigator === 'undefined'
      ? undefined
      : (
          navigator as Navigator & {
            locks?: { request: <R>(name: string, callback: () => Promise<R>) => Promise<R> };
          }
        ).locks;
  if (lockManager) return lockManager.request(key, work);
  return withLocalLock(key, work);
}
