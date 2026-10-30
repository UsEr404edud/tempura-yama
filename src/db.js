/**
 * Camada de acesso a dados.
 *
 * - Em produção (Render + banco Postgres) usa `DATABASE_URL`.
 * - Sem `DATABASE_URL`, usa SQLite nativo do Node (node:sqlite), com o arquivo
 *   em `DATA_DIR` (padrão: ./data/tempura.db). Isso mantém o projeto simples
 *   para rodar localmente e em ambientes de avaliação.
 *
 * As consultas usam `?` como placeholder; para o Postgres elas são convertidas
 * automaticamente para `$1, $2, ...`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { categories, products } from './seed.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const isPostgres = Boolean(DATABASE_URL);

/** @type {import('node:sqlite').DatabaseSync | null} */
let sqlite = null;
/** @type {import('pg').Pool | null} */
let pool = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🍤',
  prep_minutes INTEGER NOT NULL DEFAULT 8,
  available INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  table_number TEXT,
  payment_method TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'recebido',
  subtotal_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT,
  name TEXT NOT NULL,
  emoji TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

function toPgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function pgSslConfig(url) {
  if (process.env.PGSSL === 'disable') return undefined;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  try {
    const { hostname } = new URL(url);
    // Postgres interno do Render não usa domínio público (ex.: dpg-xxxx-a)
    // e não aceita SSL. Conexões externas usam SSL.
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.internal') ||
      !hostname.includes('.')
    ) {
      return undefined;
    }
  } catch {
    /* deixa o driver validar a URL */
  }
  return { rejectUnauthorized: false };
}

/** Normaliza parâmetros para tipos aceitos pelos dois drivers. */
function normalizeParam(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/** Executa uma consulta e devolve as linhas. */
export async function query(sql, params = []) {
  const values = params.map(normalizeParam);
  if (isPostgres) {
    const result = await pool.query(toPgSql(sql), values);
    return result.rows;
  }
  return sqlite.prepare(sql).all(...values);
}

/** Executa uma consulta e devolve a primeira linha (ou null). */
export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/** Executa uma escrita e devolve o número de linhas afetadas. */
export async function execute(sql, params = []) {
  const values = params.map(normalizeParam);
  if (isPostgres) {
    const result = await pool.query(toPgSql(sql), values);
    return result.rowCount;
  }
  return sqlite.prepare(sql).run(...values).changes;
}

/** Fila que serializa transações no SQLite (o driver é síncrono e usa uma única conexão). */
let sqliteTxQueue = Promise.resolve();

/**
 * Executa `fn` dentro de uma transação.
 * `fn` recebe as funções de consulta já vinculadas à transação.
 */
export function transaction(fn) {
  if (isPostgres) {
    return postgresTransaction(fn);
  }
  const run = () => sqliteTransaction(fn);
  const result = sqliteTxQueue.then(run, run);
  sqliteTxQueue = result.catch(() => {});
  return result;
}

async function postgresTransaction(fn) {
  const client = await pool.connect();
  const tx = {
    query: async (sql, params = []) =>
      (await client.query(toPgSql(sql), params.map(normalizeParam))).rows,
    one: async (sql, params = []) => {
      const rows = await tx.query(sql, params);
      return rows[0] ?? null;
    },
    execute: async (sql, params = []) =>
      (await client.query(toPgSql(sql), params.map(normalizeParam))).rowCount,
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function sqliteTransaction(fn) {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn({ query, one, execute });
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

async function seed() {
  for (const category of categories) {
    await execute(
      `INSERT INTO categories (id, name, tagline, sort_order) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name,
         tagline = excluded.tagline,
         sort_order = excluded.sort_order`,
      [category.id, category.name, category.tagline, category.sortOrder],
    );
  }

  for (const product of products) {
    await execute(
      `INSERT INTO products
         (id, category_id, name, description, price_cents, emoji, prep_minutes, available, featured, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         category_id = excluded.category_id,
         name = excluded.name,
         description = excluded.description,
         price_cents = excluded.price_cents,
         emoji = excluded.emoji,
         prep_minutes = excluded.prep_minutes,
         featured = excluded.featured,
         sort_order = excluded.sort_order`,
      [
        product.id,
        product.categoryId,
        product.name,
        product.description,
        product.priceCents,
        product.emoji,
        product.prepMinutes,
        product.available === false ? 0 : 1,
        product.featured ? 1 : 0,
        product.sortOrder ?? 0,
      ],
    );
  }
}

export async function initDatabase() {
  if (isPostgres) {
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: pgSslConfig(DATABASE_URL),
      max: Number(process.env.PGPOOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => {
      console.error('[db] erro inesperado no pool do Postgres:', error.message);
    });
    await pool.query('SELECT 1');
  } else {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    sqlite = new DatabaseSync(path.join(dataDir, 'tempura.db'));
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA foreign_keys = ON;');
    sqlite.exec('PRAGMA busy_timeout = 5000;');
  }

  // Executa o schema comando por comando (compatível com os dois bancos).
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim()) {
      if (isPostgres) await pool.query(statement);
      else sqlite.exec(statement);
    }
  }

  await seed();
  console.log(`[db] conectado (${isPostgres ? 'PostgreSQL' : 'SQLite'}) e pronto.`);
}

export function databaseKind() {
  return isPostgres ? 'postgres' : 'sqlite';
}

export async function closeDatabase() {
  if (isPostgres) await pool?.end();
  else sqlite?.close();
}
