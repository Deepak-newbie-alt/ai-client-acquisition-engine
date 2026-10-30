import { describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  isPublicAddress,
  resolvePublicAddresses,
  type HostResolver,
} from "../../src/lib/network.js";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    // loopback, private, link-local, metadata
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "100.64.0.1",
    "0.0.0.0",
    "0.1.2.3",
    // special-purpose IPv4
    "192.0.0.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.5",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fd00:ec2::254",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "64:ff9b::a00:1",
    "2002:a00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    // IPv4-mapped forms of private addresses
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["2130706433", "0x7f000001", "0x7f.1", "127.1", "017700000001", "", "example.com", "1.2.3.4.5"])(
    "rejects non-canonical or malformed input %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});

describe("resolvePublicAddresses", () => {
  const resolver =
    (...addresses: string[]): HostResolver =>
    () =>
      Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

  it("returns addresses when all are public", async () => {
    await expect(resolvePublicAddresses("example.com", resolver("8.8.8.8", "2606:4700::1"))).resolves.toHaveLength(2);
  });

  it("rejects when any record is private (DNS rebinding / mixed records)", async () => {
    await expect(resolvePublicAddresses("evil.example", resolver("8.8.8.8", "127.0.0.1"))).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it("rejects hosts resolving to cloud metadata", async () => {
    await expect(resolvePublicAddresses("evil.example", resolver("169.254.169.254"))).rejects.toThrow(
      "non-public address",
    );
  });

  it("rejects an empty answer", async () => {
    await expect(resolvePublicAddresses("empty.example", resolver())).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
