/**
 * Minimal in-memory stand-in for the TypeORM `Repository` surface used by the
 * referral services. It keeps the integration tests focused on behaviour
 * (generation, attribution, rewards, duplicate handling) without requiring a
 * PostgreSQL instance or a live backend process.
 *
 * Only the methods the referral services actually call are implemented.
 */

import { randomUUID } from "crypto";

type Where<T> = Partial<Record<keyof T, unknown>>;

export interface FindOptions<T> {
  where?: Where<T> | Where<T>[];
  relations?: string[];
  order?: Partial<Record<keyof T, "ASC" | "DESC">>;
}

export class InMemoryRepository<T extends Record<string, any>> {
  readonly rows: T[] = [];

  /**
   * Attach related rows (referral code, user, ...) the way TypeORM's
   * `relations` option would.
   */
  hydrate?: (row: T) => T;

  /** Column defaults TypeORM would normally supply on insert. */
  constructor(private readonly defaults: Partial<T> = {}) {}

  private matches(row: T, where?: Where<T> | Where<T>[]): boolean {
    if (!where) return true;
    const clauses = Array.isArray(where) ? where : [where];
    return clauses.some((clause) =>
      Object.entries(clause).every(([field, value]) => row[field] === value),
    );
  }

  private present(row: T): T {
    const copy = { ...row };
    return this.hydrate ? this.hydrate(copy) : copy;
  }

  async findOne(options: FindOptions<T> = {}): Promise<T | null> {
    const row = this.rows.find((candidate) => this.matches(candidate, options.where));
    return row ? this.present(row) : null;
  }

  async find(options: FindOptions<T> = {}): Promise<T[]> {
    let rows = this.rows.filter((row) => this.matches(row, options.where));
    const [field, direction] = Object.entries(options.order ?? {})[0] ?? [];
    if (field && direction) {
      rows = [...rows].sort((a, b) => {
        const left = a[field] instanceof Date ? a[field].getTime() : a[field];
        const right = b[field] instanceof Date ? b[field].getTime() : b[field];
        const order = left === right ? 0 : left > right ? 1 : -1;
        return direction === "DESC" ? -order : order;
      });
    }
    return rows.map((row) => this.present(row));
  }

  create(data: Partial<T>): T {
    return { createdAt: new Date(), ...this.defaults, ...data } as T;
  }

  async save(entity: T): Promise<T> {
    const stored = { ...entity };
    if (!stored.id) {
      stored.id = randomUUID();
    }
    const index = this.rows.findIndex((row) => row.id === stored.id);
    if (index === -1) {
      this.rows.push(stored);
    } else {
      this.rows[index] = stored;
    }
    return this.present(stored);
  }

  /**
   * TypeORM allows SQL expressions in `update`, which `updateStats` relies on
   * (`totalInvites + 1`). Interpret the small subset the services produce.
   */
  async update(id: string, patch: Record<string, any>): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return;

    for (const [field, value] of Object.entries(patch)) {
      if (typeof value !== "function") {
        row[field] = value;
        continue;
      }

      const expression = String(value());
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(
        expression,
      );
      if (!match) {
        throw new Error(`Unsupported update expression: ${expression}`);
      }
      const [, source, operator, rawAmount] = match;
      const amount = Number(rawAmount) * (operator === "-" ? -1 : 1);
      row[field] = Number(row[source] ?? 0) + amount;
    }
  }

  async count(): Promise<number> {
    return this.rows.length;
  }
}
