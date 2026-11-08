import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch now, then every `ms` while the tab is visible, and again whenever the tab regains focus —
 * so pages reflect attempts recorded by the tutor (CLI) without a manual refresh.
 */
export function usePolling<T>(fetcher: () => Promise<T>, ms = 5000, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = useRef(fetcher);
  f.current = fetcher;

  const refresh = useCallback(() => {
    f.current().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => document.visibilityState === 'visible' && refresh(), ms);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ms, ...deps]);

  return { data, error, refresh };
}
