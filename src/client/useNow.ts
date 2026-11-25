import { useEffect, useState } from 'react';

/**
 * The current time, updated every `everyMs` while the component is shown: render stays pure, and
 * "5 min ago", elapsed minutes and "today" move on by themselves.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
