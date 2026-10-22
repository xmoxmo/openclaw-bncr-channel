import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blockedAddresses = new BlockList();

// Non-public IPv4 ranges. Loopback, link-local (cloud metadata) and private
// networks must never be reachable through an inbound media URL.
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, 'ipv4');
  if (family === 6) return blockedAddresses.check(address, 'ipv6');
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  );
}

/**
 * Rejects inbound media URLs that point at non-public destinations. Applied to
 * every redirected hop so a public URL cannot bounce into loopback or a private
 * network.
 */
export async function assertPublicInboundMediaUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('inbound media url is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`inbound media url scheme is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('inbound media url must not embed credentials');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new Error('inbound media url is missing a host');
  if (isBlockedHostname(hostname)) {
    throw new Error(`inbound media url host is not public: ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error(`inbound media url address is not public: ${hostname}`);
    }
    return;
  }

  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`inbound media url host cannot be resolved: ${hostname} (${reason})`);
  }
  if (records.length === 0) {
    throw new Error(`inbound media url host cannot be resolved: ${hostname}`);
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error(
        `inbound media url host resolves to a non-public address: ${hostname} -> ${record.address}`,
      );
    }
  }
}
