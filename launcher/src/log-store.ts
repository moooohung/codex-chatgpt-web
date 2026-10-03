import type { LogRecord } from "./types";

const MAX_RECORDS = 300;

/** Activity is the only subscriber; background output never re-renders the launcher shell. */
export function createLauncherLogStore() {
  let records: LogRecord[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: LogRecord[]) => {
    records = next.slice(-MAX_RECORDS);
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => records,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    seed: (initial: LogRecord[]) => publish(initial),
    append: (batch: LogRecord[]) => {
      if (batch.length) publish([...records, ...batch.slice(-MAX_RECORDS)]);
    },
  };
}

export type LauncherLogStore = ReturnType<typeof createLauncherLogStore>;
