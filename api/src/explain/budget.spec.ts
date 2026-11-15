import { PerIpDailyBudget, parseIpBudget } from './budget.js';
import { DailyTokenBudget, parseBudget, DEFAULT_DAILY_TOKEN_BUDGET } from './budget.js';

describe('DailyTokenBudget', () => {
  it('reserves, settles and refuses past the limit', () => {
    const b = new DailyTokenBudget(1000);
    expect(b.reserve(600)).toBe(true);
    expect(b.reserve(500)).toBe(false);
    b.settle(600, 100);
    expect(b.spent).toBe(100);
    expect(b.reserve(800)).toBe(true);
  });

  it('resets on a new UTC day', () => {
    let now = new Date('2026-11-15T23:59:00Z');
    const b = new DailyTokenBudget(100, () => now);
    expect(b.reserve(100)).toBe(true);
    expect(b.reserve(1)).toBe(false);
    now = new Date('2026-11-16T00:00:01Z');
    expect(b.reserve(100)).toBe(true);
  });

  it('parses env with a safe default', () => {
    expect(parseBudget('5000')).toBe(5000);
    expect(parseBudget('abc')).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
    expect(parseBudget('-1')).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
    expect(parseBudget(undefined)).toBe(DEFAULT_DAILY_TOKEN_BUDGET);
  });
});

describe('PerIpDailyBudget', () => {
  it('caps per IP, isolates IPs and resets daily', () => {
    let now = new Date('2026-11-15T10:00:00Z');
    const b = new PerIpDailyBudget(100, 10, () => now);
    expect(b.reserve('a', 100)).toBe(true);
    expect(b.reserve('a', 1)).toBe(false);
    expect(b.reserve('b', 50)).toBe(true);
    now = new Date('2026-11-16T00:00:01Z');
    expect(b.reserve('a', 100)).toBe(true);
  });
  it('bounds memory by evicting the least recently used IP', () => {
    const b = new PerIpDailyBudget(100, 3);
    for (const ip of ['a', 'b', 'c', 'd', 'e']) b.reserve(ip, 10);
    expect(b.size).toBe(3);
    expect(b.spent('a')).toBe(0);
    expect(b.spent('e')).toBe(10);
  });
  it('defaults to a tenth of the global and never exceeds it', () => {
    expect(parseIpBudget(undefined, 200000)).toBe(20000);
    expect(parseIpBudget('500', 200000)).toBe(500);
    expect(parseIpBudget('900000', 200000)).toBe(200000);
  });
});
