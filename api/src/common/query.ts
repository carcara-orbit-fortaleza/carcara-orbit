import { BadRequestException } from '@nestjs/common';

export const FIRST_YEAR = 2000;
export const LAST_YEAR = 2026;

export type Sensor = 'MODIS' | 'VIIRS';

/** Lê um ano opcional entre FIRST_YEAR e LAST_YEAR. */
export function parseYear(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const year = Number(typeof value === 'string' ? value : NaN);
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR) {
    throw new BadRequestException(
      `${name} deve ser um ano entre ${FIRST_YEAR} e ${LAST_YEAR}`,
    );
  }
  return year;
}

/** Valida o intervalo de anos (from <= to). */
export function parseYearRange(from: unknown, to: unknown): { from: number; to: number } {
  const start = parseYear(from, 'from', FIRST_YEAR);
  const end = parseYear(to, 'to', LAST_YEAR);
  if (start > end) {
    throw new BadRequestException('from não pode ser maior que to');
  }
  return { from: start, to: end };
}

/** Lê um bbox no formato oeste,sul,leste,norte. */
export function parseBbox(value: unknown): [number, number, number, number] | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parts = (typeof value === 'string' ? value : '').split(',').map(Number);
  const valid =
    parts.length === 4 &&
    parts.every((n) => Number.isFinite(n)) &&
    parts[0] < parts[2] &&
    parts[1] < parts[3] &&
    parts[0] >= -180 &&
    parts[2] <= 180 &&
    parts[1] >= -90 &&
    parts[3] <= 90;
  if (!valid) {
    throw new BadRequestException(
      'bbox deve ser oeste,sul,leste,norte com valores de longitude e latitude válidos',
    );
  }
  return parts as [number, number, number, number];
}

export function parseSensor(value: unknown): Sensor | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const sensor = (typeof value === 'string' ? value : '').toUpperCase();
  if (sensor !== 'MODIS' && sensor !== 'VIIRS') {
    throw new BadRequestException('sensor deve ser MODIS ou VIIRS');
  }
  return sensor;
}
