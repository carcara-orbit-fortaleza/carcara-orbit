import {
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatasetService } from '../data/dataset.service.js';
import { IngestionService } from '../ingestion/ingestion.service.js';

export interface NrtError {
  at: string;
  code?: string | null;
  message: string;
  details?: unknown;
}

export interface NrtState {
  running: boolean;
  lastRun: string | null;
  lastSuccess: string | null;
  lastError: NrtError | null;
  lastResult: Record<string, unknown> | null;
  nextRun: string | null;
}

const DEFAULT_SOURCES = ['MODIS_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

@Injectable()
export class NrtService implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = process.env.NRT_ENABLED === 'true';
  private readonly intervalMinutes = Math.max(
    1,
    parseIntEnv(process.env.NRT_INTERVAL_MINUTES, 180),
  );
  private readonly days = Math.max(1, Math.min(5, parseIntEnv(process.env.NRT_DAYS, 2)));
  private readonly regions = parseList(process.env.NRT_REGIONS);
  private readonly sources = parseList(process.env.FIRMS_SOURCES) ?? DEFAULT_SOURCES;
  private readonly statusFile =
    process.env.NRT_STATUS_FILE ?? join(process.cwd(), 'data', 'runtime', 'nrt-status.json');

  private state: NrtState = {
    running: false,
    lastRun: null,
    lastSuccess: null,
    lastError: null,
    lastResult: null,
    nextRun: null,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ingestion: IngestionService,
    private readonly datasets: DatasetService,
  ) {}

  onModuleInit(): void {
    this.loadState();
    if (this.enabled) this.scheduleNext();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status() {
    return {
      ...this.state,
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      days: this.days,
      regions: this.regions,
      sources: this.sources,
      keyConfigured: Boolean(process.env.FIRMS_MAP_KEY),
    };
  }

  /** Starts a refresh and returns immediately (HTTP 202 pattern). */
  trigger(reason = 'manual') {
    if (this.state.running) {
      throw new ConflictException({
        message: 'An NRT refresh is already running.',
        status: this.status(),
      });
    }
    this.beginRun();
    void this.execute(reason).catch(() => {
      // execute() records the error in state.lastError.
    });
    return this.status();
  }

  /** Awaits a refresh; useful for CLI/tests. */
  async runNow(reason = 'manual') {
    if (this.state.running) {
      throw new ConflictException({
        message: 'An NRT refresh is already running.',
        status: this.status(),
      });
    }
    this.beginRun();
    return this.execute(reason);
  }

  private beginRun(): void {
    this.state.running = true;
    this.state.lastRun = new Date().toISOString();
    this.state.lastError = null;
    this.state.nextRun = null;
    this.persist();
  }

  private async execute(reason: string) {
    try {
      const result = await this.ingestion.runNrt({
        regions: this.regions?.join(','),
        days: this.days,
      });
      this.state.lastSuccess = new Date().toISOString();
      this.state.lastResult = result;
      this.state.lastError = null;
      this.datasets.reloadReal();
      return result;
    } catch (error) {
      this.state.lastError = {
        at: new Date().toISOString(),
        code: (error as { code?: string }).code ?? null,
        message: (error as Error).message,
        details: (error as { details?: unknown }).details,
      };
      throw error;
    } finally {
      this.state.running = false;
      this.state.nextRun = this.enabled
        ? new Date(Date.now() + this.intervalMinutes * 60_000).toISOString()
        : null;
      this.persist();
      void reason;
    }
  }

  private scheduleNext(): void {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.state.nextRun = new Date(
      Date.now() + this.intervalMinutes * 60_000,
    ).toISOString();
    this.persist();
    this.timer = setTimeout(async () => {
      try {
        await this.runNow('schedule');
      } catch {
        // runNow records failures in lastError.
      } finally {
        this.scheduleNext();
      }
    }, this.intervalMinutes * 60_000);
    this.timer.unref?.();
  }

  private loadState(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.statusFile, 'utf8')) as Partial<NrtState>;
      this.state = {
        ...this.state,
        ...parsed,
        running: false,
        lastError: parsed.running
          ? {
              at: new Date().toISOString(),
              message: 'Previous NRT run was interrupted by a server restart.',
            }
          : (parsed.lastError ?? null),
      };
    } catch {
      // First run: keep defaults.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.statusFile), { recursive: true });
      writeFileSync(
        this.statusFile,
        `${JSON.stringify(
          {
            ...this.state,
            enabled: this.enabled,
            intervalMinutes: this.intervalMinutes,
            days: this.days,
            regions: this.regions,
            sources: this.sources,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } catch {
      // Status persistence should not break the API.
    }
  }
}
