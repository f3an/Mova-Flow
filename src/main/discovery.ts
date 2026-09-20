import * as os from 'os';
import { Bonjour, Service } from 'bonjour-service';

// mDNS/DNS-SD — the same protocol AirDrop and network printers use for "find
// it on the LAN without typing an IP". Only meaningful while the server is
// actually reachable from other machines (see lan_expose in index.ts) — a
// loopback-only host has nothing worth advertising.
const SERVICE_TYPE = 'mova-flow';
// A fixed alias alongside the machine's own hostname: a browser extension
// (see mova-flow-meet-recorder) can't browse mDNS services at all, so it just
// tries this one well-known name directly. Only resolves unambiguously with
// a single host per LAN — mDNS's own conflict resolution suffixes a second
// one (mova-flow-2.local), which the extension has no way to guess.
const FRIENDLY_HOST = 'mova-flow.local';

let bonjour: Bonjour | null = null;
let service: Service | null = null;

export function startAdvertising(port: number): void {
  if (service) return;
  bonjour = bonjour || new Bonjour();
  service = bonjour.publish({
    name: os.hostname(),
    type: SERVICE_TYPE,
    port,
    host: FRIENDLY_HOST,
  });
}

export function stopAdvertising(): void {
  service?.stop();
  service = null;
}

export interface DiscoveredHost {
  name: string;
  host: string;
  addresses: string[];
  port: number;
}

/** Browses for other Mova Flow hosts on the LAN for `timeoutMs`, then
 * returns whatever answered — used by the client role's "Scan network"
 * button; manual host/port entry stays available regardless of the result. */
export function discoverHosts(timeoutMs = 2500): Promise<DiscoveredHost[]> {
  return new Promise((resolve) => {
    const browserBonjour = new Bonjour();
    const found = new Map<string, DiscoveredHost>();

    const browser = browserBonjour.find({ type: SERVICE_TYPE }, (found_service) => {
      found.set(found_service.fqdn, {
        name: found_service.name,
        host: found_service.host,
        addresses: found_service.addresses || [],
        port: found_service.port,
      });
    });

    setTimeout(() => {
      browser.stop();
      browserBonjour.destroy();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
