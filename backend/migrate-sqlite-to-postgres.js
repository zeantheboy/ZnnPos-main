/*
 * Utilitas migrasi satu kali dari SQLite lama ke PostgreSQL.
 * Script ini bukan jalur database runtime ZnnCashier.
 * Gunakan SOURCE_DB dan TARGET_DATABASE_URL; jangan commit URL database.
 */
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const targetDatabaseUrl = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;

if (!targetDatabaseUrl) {
  console.error('TARGET_DATABASE_URL belum diatur.');
  process.exit(1);
}

const sourceCandidates = [
  process.env.SOURCE_DB,
  path.join(process.env.HOME || '', 'Library/Application Support/swiftpos/pos.db'),
  path.join(process.env.HOME || '', 'Library/Application Support/znnpos/pos.db'),
  path.join(__dirname, 'pos.db')
].filter(Boolean);
const sourceDbPath = sourceCandidates.find((candidate) => fs.existsSync(candidate));

if (!sourceDbPath) {
  console.error('Database SQLite sumber tidak ditemukan. Gunakan SOURCE_DB=/path/ke/pos.db.');
  process.exit(1);
}

console.log(`Membaca database SQLite: ${sourceDbPath}`);
const sqlite = new sqlite3.Database(sourceDbPath);
const client = new Client({ connectionString: targetDatabaseUrl, ssl: { rejectUnauthorized: false } });

const all = (query, params = []) => new Promise((resolve, reject) => sqlite.all(query, params, (err, rows) => err ? reject(err) : resolve(rows)));
const run = (query, params = []) => new Promise((resolve, reject) => sqlite.run(query, params, function(err) { err ? reject(err) : resolve(this); }));
const tableExists = async (tableName) => {
  const rows = await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return rows.length > 0;
};

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE NOT NULL,
      price NUMERIC NOT NULL, cost_price NUMERIC NOT NULL DEFAULT 0,
      category TEXT, stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY, total NUMERIC NOT NULL, discount NUMERIC DEFAULT 0,
      vat NUMERIC DEFAULT 0, amount_paid NUMERIC NOT NULL, change NUMERIC NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transaction_items (
      id INTEGER PRIMARY KEY, transaction_id INTEGER, product_id INTEGER,
      product_name TEXT, quantity INTEGER NOT NULL, price NUMERIC NOT NULL,
      cost_price NUMERIC NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const productColumns = new Set((await all('PRAGMA table_info(products)')).map((column) => column.name));
  const itemColumns = new Set((await all('PRAGMA table_info(transaction_items)')).map((column) => column.name));
  const productCost = productColumns.has('cost_price') ? 'cost_price' : '0 AS cost_price';
  const productActive = productColumns.has('active') ? 'active' : '1 AS active';
  const itemName = itemColumns.has('product_name') ? "COALESCE(ti.product_name, p.name, 'Item kustom') AS product_name" : "COALESCE(p.name, 'Item kustom') AS product_name";
  const itemCost = itemColumns.has('cost_price') ? 'ti.cost_price' : '0 AS cost_price';
  const products = await all(`SELECT id, name, barcode, price, ${productCost}, category, stock, ${productActive} FROM products`);
  const transactions = await all('SELECT id, total, discount, vat, amount_paid, change, timestamp FROM transactions');
  const items = await all(`SELECT ti.id, ti.transaction_id, ti.product_id, ${itemName}, ti.quantity, ti.price, ${itemCost} FROM transaction_items ti LEFT JOIN products p ON p.id = ti.product_id`);
  // app_settings belum ada pada beberapa database SQLite lama.
  // Pengaturan akan dibuat oleh PostgreSQL, tetapi tidak ada data yang perlu disalin.
  const settings = (await tableExists('app_settings'))
    ? await all('SELECT key, value FROM app_settings')
    : [];

  await client.query('BEGIN');
  for (const p of products) await client.query(
    `INSERT INTO products (id,name,barcode,price,cost_price,category,stock,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, barcode=EXCLUDED.barcode, price=EXCLUDED.price,
     cost_price=EXCLUDED.cost_price, category=EXCLUDED.category, stock=EXCLUDED.stock, active=EXCLUDED.active`,
    [p.id, p.name, p.barcode, p.price, p.cost_price || 0, p.category, p.stock, p.active ?? 1]
  );
  for (const t of transactions) await client.query(
    `INSERT INTO transactions (id,total,discount,vat,amount_paid,change,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [t.id, t.total, t.discount || 0, t.vat || 0, t.amount_paid, t.change, t.timestamp]
  );
  for (const item of items) await client.query(
    `INSERT INTO transaction_items (id,transaction_id,product_id,product_name,quantity,price,cost_price) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [
      item.id,
      item.transaction_id,
      Number.isInteger(Number(item.product_id)) ? Number(item.product_id) : null,
      item.product_name,
      item.quantity,
      item.price,
      item.cost_price || 0
    ]
  );
  for (const setting of settings) await client.query(
    `INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [setting.key, setting.value]
  );
  await client.query(`SELECT setval(pg_get_serial_sequence('products','id'), COALESCE((SELECT MAX(id) FROM products), 1), true)`);
  await client.query(`SELECT setval(pg_get_serial_sequence('transactions','id'), COALESCE((SELECT MAX(id) FROM transactions), 1), true)`);
  await client.query(`SELECT setval(pg_get_serial_sequence('transaction_items','id'), COALESCE((SELECT MAX(id) FROM transaction_items), 1), true)`);
  await client.query('COMMIT');
  console.log(`Migrasi selesai: ${products.length} produk, ${transactions.length} transaksi, ${items.length} item transaksi.`);
}

main().catch(async (error) => {
  try { await client.query('ROLLBACK'); } catch {}
  console.error('Migrasi gagal:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  sqlite.close();
  await client.end().catch(() => {});
});
