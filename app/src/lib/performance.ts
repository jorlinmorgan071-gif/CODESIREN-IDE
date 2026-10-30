// app/src/lib/performance.ts
// Performance utilities: debounce, throttle, useDebouncedValue, useDeferredCallback.
// These reduce unnecessary re-renders and API calls.

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Debounce a callback by `delay` ms. Returns a memoized debounced function.
 * Use for input handlers, search, auto-save, etc.
 *
 * @example
 * const debouncedSearch = useDebounce((query: string) => fetchResults(query), 300);
 * <input onChange={(e) => debouncedSearch(e.target.value)} />
 */
export function useDebounce<T extends (...args: any[]) => void>(callback: T, delay: number): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => callbackRef.current(...args), delay);
    },
    [delay],
  ) as T;
}

/**
 * Debounce a value by `delay` ms. Useful for search inputs.
 *
 * @example
 * const [search, setSearch] = useState('');
 * const debouncedSearch = useDebouncedValue(search, 300);
 * useEffect(() => { if (debouncedSearch) fetchResults(debouncedSearch); }, [debouncedSearch]);
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Throttle a callback — ensures it runs at most once per `limit` ms.
 * Use for scroll/resize handlers.
 */
export function useThrottle<T extends (...args: any[]) => void>(callback: T, limit: number): T {
  const inThrottleRef = useRef(false);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  return useCallback(
    (...args: Parameters<T>) => {
      if (!inThrottleRef.current) {
        callbackRef.current(...args);
        inThrottleRef.current = true;
        setTimeout(() => {
          inThrottleRef.current = false;
        }, limit);
      }
    },
    [limit],
  ) as T;
}
