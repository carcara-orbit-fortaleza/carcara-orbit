/**
 * Orçamento diário de tokens em memória, zera a cada dia UTC.
 * Vale para UMA instância: com réplicas, cada uma tem seu contador
 * (o teto efetivo é N × orçamento). Reinício do processo zera o contador.
 */
export class DailyTokenBudget {
  private day: string;
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = this.today();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const t = this.today();
    if (t !== this.day) {
      this.day = t;
      this.used = 0;
    }
  }

  get spent(): number {
    this.roll();
    return this.used;
  }

  /** Reserva o pior caso antes da chamada; retorna false se estouraria o teto. */
  reserve(tokens: number): boolean {
    this.roll();
    if (this.used >= this.limit || this.used + tokens > this.limit) return false;
    this.used += tokens;
    return true;
  }

  /** Troca a reserva pelo consumo real (0 quando a chamada falhou antes de gastar). */
  settle(reserved: number, actual: number): void {
    this.roll();
    this.used = Math.max(0, this.used - reserved + actual);
  }
}

export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;

export function parseBudget(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_TOKEN_BUDGET;
}

export const DEFAULT_DAILY_TOKEN_BUDGET_PER_IP = Math.floor(DEFAULT_DAILY_TOKEN_BUDGET / 10);
export const MAX_TRACKED_IPS = 5_000;

/** Padrão: ~1/10 do orçamento global (nunca acima dele). */
export function parseIpBudget(raw: string | undefined, globalLimit: number): number {
  const n = Number(raw);
  const v = raw && Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.floor(globalLimit / 10);
  return Math.max(1, Math.min(v, globalLimit));
}

/**
 * Orçamento diário por IP, em memória. O mapa é limitado a `maxKeys`: ao encher, descarta o IP
 * usado há mais tempo (LRU), então a memória não cresce sem limite. Zera a cada dia UTC.
 */
export class PerIpDailyBudget {
  private day: string;
  private readonly used = new Map<string, number>();

  constructor(
    readonly limit: number,
    private readonly maxKeys: number = MAX_TRACKED_IPS,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = this.today();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const t = this.today();
    if (t !== this.day) {
      this.day = t;
      this.used.clear();
    }
  }

  get size(): number {
    return this.used.size;
  }

  spent(ip: string): number {
    this.roll();
    return this.used.get(ip) ?? 0;
  }

  private put(ip: string, value: number): void {
    this.used.delete(ip); // reinsere no fim: ordem de inserção = ordem de uso
    this.used.set(ip, value);
    while (this.used.size > this.maxKeys) {
      const oldest = this.used.keys().next().value;
      if (oldest === undefined) break;
      this.used.delete(oldest);
    }
  }

  reserve(ip: string, tokens: number): boolean {
    this.roll();
    const cur = this.used.get(ip) ?? 0;
    if (cur >= this.limit || cur + tokens > this.limit) return false;
    this.put(ip, cur + tokens);
    return true;
  }

  settle(ip: string, reserved: number, actual: number): void {
    this.roll();
    this.put(ip, Math.max(0, (this.used.get(ip) ?? 0) - reserved + actual));
  }
}
