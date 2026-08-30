import { describe, it, expect } from 'vitest';
import {
  isIpv4,
  isPrivateIpv4,
  isPrivateIpv6,
  isIpLiteral,
  isBlockedHostname,
} from './netguard.ts';

describe('isIpv4', () => {
  it('accepts valid dotted quads', () => {
    expect(isIpv4('8.8.8.8')).toBe(true);
    expect(isIpv4('127.0.0.1')).toBe(true);
    expect(isIpv4('255.255.255.255')).toBe(true);
  });
  it('rejects malformed / out-of-range / leading-zero', () => {
    expect(isIpv4('256.0.0.1')).toBe(false);
    expect(isIpv4('1.2.3')).toBe(false);
    expect(isIpv4('01.2.3.4')).toBe(false); // leading zero (decimal-octal ambiguity)
    expect(isIpv4('1.2.3.4.5')).toBe(false);
    expect(isIpv4('example.com')).toBe(false);
  });
});

describe('isPrivateIpv4 — blocks internal ranges incl. cloud metadata', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.5',
    '10.255.255.255',
    '127.0.0.1',
    '169.254.169.254', // AWS/GCP metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '100.64.0.1', // CGNAT
    '198.18.0.1', // benchmarking
    '224.0.0.1', // multicast
    '255.255.255.255',
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isPrivateIpv4(ip)).toBe(true));

  const allowed = ['8.8.8.8', '1.1.1.1', '104.16.0.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1'];
  for (const ip of allowed) it(`allows public ${ip}`, () => expect(isPrivateIpv4(ip)).toBe(false));
});

describe('isPrivateIpv6', () => {
  const blocked = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::10.0.0.1'];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isPrivateIpv6(ip)).toBe(true));

  const allowed = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'];
  for (const ip of allowed) it(`allows public ${ip}`, () => expect(isPrivateIpv6(ip)).toBe(false));

  it('strips a zone id before classifying', () => {
    expect(isPrivateIpv6('fe80::1%eth0')).toBe(true);
  });
});

describe('isIpLiteral', () => {
  it('recognises v4, v6 (bracketed too), and rejects names', () => {
    expect(isIpLiteral('10.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[fe80::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('isBlockedHostname — the sync SSRF gate', () => {
  const blocked = [
    'localhost',
    'app.localhost',
    'metadata.google.internal',
    'db.internal',
    'printer.local',
    'router', // single label
    'metadata', // single label
    '127.0.0.1',
    '169.254.169.254',
    '10.0.0.1',
    '192.168.0.1',
    '[::1]',
    '[fd00::1]',
    '', // empty
  ];
  for (const h of blocked) it(`blocks ${h || '(empty)'}`, () => expect(isBlockedHostname(h)).toBe(true));

  const allowed = ['example.com', 'openclawcity.ai', 'trustwright.deepblocker.ai', 'sub.domain.co.uk', '8.8.8.8', '104.16.0.1'];
  for (const h of allowed) it(`allows ${h}`, () => expect(isBlockedHostname(h)).toBe(false));

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(isBlockedHostname('LOCALHOST')).toBe(true);
    expect(isBlockedHostname('db.INTERNAL')).toBe(true);
    expect(isBlockedHostname('example.com.')).toBe(false);
    expect(isBlockedHostname('metadata.google.internal.')).toBe(true);
  });
});
