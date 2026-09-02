export function createReadingStateWriter<T>(
  write: (value: T) => void,
  intervalMs = 500,
) {
  let disposed = false;
  let lastWrittenAt = Number.NEGATIVE_INFINITY;
  let pending: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending === undefined) return;
    const value = pending;
    pending = undefined;
    lastWrittenAt = Date.now();
    write(value);
  };

  return {
    schedule(value: T) {
      if (disposed) return;
      pending = value;
      const remaining = intervalMs - (Date.now() - lastWrittenAt);
      if (remaining <= 0) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, remaining);
      }
    },

    flush,

    dispose() {
      flush();
      disposed = true;
    },
  };
}
