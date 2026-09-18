import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/** A minimal in-process-memory rate limiter — plenty for a single-instance local
 * server (no need to stand up something like redis). Fixed window, keyed by IP. */
export function rateLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || 'unknown';
    const now = Date.now();

    if (buckets.size > 1000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: 'Too many requests, please try again later.' });
      return;
    }
    next();
  };
}
