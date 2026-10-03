import * as os from 'os';
import { Bonjour, Service } from 'bonjour-service';
import { lanIPv4 } from './lanAddress';

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
let advertisedPort: number | null = null;
let netWatch: NodeJS.Timeout | null = null;
let netSignature = '';

// multicast-dns remembers every interface it has joined the mDNS group on and
// never forgets it. When Wi-Fi drops and comes back with the same IP (a
// channel change — DFS channels take 60s+ to come up — sleep, roaming), the OS
// has silently dropped that membership but the library thinks it still holds
// it, so the host stops hearing queries and vanishes from scans until the app
// restarts. Watching the address set and rebuilding the socket on any change
// covers the drop-and-return case too, since the address disappears in between.
function networkSignature(): string {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface!.address)
    .sort()
    .join(',');
}

// Left to itself, multicast-dns sends on whatever interface the OS routes
// 224.0.0.251 through — on Windows with WSL/Hyper-V/Docker that's often the
// vEthernet switch, so the host's answers never reach the real LAN (it still
// finds itself, which makes this look like a client-side problem). Pin both
// the outgoing interface and the group membership to the real LAN adapter;
// the socket itself stays bound to 0.0.0.0, since on macOS/Linux a socket
// bound to a unicast address never receives multicast at all.
function createBonjour(): Bonjour {
  const ip = lanIPv4();
  // bonjour-service forwards its options to multicast-dns untouched, but its
  // typings only describe service fields.
  type MdnsOptions = ConstructorParameters<typeof Bonjour>[0] & { interface: string; bind: string };
  return ip ? new Bonjour({ interface: ip, bind: '0.0.0.0' } as MdnsOptions) : new Bonjour();
}

function publish(port: number): void {
  bonjour = createBonjour();
  service = bonjour.publish({
    name: os.hostname(),
    type: SERVICE_TYPE,
    port,
    host: FRIENDLY_HOST,
  });
}

function teardown(): void {
  service?.stop();
  service = null;
  bonjour?.destroy();
  bonjour = null;
}

export function startAdvertising(port: number): void {
  if (service) return;
  advertisedPort = port;
  netSignature = networkSignature();
  publish(port);
  netWatch = setInterval(() => {
    const current = networkSignature();
    if (current === netSignature) return;
    netSignature = current;
    teardown();
    if (current && advertisedPort !== null) publish(advertisedPort);
  }, 5000);
}

export function stopAdvertising(): void {
  if (netWatch) clearInterval(netWatch);
  netWatch = null;
  advertisedPort = null;
  teardown();
}

export interface DiscoveredHost {
  name: string;
  host: string;
  addresses: string[];
  port: number;
}

// A host advertises an A record for every adapter it has, virtual ones
// included, and the UI connects to addresses[0] — so put whatever shares this
// machine's own LAN subnet first, then other IPv4, then IPv6.
function sortAddresses(addresses: string[]): string[] {
  const own = lanIPv4();
  const ownPrefix = own ? own.split('.').slice(0, 3).join('.') + '.' : null;
  const rank = (a: string): number =>
    ownPrefix && a.startsWith(ownPrefix) ? 0 : a.includes(':') ? 2 : 1;
  return [...addresses].sort((a, b) => rank(a) - rank(b));
}

/** Browses for other Mova Flow hosts on the LAN for `timeoutMs`, then
 * returns whatever answered — used by the client role's "Scan network"
 * button; manual host/port entry stays available regardless of the result. */
export function discoverHosts(timeoutMs = 2500): Promise<DiscoveredHost[]> {
  return new Promise((resolve) => {
    const browserBonjour = createBonjour();
    const found = new Map<string, DiscoveredHost>();

    const browser = browserBonjour.find({ type: SERVICE_TYPE }, (found_service) => {
      found.set(found_service.fqdn, {
        name: found_service.name,
        host: found_service.host,
        addresses: sortAddresses(found_service.addresses || []),
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
