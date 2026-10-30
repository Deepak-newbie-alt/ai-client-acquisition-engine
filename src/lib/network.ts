import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

// Explicit deny list, applied in addition to ipaddr.js range classification so
// that safety does not depend on how the library labels a given block.
const BLOCKED_CIDRS: readonly Cidr[] = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. cloud metadata 169.254.169.254
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. broadcast
  "::/128", // unspecified
  "::1/128", // loopback
  "::ffff:0:0/96", // IPv4-mapped (checked again after unwrapping)
  "64:ff9b::/96", // NAT64, can embed private IPv4
  "64:ff9b:1::/48", // local-use NAT64
  "100::/64", // discard
  "2001::/32", // Teredo
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, can embed private IPv4
  "fc00::/7", // unique local, incl. AWS metadata fd00:ec2::254
  "fe80::/10", // link-local
  "ff00::/8", // multicast
].map((cidr) => ipaddr.parseCIDR(cidr));

/** True only for a well-formed, globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  // Accept only canonical textual forms; legacy forms such as "0x7f.1" or
  // "2130706433" are rejected rather than interpreted.
  const isV4 = ipaddr.IPv4.isValidFourPartDecimal(address);
  if (!isV4 && !ipaddr.IPv6.isValid(address)) return false;

  let addr = ipaddr.parse(address);
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  if (addr.range() !== "unicast") return false;

  return !BLOCKED_CIDRS.some(([net, bits]) => addr.kind() === net.kind() && addr.match(net, bits));
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export class BlockedAddressError extends Error {
  constructor(readonly hostname: string) {
    super(`Host ${hostname} resolves to a non-public address`);
    this.name = "BlockedAddressError";
  }
}

/**
 * Resolves a hostname and rejects it if any returned address is non-public.
 * Rejecting on any bad record (not just the first) prevents an attacker from
 * mixing a public and a private record and relying on the client's choice.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: HostResolver = systemResolver,
): Promise<ResolvedAddress[]> {
  const addresses = await resolver(hostname);
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedAddressError(hostname);
  }
  return addresses;
}
