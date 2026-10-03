import * as os from 'os';

// Virtual adapters that look like ordinary non-internal IPv4 interfaces but
// lead nowhere useful: Hyper-V/WSL/Docker switches on Windows, VM host-only
// networks, VPN tunnels. Windows often gives the WSL switch a lower route
// metric than the real NIC, so letting the OS pick sends mDNS traffic into it.
const VIRTUAL_NAME = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|vmnet|docker|br-|veth|utun|tailscale|zerotier|hamachi|loopback/i;

function score(name: string, address: string): number {
  let s = 0;
  if (!VIRTUAL_NAME.test(name)) s += 100;
  // Typical home/office router ranges first; 172.16/12 last since that's
  // exactly where WSL and Docker allocate their internal subnets.
  if (address.startsWith('192.168.')) s += 30;
  else if (address.startsWith('10.')) s += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 10;
  else if (address.startsWith('169.254.')) s -= 50;
  return s;
}

/** The IPv4 address of the interface most likely to be the real LAN —
 * the one other machines on the network can reach — or null if there's none. */
export function lanIPv4(): string | null {
  let best: { address: string; score: number } | null = null;
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const s = score(name, iface.address);
      if (!best || s > best.score) best = { address: iface.address, score: s };
    }
  }
  return best?.address ?? null;
}
