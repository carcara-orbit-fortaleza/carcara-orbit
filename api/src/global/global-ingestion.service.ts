import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import { globalPaths } from './global.paths.js';

export interface GlobalIngestOptions {
  countries?: string | string[];
  startYear?: number;
  endYear?: number;
  sources?: string[];
  gridDegrees?: number;
  nrtTileDegrees?: number;
  maxFiles?: number;
  maxImportFiles?: number;
  includeCurrent?: boolean;
  currentDays?: number;
  allowPartial?: boolean;
  dryRun?: boolean;
  reset?: boolean;
  rebuildOnly?: boolean;
}

interface GlobalStatus {
  version?: number;
  running?: boolean;
  phase?: string;
  startedAt?: string;
  finishedAt?: string | null;
  options?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  interrupted?: boolean;
  cancelled?: boolean;
  [key: string]: unknown;
}

interface NormalizedGlobalIngestOptions {
  countries: 'all' | string[];
  startYear: number;
  endYear: number;
  sources?: string[];
  gridDegrees: number;
  nrtTileDegrees: number;
  maxFiles?: number;
  maxImportFiles?: number;
  includeCurrent: boolean;
  currentDays: number;
  allowPartial: boolean;
  dryRun: boolean;
  reset: boolean;
  rebuildOnly: boolean;
}

const CURRENT_YEAR = new Date().getUTCFullYear();

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

@Injectable()
export class GlobalIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GlobalIngestionService.name);
  private readonly root = process.cwd();
  private readonly pipelineCli = join(this.root, 'pipeline', 'src', 'cli.js');
  private readonly paths = globalPaths();
  private child: ChildProcess | null = null;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    const status = this.readStatus();
    if (status?.running) {
      this.writeStatus({
        ...status,
        running: false,
        interrupted: true,
        finishedAt: new Date().toISOString(),
        error:
          'A execução anterior foi interrompida pela reinicialização da API. O checkpoint permite retomar.',
      });
    }
  }

  onModuleDestroy(): void {
    this.child?.kill();
    this.child = null;
  }

  /** Current ingestion status, including the last persisted result/error. */
  status() {
    const status = this.readStatus();
    return {
      ...(status ?? {
        running: false,
        phase: 'idle',
        progress: {},
        result: null,
        error: null,
      }),
      running: Boolean(this.child) || Boolean(status?.running),
    };
  }

  async start(options: GlobalIngestOptions) {
    if (this.child) {
      throw new ConflictException('A global ingestion is already running.');
    }
    const normalized = this.validate(options);

    if (normalized.includeCurrent && !process.env.FIRMS_MAP_KEY) {
      throw new BadRequestException(
        'FIRMS_MAP_KEY é obrigatória para incluir a janela NRT global.',
      );
    }
    if (!existsSync(this.pipelineCli)) {
      throw new ConflictException(
        `Pipeline CLI não encontrado em ${this.pipelineCli}.`,
      );
    }

    const startedAt = new Date().toISOString();
    this.writeStatus({
      version: 1,
      running: true,
      phase: 'starting',
      startedAt,
      finishedAt: null,
      options: normalized as unknown as Record<string, unknown>,
      progress: {},
      result: null,
      error: null,
    });

    const runId = await this.database.startRun('global-ingestion', normalized);
    const args = this.buildArgs(normalized);
    let logFd: number | null = null;

    try {
      mkdirSync(dirname(this.paths.logFile), { recursive: true });
      logFd = openSync(this.paths.logFile, 'a');
      const child = spawn(process.execPath, [this.pipelineCli, ...args], {
        cwd: this.root,
        env: {
          ...process.env,
          GLOBAL_DB_PATH: this.paths.databaseFile,
          GLOBAL_RAW_DIR: this.paths.rawDir,
          GLOBAL_STATUS_FILE: this.paths.statusFile,
          GLOBAL_REGIONS_FILE: this.paths.regionsFile,
          GLOBAL_CALIBRATION_FILE: this.paths.calibrationFile,
          GLOBAL_LOG_FILE: this.paths.logFile,
          GLOBAL_DOWNLOAD_CHECKPOINT: this.paths.downloadCheckpoint,
          GLOBAL_IMPORT_CHECKPOINT: this.paths.importCheckpoint,
        },
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
      });
      this.child = child;
      child.on('error', (error) => {
        this.child = null;
        this.writeStatus({
          ...this.readStatus(),
          running: false,
          finishedAt: new Date().toISOString(),
          error: error.message,
        });
        void this.database.finishRun(runId, 'failed', undefined, error);
      });
      child.on('close', (code) => {
        this.child = null;
        const current = this.readStatus();
        if (current?.running) {
          this.writeStatus({
            ...current,
            running: false,
            finishedAt: new Date().toISOString(),
            error:
              current.error ??
              `O processo da ingestão terminou com código ${code} sem atualizar o status.`,
          });
        }
        const status = this.readStatus();
        const succeeded = code === 0 && !status?.error;
        void this.database.finishRun(
          runId,
          succeeded ? 'succeeded' : 'failed',
          succeeded ? { exitCode: code } : undefined,
          succeeded
            ? undefined
            : (status?.error ?? `Pipeline exited with code ${code}`),
        );
      });
    } catch (error) {
      this.child = null;
      this.writeStatus({
        ...this.readStatus(),
        running: false,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.database.finishRun(runId, 'failed', undefined, error);
      throw error;
    } finally {
      if (logFd !== null) closeSync(logFd);
    }

    return this.status();
  }

  async cancel() {
    if (!this.child) {
      throw new ConflictException('Nenhuma ingestão global está em execução.');
    }
    this.child.kill();
    this.writeStatus({
      ...this.readStatus(),
      running: false,
      cancelled: true,
      finishedAt: new Date().toISOString(),
      error: 'Cancelada pelo administrador.',
    });
    return this.status();
  }

  private validate(options: GlobalIngestOptions): NormalizedGlobalIngestOptions {
    const countries =
      options.countries === undefined || options.countries === 'all'
        ? 'all'
        : Array.isArray(options.countries)
          ? options.countries
          : String(options.countries)
              .split(',')
              .map((country) => country.trim())
              .filter(Boolean);
    if (Array.isArray(countries) && countries.length === 0) {
      throw new BadRequestException('countries não pode ser uma lista vazia.');
    }

    const startYear =
      options.startYear ?? envNumber('GLOBAL_START_YEAR', 2000);
    const endYear =
      options.endYear ?? envNumber('GLOBAL_END_YEAR', CURRENT_YEAR - 1);
    if (
      !Number.isInteger(startYear) ||
      !Number.isInteger(endYear) ||
      startYear < 2000 ||
      endYear > CURRENT_YEAR ||
      startYear > endYear
    ) {
      throw new BadRequestException(
        `startYear/endYear devem estar entre 2000 e ${CURRENT_YEAR} (startYear <= endYear).`,
      );
    }

    const gridDegrees =
      options.gridDegrees ?? envNumber('GLOBAL_GRID_DEGREES', 10);
    if (
      !Number.isFinite(gridDegrees) ||
      gridDegrees < 5 ||
      gridDegrees > 60
    ) {
      throw new BadRequestException('gridDegrees deve estar entre 5 e 60.');
    }

    const nrtTileDegrees =
      options.nrtTileDegrees ?? envNumber('GLOBAL_NRT_TILE_DEGREES', 30);
    if (
      !Number.isFinite(nrtTileDegrees) ||
      nrtTileDegrees < 5 ||
      nrtTileDegrees > 60
    ) {
      throw new BadRequestException('nrtTileDegrees deve estar entre 5 e 60.');
    }

    const envMaxFiles = Number(process.env.GLOBAL_MAX_FILES);
    const maxFiles =
      options.maxFiles ??
      (Number.isInteger(envMaxFiles) && envMaxFiles > 0
        ? envMaxFiles
        : undefined);
    const maxImportFiles = options.maxImportFiles;
    for (const [name, value] of [
      ['maxFiles', maxFiles],
      ['maxImportFiles', maxImportFiles],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new BadRequestException(`${name} deve ser um inteiro positivo.`);
      }
    }

    const sources = options.sources?.map((source) => String(source)).filter(Boolean);
    if (options.sources !== undefined && (!sources || sources.length === 0)) {
      throw new BadRequestException('sources não pode ser uma lista vazia.');
    }

    return {
      countries,
      startYear,
      endYear,
      sources,
      gridDegrees,
      nrtTileDegrees,
      maxFiles,
      maxImportFiles,
      includeCurrent: Boolean(options.includeCurrent),
      currentDays: Math.max(1, Math.min(5, options.currentDays ?? 2)),
      allowPartial: options.allowPartial !== false,
      dryRun: Boolean(options.dryRun),
      reset: Boolean(options.reset),
      rebuildOnly: Boolean(options.rebuildOnly),
    };
  }

  private buildArgs(options: NormalizedGlobalIngestOptions) {
    const args = ['global', '--json'];
    args.push(
      '--countries',
      options.countries === 'all' ? 'all' : options.countries.join(','),
      '--start-year',
      String(options.startYear),
      '--end-year',
      String(options.endYear),
      '--grid',
      String(options.gridDegrees),
      '--tile-degrees',
      String(options.nrtTileDegrees),
    );
    if (options.sources?.length) {
      args.push('--sources', options.sources.join(','));
    }
    if (options.maxFiles !== undefined) {
      args.push('--max-files', String(options.maxFiles));
    }
    if (options.maxImportFiles !== undefined) {
      args.push('--max-import-files', String(options.maxImportFiles));
    }
    if (options.includeCurrent) args.push('--current');
    else args.push('--no-current');
    if (!options.allowPartial) args.push('--strict');
    if (options.dryRun) args.push('--dry-run');
    if (options.reset) args.push('--reset');
    if (options.rebuildOnly) args.push('--rebuild-only');
    args.push('--days', String(options.currentDays));
    return args;
  }

  private readStatus(): GlobalStatus | null {
    try {
      return JSON.parse(readFileSync(this.paths.statusFile, 'utf8')) as GlobalStatus;
    } catch {
      return null;
    }
  }

  private writeStatus(status: GlobalStatus): void {
    try {
      mkdirSync(dirname(this.paths.statusFile), { recursive: true });
      const temporary = `${this.paths.statusFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.paths.statusFile);
    } catch (error) {
      this.logger.warn(
        `Não foi possível gravar o status da ingestão global: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
