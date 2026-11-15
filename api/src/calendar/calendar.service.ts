import { Injectable, NotFoundException } from '@nestjs/common';
import { RegionInfo } from '../data/mock-data.service.js';
import { DatasetService } from '../data/dataset.service.js';
import { parseYearRange } from '../common/query.js';

export interface CalendarResponse {
  mode: 'mock' | 'real';
  region: RegionInfo;
  period: { from: number; to: number };
  months: string[];
  years: number[];
  counts: (number | null)[][];
  anomaly_pct: (number | null)[][];
  raw_modis: (number | null)[][];
  raw_viirs: (number | null)[][];
  viirs_share_pct: (number | null)[][];
  series: unknown;
  metrics: unknown;
  insights: string[];
  meta: Record<string, unknown>;
}

@Injectable()
export class CalendarService {
  constructor(private readonly data: DatasetService) {}

  getCalendar(regionId: string, from?: unknown, to?: unknown): CalendarResponse {
    const region = this.data.findRegion(regionId);
    if (!region) {
      throw new NotFoundException(`Region not found: ${regionId}`);
    }
    const period = parseYearRange(from, to);
    const { dataset } = this.data;
    const rows = dataset.years
      .map((year, index) => ({ year, index }))
      .filter(({ year }) => year >= period.from && year <= period.to);
    const cal = dataset.calendar[regionId];
    const pick = <T>(matrix: T[][]): T[][] => rows.map(({ index }) => matrix[index]);

    return {
      mode: this.data.currentMode,
      region,
      period,
      months: dataset.months,
      years: rows.map(({ year }) => year),
      counts: pick(cal.counts),
      anomaly_pct: pick(cal.anomaly_pct),
      raw_modis: pick(cal.raw_modis),
      raw_viirs: pick(cal.raw_viirs),
      viirs_share_pct: pick(cal.viirs_share_pct),
      series: dataset.series[regionId],
      metrics: dataset.metrics[regionId],
      insights: dataset.insights[regionId] ?? [],
      meta: dataset.meta,
    };
  }
}
