import * as https from 'https';
import { downloadFile, DownloadProgressCb } from './download';

interface OciManifest {
  layers: { mediaType: string; digest: string; size: number }[];
}

function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        const status = res.statusCode || 0;
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (status !== 200) {
            reject(new Error(`GHCR request failed: HTTP ${status} for ${url}\n${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

/** Anonymous pull token for a *public* GHCR package — the same handshake
 * `docker pull` does under the hood for public images, no credentials
 * needed. Fails with 401/403 if the package isn't set to Public. */
async function anonymousToken(owner: string, pkg: string): Promise<string> {
  const url = `https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${pkg}:pull`;
  const { token } = await fetchJson<{ token: string }>(url, {});
  return token;
}

/** Downloads the single-layer blob of a public OCI artifact published to
 * GitHub Packages (via `oras push` — see build-whisper-macos.yml) — used for
 * the macOS whisper-cli build instead of a GitHub Release asset, per project
 * convention: the Releases page stays tag-only (app versions), ad-hoc build
 * artifacts tied to an upstream whisper.cpp tag go to Packages instead. */
export async function downloadGhcrArtifact(
  owner: string,
  pkg: string,
  tag: string,
  destPath: string,
  onProgress?: DownloadProgressCb,
): Promise<void> {
  const token = await anonymousToken(owner, pkg);
  const manifest = await fetchJson<OciManifest>(`https://ghcr.io/v2/${owner}/${pkg}/manifests/${tag}`, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.oci.image.manifest.v1+json',
  });

  const layer = manifest.layers[0];
  if (!layer) throw new Error(`No layers in GHCR manifest for ${owner}/${pkg}:${tag}`);

  await downloadFile(`https://ghcr.io/v2/${owner}/${pkg}/blobs/${layer.digest}`, destPath, onProgress, {
    Authorization: `Bearer ${token}`,
  });
}
