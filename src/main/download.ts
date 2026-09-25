import * as https from 'https';
import * as fs from 'fs';

export type DownloadProgressCb = (receivedBytes: number, totalBytes: number) => void;

/** Downloads a file over HTTPS, following redirects by hand (Node won't do it
 * for you), writing to `${destPath}.part` and renaming to destPath only after a
 * successful finish — so an interrupted download never leaves a partial file
 * that looks complete.
 *
 * `headers`, if given, are sent on the *first* request only — never forwarded
 * across a redirect. That matters for registry blob downloads (see ghcr.ts):
 * the initial request needs a bearer token, but the redirect target is a
 * pre-signed storage URL that doesn't expect (and may reject) an auth header
 * meant for a different host. */
export function downloadFile(
  url: string,
  destPath: string,
  onProgress?: DownloadProgressCb,
  headers?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirectsLeft: number, extraHeaders?: Record<string, string>) => {
      const onResponse = (res: import('http').IncomingMessage) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading ' + url));
            return;
          }
          // Headers (e.g. a bearer token for ghcr.io) are for the *original*
          // host — deliberately not passed along to whatever the redirect
          // points to.
          attempt(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${status} for ${currentUrl}`));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const tmpPath = `${destPath}.part`;
        const fileStream = fs.createWriteStream(tmpPath);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.on('error', (err) => {
          fileStream.close();
          reject(err);
        });
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            fs.rename(tmpPath, destPath, (renameErr) => {
              if (renameErr) reject(renameErr);
              else resolve();
            });
          });
        });
        fileStream.on('error', reject);
      };

      const req = extraHeaders ? https.get(currentUrl, { headers: extraHeaders }, onResponse) : https.get(currentUrl, onResponse);
      req.on('error', reject);
    };
    attempt(url, 5, headers);
  });
}
