import { Injectable } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service.js';
import { GeoFeature } from '../data/mock-data.service.js';
import { HotspotsService } from '../hotspots/hotspots.service.js';

const SEPARATOR = ';';
const BOM = '﻿';
const HEADER = [
  'regiao',
  'bioma',
  'ano',
  'mes',
  'focos_harmonizados',
  'anomalia_pct',
  'focos_modis_brutos',
  'focos_viirs_brutos',
  'share_viirs_pct',
  'metodo',
  'origem',
];

const HOTSPOT_HEADER = [
  'lat',
  'lon',
  'date',
  'ts_utc',
  'region_id',
  'biome',
  'sensor',
  'platform',
  'instrument',
  'resolution_m',
  'confidence',
  'confidence_class',
  'brightness_k',
  'frp_mw',
  'daynight',
  'qa_flag',
  'harmonized_weight',
  'method_version',
  'hotspot_count',
];

@Injectable()
export class ExportService {
  constructor(
    private readonly calendar: CalendarService,
    private readonly hotspots: HotspotsService,
  ) {}

  /**
   * CSV do calendário mensal de uma região. Usa UTF-8 com BOM e separador `;`
   * para abrir direto no Excel em pt-BR. Meses sem dado (null) não viram zero.
   */
  buildCsv(regionId: string, from?: unknown, to?: unknown) {
    const result = this.calendar.getCalendar(regionId, from, to);
    const rawMethod = result.meta.method_version;
    const method = typeof rawMethod === 'string' ? rawMethod : '';
    const origin = result.mode === 'real' ? 'NASA FIRMS (dados reais)' : 'dados sinteticos (mock)';
    const lines: string[] = [HEADER.join(SEPARATOR)];

    result.years.forEach((year, yi) => {
      result.months.forEach((monthLabel, mi) => {
        const count = result.counts[yi][mi];
        if (count === null) return;
        lines.push(
          [
            result.region.name,
            result.region.biome,
            year,
            mi + 1,
            count,
            decimal(result.anomaly_pct[yi][mi]),
            result.raw_modis[yi][mi] ?? '',
            result.raw_viirs[yi][mi] ?? '',
            decimal(result.viirs_share_pct[yi][mi]),
            method,
            origin,
          ].join(SEPARATOR),
        );
      });
    });

    const filename = `carcara-orbit_${regionId}_${result.period.from}-${result.period.to}.csv`;
    return { filename, body: BOM + lines.join('\r\n') + '\r\n' };
  }

  /**
   * CSV of hotspots filtered by the same search parameters as /api/hotspots.
   * UTF-8 BOM and `;` keep it Excel-friendly; empty values stay empty.
   */
  buildHotspotsCsv(params: {
    region?: string;
    from?: string;
    to?: string;
    sensor?: string;
    bbox?: string;
  }) {
    const result = this.hotspots.query({ ...params, limit: '50000' });
    const lines: string[] = [HOTSPOT_HEADER.join(SEPARATOR)];

    for (const feature of result.features as GeoFeature[]) {
      const props = feature.properties;
      const [lon, lat] = (feature.geometry as { coordinates: number[] }).coordinates;
      lines.push(
        [
          lat,
          lon,
          props.date ?? '',
          props.ts_utc ?? '',
          props.region_id ?? '',
          props.biome ?? '',
          props.sensor ?? '',
          props.platform ?? '',
          props.instrument ?? '',
          props.resolution_m ?? '',
          props.confidence ?? '',
          props.confidence_class ?? '',
          props.brightness_k ?? '',
          props.frp_mw ?? '',
          props.daynight ?? '',
          props.qa_flag ?? '',
          props.harmonized_weight ?? '',
          props.method_version ?? '',
          props.hotspot_count ?? '',
        ]
          .map((value) => String(value))
          .join(SEPARATOR),
      );
    }

    const suffix = [params.region, params.from, params.to, params.sensor]
      .filter(Boolean)
      .join('_');
    const filename = `carcara-orbit_focos${suffix ? `_${suffix}` : ''}.csv`;
    return { filename, body: BOM + lines.join('\r\n') + '\r\n' };
  }
}

function decimal(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.toFixed(1).replace('.', ',');
}
