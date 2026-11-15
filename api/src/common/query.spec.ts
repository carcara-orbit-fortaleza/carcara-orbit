import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseBbox, parseSensor, parseYear, parseYearRange } from './query.js';

describe('query parsing', () => {
  it('uses the fallback when the year is missing', () => {
    expect(parseYear(undefined, 'from', 2000)).toBe(2000);
  });

  it('rejects years outside the FIRMS-harmonized range', () => {
    expect(() => parseYear('1999', 'from', 2000)).toThrow(BadRequestException);
    expect(() => parseYear('2027', 'to', 2026)).toThrow(BadRequestException);
  });

  it('rejects an inverted year range', () => {
    expect(() => parseYearRange('2020', '2010')).toThrow(BadRequestException);
  });

  it('parses a valid bbox as west, south, east, north', () => {
    expect(parseBbox('-55,-20,-50,-15')).toEqual([-55, -20, -50, -15]);
  });

  it('rejects a bbox with the corners in the wrong order', () => {
    expect(() => parseBbox('-50,-20,-55,-15')).toThrow(BadRequestException);
  });

  it('accepts only MODIS or VIIRS as sensor', () => {
    expect(parseSensor('viirs')).toBe('VIIRS');
    expect(() => parseSensor('landsat')).toThrow(BadRequestException);
  });
});
