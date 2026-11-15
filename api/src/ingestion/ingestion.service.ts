import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import { DatasetService } from '../data/dataset.service.js';

export interface PipelineCommandResult {
  [key: string]: unknown;
}

@Injectable()
export class IngestionService {
  private readonly root = process.cwd();
  private readonly dataDir = join(this.root, 'data');
  private readonly rawDir = join(this.dataDir, 'raw');
  private readonly realDir = process.env.REAL_DATA_DIR ?? join(this.dataDir, 'real');
  private readonly pipelineCli = join(this.root, 'pipeline', 'src', 'cli.js');
  private readonly timeoutMs = Number(process.env.PIPELINE_TIMEOUT_MS ?? 900_000);

  constructor(
    private readonly datasets: DatasetService,
    private readonly database: DatabaseService,
  ) {}

  /** Runs the historical FIRMS CSV pipeline into data/real. */
  async runHistorical(inputDir?: string): Promise<PipelineCommandResult> {
    const resolved = resolve(inputDir ?? this.rawDir);
    if (!resolved.startsWith(`${resolve(this.dataDir)}${sep}`)) {
      throw new BadRequestException('inputDir must be inside the project data/ directory');
    }
    return this.database.track('pipeline', { inputDir: resolved }, () =>
      this.run(['pipeline', '--input', resolved, '--out', this.realDir, '--json']),
    );
  }

  /** Fetches recent FIRMS data, merges with stored history and rebuilds data/real. */
  async runNrt(options: { regions?: string; days?: number } = {}): Promise<PipelineCommandResult> {
    const args = ['nrt', '--json'];
    if (options.regions) args.push('--regions', options.regions);
    if (options.days !== undefined) args.push('--days', String(options.days));
    return this.database.track('nrt', options, () => this.run(args));
  }

  private run(args: string[]): Promise<PipelineCommandResult> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [this.pipelineCli, ...args], {
        cwd: this.root,
        env: {
          ...process.env,
          STORAGE_DIR: this.dataDir,
          LOG_LEVEL: 'error',
          NRT_ENABLED: 'false',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(
          new InternalServerErrorException(`Pipeline timed out after ${this.timeoutMs} ms`),
        );
      }, this.timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(new InternalServerErrorException(`Failed to start pipeline: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          rejectPromise(
            new InternalServerErrorException({
              message: 'Pipeline failed',
              code,
              details: stderr.trim().slice(-4000) || stdout.trim().slice(-4000),
            }),
          );
          return;
        }
        const text = stdout.trim();
        try {
          const result = (text ? JSON.parse(text) : {}) as PipelineCommandResult;
          this.datasets.reloadReal();
          resolvePromise(result);
        } catch {
          rejectPromise(
            new InternalServerErrorException({
              message: 'Pipeline returned invalid JSON',
              details: text.slice(-2000),
            }),
          );
        }
      });
    });
  }
}
