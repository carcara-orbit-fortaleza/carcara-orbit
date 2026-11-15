import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { resolveDatabaseUrl } from './database-url.js';

export type OperationStatus = 'running' | 'succeeded' | 'failed';

export interface DatabaseStatus {
  configured: boolean;
  connected: boolean;
  latencyMs?: number;
  error?: string;
}

export interface OperationRun {
  id: string;
  kind: string;
  status: OperationStatus;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'result is not JSON serializable' });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return serialize(error) ?? 'unknown error';
}

/**
 * Postgres connection shared by the API. When DATABASE_URL/DB_* are absent the
 * service stays disabled, so local mock mode and the test suite keep working.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly url = resolveDatabaseUrl();
  private pool: Pool | null = null;
  private lastError: string | null = null;

  onModuleInit(): void {
    if (!this.url) {
      this.logger.warn(
        'Postgres não configurado (DATABASE_URL/DB_* ausente); persistência desativada.',
      );
      return;
    }

    const max = Number.parseInt(process.env.DB_POOL_MAX ?? '10', 10);

    this.pool = new Pool({
      connectionString: this.url,
      max: Number.isFinite(max) && max > 0 ? max : 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    this.pool.on('error', (error) => {
      this.lastError = error.message;
      this.logger.error(`Erro no pool Postgres: ${error.message}`);
    });

    void this.status().then((status) => {
      if (status.connected) {
        this.logger.log('Postgres conectado.');
      } else {
        this.logger.warn(`Postgres indisponível: ${status.error ?? 'erro desconhecido'}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
    this.pool = null;
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  async status(): Promise<DatabaseStatus> {
    if (!this.pool) return { configured: false, connected: false };

    const startedAt = Date.now();
    try {
      await this.pool.query('SELECT 1');
      this.lastError = null;
      return {
        configured: true,
        connected: true,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.lastError = errorMessage(error);
      return {
        configured: true,
        connected: false,
        latencyMs: Date.now() - startedAt,
        error: this.lastError,
      };
    }
  }

  async startRun(
    kind: string,
    params: unknown = {},
  ): Promise<string | null> {
    if (!this.pool) return null;

    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO operation_runs (kind, params)
         VALUES ($1, $2::jsonb)
         RETURNING id`,
        [kind, serialize(params) ?? '{}'],
      );
      return rows[0]?.id ?? null;
    } catch (error) {
      this.logger.warn(
        `Falha ao registrar o início de ${kind}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  async finishRun(
    id: string | null,
    status: Exclude<OperationStatus, 'running'>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    if (!id || !this.pool) return;

    try {
      await this.pool.query(
        `UPDATE operation_runs
         SET status = $2, result = $3::jsonb, error = $4, finished_at = now()
         WHERE id = $1`,
        [id, status, serialize(result), error === undefined ? null : errorMessage(error)],
      );
    } catch (failure) {
      this.logger.warn(
        `Falha ao registrar o fim da execução ${id}: ${errorMessage(failure)}`,
      );
    }
  }

  /** Records start/end around an operation without changing its behavior. */
  async track<T>(
    kind: string,
    params: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const id = await this.startRun(kind, params);
    try {
      const result = await work();
      await this.finishRun(id, 'succeeded', result);
      return result;
    } catch (error) {
      await this.finishRun(id, 'failed', undefined, error);
      throw error;
    }
  }

  async listRuns(limit = 20): Promise<OperationRun[]> {
    if (!this.pool) return [];

    const { rows } = await this.pool.query<OperationRun>(
      `SELECT id, kind, status, params, result, error, started_at, finished_at
       FROM operation_runs
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
