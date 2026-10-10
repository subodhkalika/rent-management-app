import { describe, expect, it } from 'vitest';
import { unitRoomsLine, unitSummaryLine } from './unit-summary';

/** docs/BUGS.md #6 — a unit now has a type, and bedrooms/bathrooms are optional.
 *  Every place a unit gets summarised must handle a unit with neither, without
 *  printing something silly ("null bd / null ba"). */
describe('unitRoomsLine / unitSummaryLine', () => {
  it('prints beds and baths for a flat', () => {
    const unit = { type: 'flat' as const, bedrooms: 2, bathrooms: 1 };
    expect(unitRoomsLine(unit)).toBe('2 bd / 1 ba');
    expect(unitSummaryLine(unit)).toBe('2 bd / 1 ba');
  });

  it('prints beds and baths for a house', () => {
    const unit = { type: 'house' as const, bedrooms: 4, bathrooms: 2.5 };
    expect(unitRoomsLine(unit)).toBe('4 bd / 2.5 ba');
  });

  it('a shutter has neither — unitRoomsLine is null, unitSummaryLine falls back to the type label', () => {
    const unit = { type: 'shutter' as const, bedrooms: null, bathrooms: null };
    expect(unitRoomsLine(unit)).toBeNull();
    expect(unitSummaryLine(unit)).toBe('Shutter / shop');
  });

  it('a room, garage and office all fall back to their type label too', () => {
    expect(unitSummaryLine({ type: 'room', bedrooms: null, bathrooms: null })).toBe('Room');
    expect(unitSummaryLine({ type: 'garage', bedrooms: null, bathrooms: null })).toBe('Garage / parking');
    expect(unitSummaryLine({ type: 'office', bedrooms: null, bathrooms: null })).toBe('Office');
  });

  it('never prints "null bd" even if a flat somehow has a null bedroom count', () => {
    const unit = { type: 'flat' as const, bedrooms: null, bathrooms: 1 };
    expect(unitRoomsLine(unit)).toBe('1 ba');
    expect(unitRoomsLine(unit)).not.toContain('null');
  });
});
