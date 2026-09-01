import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from './crypto.ts';

describe('constantTimeEqual', () => {
  it('is true only for an exact match', () => {
    expect(constantTimeEqual('s3cret-token-abc', 's3cret-token-abc')).toBe(true);
    expect(constantTimeEqual('s3cret-token-abc', 's3cret-token-abd')).toBe(false);
  });

  it('is false when lengths differ (without an early length-branch)', () => {
    expect(constantTimeEqual('short', 'a-much-longer-secret')).toBe(false);
    expect(constantTimeEqual('a-much-longer-provided', 'short')).toBe(false);
  });

  it('is false for an empty provided token against a real secret', () => {
    expect(constantTimeEqual('', 'the-real-secret')).toBe(false);
  });

  it('does not throw on an empty secret (defensive), and never matches a non-empty input', () => {
    expect(() => constantTimeEqual('x', '')).not.toThrow();
    expect(constantTimeEqual('x', '')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true); // both empty is a trivial equal
  });

  it('is order-consistent (provided, secret)', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
  });
});
