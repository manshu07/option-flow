import { describe, expect, it } from 'vitest';
import { tokenExpiryAt, hoursLeft, tokenReminder } from './tokenWatch.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-18T13:00:00+05:30');

const tokenFor = expSeconds => `header.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.sig`;

describe('tokenExpiryAt', () => {
  it('reads exp from the token payload and shrugs off junk', () => {
    expect(tokenExpiryAt(tokenFor(Math.floor(NOW / 1000) + 3600))).toBe(Math.floor(NOW / 1000) * 1000 + 3600 * 1000);
    expect(tokenExpiryAt('not-a-token')).toBeNull();
    expect(tokenExpiryAt('')).toBeNull();
    expect(tokenExpiryAt(null)).toBeNull();
    expect(tokenExpiryAt('a.b.c')).toBeNull(); // payload is not JSON
  });

  it('reports hours left, rounded', () => {
    expect(hoursLeft(NOW + 2 * HOUR, NOW)).toBe(2);
    expect(hoursLeft(NOW - HOUR, NOW)).toBe(-1);
    expect(hoursLeft(null, NOW)).toBeNull();
  });
});

describe('tokenReminder', () => {
  it('stays quiet while the token is comfortably valid', () => {
    expect(tokenReminder({ expiresAt: NOW + 10 * HOUR, now: NOW })).toBeNull();
  });

  it('gives a same-day warning inside six hours and an urgent one inside the hour', () => {
    const soon = tokenReminder({ expiresAt: NOW + 4 * HOUR, now: NOW });
    expect(soon.level).toBe('soon');
    expect(soon.text).toContain('Regenerate it before the next market open');

    const urgent = tokenReminder({ expiresAt: NOW + 0.5 * HOUR, now: NOW });
    expect(urgent.level).toBe('urgent');
    expect(urgent.text).toContain('30 minutes');
  });

  it('says the token is dead once it expired, and never repeats', () => {
    const expired = tokenReminder({ expiresAt: NOW - HOUR, now: NOW });
    expect(expired.level).toBe('expired');
    expect(expired.text).toContain('has expired');
    expect(tokenReminder({ expiresAt: NOW + HOUR, now: NOW, alreadySent: true })).toBeNull();
    expect(tokenReminder({ expiresAt: null, now: NOW })).toBeNull();
  });
});