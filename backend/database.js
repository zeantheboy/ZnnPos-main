// PostgreSQL adalah satu-satunya database yang digunakan saat aplikasi berjalan.
// SQLite hanya dipakai oleh utilitas migrasi legacy di migrate-sqlite-to-postgres.js.
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let dbInstance;
const storeContext = new AsyncLocalStorage();
const { SYNC_TABLES } = require('./syncConfig');

const TENANT_TABLES = Object.freeze([
  'users',
  'products',
  'transactions',
  'transaction_items',
  'app_settings',
  'suppliers',
  'customers',
  'shifts',
  'transaction_returns',
  'transaction_return_items',
  'held_transactions',
  'audit_logs',
  'stock_movements'
]);

const getCurrentStoreId = () => storeContext.getStore()?.storeId || null;
const withStoreContext = (storeId, callback) => storeContext.run({ storeId: Number(storeId) }, callback);

const quoteIdentifier = (identifier) => `"${identifier.replace(/"/g, '""')}"`;

const syncTriggerSql = Object.entries(SYNC_TABLES).map(([table, config]) => {
  const triggerName = `${table}_sync_trigger`;
  return `
    DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${quoteIdentifier(table)};
    CREATE TRIGGER ${quoteIdentifier(triggerName)}
      AFTER INSERT OR UPDATE OR DELETE ON ${quoteIdentifier(table)}
      FOR EACH ROW EXECUTE FUNCTION enqueue_sync_event('${config.key}');`;
}).join('\n');

function createPostgresDb(connectionString) {
  const { Pool } = require('pg');
  const isLocalPostgres = /localhost|127\.0\.0\.1/.test(new URL(connectionString).hostname);
  const pool = new Pool({
    connectionString,
    ssl: isLocalPostgres ? false : { rejectUnauthorized: false },
    max: 10
  });

  const localTimestamp = "(timestamp AT TIME ZONE 'Asia/Makassar')";
  const disableTenantSecuritySql = TENANT_TABLES.map((table) => `ALTER TABLE ${quoteIdentifier(table)} NO FORCE ROW LEVEL SECURITY; ALTER TABLE ${quoteIdentifier(table)} DISABLE ROW LEVEL SECURITY;`).join('\n');
  const tenantTriggerSql = TENANT_TABLES.map((table) => {
    const triggerName = `${table}_store_id_trigger`;
    return `
      DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${quoteIdentifier(table)};
      CREATE TRIGGER ${quoteIdentifier(triggerName)}
        BEFORE INSERT ON ${quoteIdentifier(table)}
        FOR EACH ROW EXECUTE FUNCTION assign_store_id();`;
  }).join('\n');
  const tenantPolicySql = TENANT_TABLES.map((table) => `
    ALTER TABLE ${quoteIdentifier(table)} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${quoteIdentifier(table)} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS ${quoteIdentifier(`${table}_store_isolation`)} ON ${quoteIdentifier(table)};
    CREATE POLICY ${quoteIdentifier(`${table}_store_isolation`)} ON ${quoteIdentifier(table)}
      USING (store_id = current_store_id())
      WITH CHECK (store_id = current_store_id());`).join('\n');
  const tenantTablePattern = TENANT_TABLES.join('|');
  const sqlKeywords = new Set(['WHERE', 'ORDER', 'GROUP', 'LIMIT', 'OFFSET', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'JOIN', 'ON', 'SET', 'VALUES', 'RETURNING', 'FOR', 'UNION', 'EXCEPT', 'FETCH', 'WINDOW']);
  const scopeTenantQuery = (query) => {
    let sql = query;
    const fromOrJoinPattern = new RegExp(`\\b(FROM|JOIN)\\s+(${tenantTablePattern})(?:\\s+(?:AS\\s+)?([a-z_][a-z0-9_]*))?`, 'gi');
    sql = sql.replace(fromOrJoinPattern, (match, keyword, table, possibleAlias, offset, wholeQuery) => {
      if (keyword.toUpperCase() === 'FROM' && /DELETE\s*$/i.test(wholeQuery.slice(Math.max(0, offset - 12), offset))) return match;
      const aliasIsKeyword = possibleAlias && sqlKeywords.has(String(possibleAlias).toUpperCase());
      const alias = aliasIsKeyword || !possibleAlias ? table : possibleAlias;
      const restoredKeyword = aliasIsKeyword ? ` ${possibleAlias}` : '';
      return `${keyword} (SELECT * FROM ${table} WHERE store_id = current_store_id()) AS ${alias}${restoredKeyword}`;
    });

    TENANT_TABLES.forEach((table) => {
      const updateWherePattern = new RegExp(`(\\bUPDATE\\s+${table}(?:\\s+(?:AS\\s+)?[a-z_][a-z0-9_]*)?\\s+SET[\\s\\S]*?\\bWHERE\\s+)`, 'i');
      const deleteWherePattern = new RegExp(`(\\bDELETE\\s+FROM\\s+${table}(?:\\s+(?:AS\\s+)?[a-z_][a-z0-9_]*)?\\s+WHERE\\s+)`, 'i');
      sql = sql.replace(updateWherePattern, '$1 store_id = current_store_id() AND ');
      sql = sql.replace(deleteWherePattern, '$1 store_id = current_store_id() AND ');
    });
    return sql;
  };
  const translateQuery = (query) => {
    let parameterIndex = 0;
    let translated = query
      .replace(/date\(timestamp, 'localtime'\)/g, `${localTimestamp}::date`)
      .replace(/date\('now', 'localtime', '-6 days'\)/g, `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date - INTERVAL '6 days'`)
      .replace(/date\('now', 'localtime'\)/g, `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar')::date`)
      .replace(/strftime\('%Y-%m', timestamp, 'localtime'\)/g, `TO_CHAR(${localTimestamp}, 'YYYY-MM')`)
      .replace(/strftime\('%Y-%m', 'now', 'localtime'\)/g, `TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar', 'YYYY-MM')`)
      .replace(/COLLATE NOCASE/gi, '')
      .replace(/\?/g, () => `$${++parameterIndex}`);
    return translated;
  };

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      license_key TEXT UNIQUE,
      user_limit INTEGER NOT NULL DEFAULT 3 CHECK (user_limit >= 1 AND user_limit <= 100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE stores ADD COLUMN IF NOT EXISTS user_limit INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_user_limit_check;
    ALTER TABLE stores ADD CONSTRAINT stores_user_limit_check CHECK (user_limit >= 1 AND user_limit <= 100);
    INSERT INTO stores (code, name, status)
    VALUES ('utama', 'Toko Utama', 'active')
    ON CONFLICT (code) DO NOTHING;
    CREATE TABLE IF NOT EXISTS store_devices (
      id BIGSERIAL PRIMARY KEY,
      store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      device_type TEXT NOT NULL DEFAULT 'cashier' CHECK (device_type IN ('cashier', 'scanner', 'tablet', 'other')),
      activation_code TEXT NOT NULL UNIQUE,
      device_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'revoked')),
      activated_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE store_devices ADD COLUMN IF NOT EXISTS device_id TEXT;
    UPDATE store_devices SET status = 'active' WHERE status = 'pending';
    CREATE UNIQUE INDEX IF NOT EXISTS store_devices_device_unique ON store_devices (device_id) WHERE device_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS store_devices_store_idx ON store_devices (store_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      barcode TEXT UNIQUE NOT NULL,
      price NUMERIC NOT NULL,
      cost_price NUMERIC NOT NULL DEFAULT 0,
      category TEXT,
      stock INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      total NUMERIC NOT NULL,
      discount NUMERIC DEFAULT 0,
      vat NUMERIC DEFAULT 0,
      amount_paid NUMERIC NOT NULL,
      change NUMERIC NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      payment_reference TEXT,
      timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    CREATE TABLE IF NOT EXISTS transaction_items (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER REFERENCES transactions(id),
      product_id INTEGER REFERENCES products(id),
      product_name TEXT,
      quantity INTEGER NOT NULL,
      price NUMERIC NOT NULL,
      cost_price NUMERIC NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'cashier')),
      is_platform_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id BIGINT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_id BIGINT;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_supplier_id_fkey') THEN
        ALTER TABLE products ADD CONSTRAINT products_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_customer_id_fkey') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS shifts (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      opening_cash NUMERIC NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
      closing_cash NUMERIC CHECK (closing_cash >= 0),
      expected_cash NUMERIC CHECK (expected_cash >= 0),
      variance NUMERIC,
      notes TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS shift_id BIGINT;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_user_id_fkey') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_shift_id_fkey') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_shift_id_fkey
          FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
      END IF;
    END $$;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_by INTEGER;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS void_reason TEXT;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_voided_by_fkey') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_voided_by_fkey
          FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
    ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('completed', 'voided'));
    CREATE TABLE IF NOT EXISTS transaction_returns (
      id BIGSERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      total_amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transaction_return_items (
      id BIGSERIAL PRIMARY KEY,
      return_id BIGINT NOT NULL REFERENCES transaction_returns(id) ON DELETE CASCADE,
      transaction_item_id INTEGER NOT NULL REFERENCES transaction_items(id) ON DELETE RESTRICT,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      price NUMERIC NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS held_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      before_data JSONB,
      after_data JSONB,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id BIGSERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      movement_type TEXT NOT NULL CHECK (movement_type IN ('initial', 'sale', 'stock_add', 'stock_subtract', 'stock_set', 'return', 'opname', 'adjustment')),
      quantity_change INTEGER NOT NULL,
      stock_before INTEGER NOT NULL,
      stock_after INTEGER NOT NULL,
      reason TEXT,
      reference_type TEXT,
      reference_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check
      CHECK (movement_type IN ('initial', 'sale', 'stock_add', 'stock_subtract', 'stock_set', 'return', 'opname', 'adjustment', 'void'));
    ${disableTenantSecuritySql}
    SELECT set_config('znnkasir.store_id', (SELECT id::text FROM stores WHERE code = 'utama' LIMIT 1), false);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE transaction_items ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE transaction_returns ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE transaction_return_items ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE held_transactions ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS id BIGSERIAL;
    CREATE OR REPLACE FUNCTION current_store_id()
    RETURNS BIGINT
    LANGUAGE SQL
    STABLE
    AS $$ SELECT NULLIF(current_setting('znnkasir.store_id', true), '')::BIGINT $$;
    CREATE OR REPLACE FUNCTION assign_store_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.store_id IS NULL THEN
        NEW.store_id := COALESCE(current_store_id(), (SELECT id FROM stores WHERE code = 'utama' LIMIT 1));
      END IF;
      IF NEW.store_id IS NULL THEN
        RAISE EXCEPTION 'Store belum ditentukan';
      END IF;
      RETURN NEW;
    END;
    $$;
    UPDATE users SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE users SET is_platform_admin = 1 WHERE role = 'super_admin' AND store_id = current_store_id();
    UPDATE suppliers SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE customers SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE products SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE transactions SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE transaction_items ti SET store_id = COALESCE(ti.store_id, t.store_id)
      FROM transactions t WHERE t.id = ti.transaction_id AND ti.store_id IS NULL;
    UPDATE transaction_items SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE app_settings SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE shifts s SET store_id = COALESCE(s.store_id, u.store_id)
      FROM users u WHERE u.id = s.user_id AND s.store_id IS NULL;
    UPDATE shifts SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE transaction_returns tr SET store_id = COALESCE(tr.store_id, t.store_id)
      FROM transactions t WHERE t.id = tr.transaction_id AND tr.store_id IS NULL;
    UPDATE transaction_returns SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE transaction_return_items tri SET store_id = COALESCE(tri.store_id, ti.store_id)
      FROM transaction_items ti WHERE ti.id = tri.transaction_item_id AND tri.store_id IS NULL;
    UPDATE transaction_return_items SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE held_transactions ht SET store_id = COALESCE(ht.store_id, u.store_id)
      FROM users u WHERE u.id = ht.user_id AND ht.store_id IS NULL;
    UPDATE held_transactions SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE audit_logs al SET store_id = COALESCE(al.store_id, u.store_id)
      FROM users u WHERE u.id = al.user_id AND al.store_id IS NULL;
    UPDATE audit_logs SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    UPDATE stock_movements sm SET store_id = COALESCE(sm.store_id, p.store_id)
      FROM products p WHERE p.id = sm.product_id AND sm.store_id IS NULL;
    UPDATE stock_movements SET store_id = COALESCE(store_id, current_store_id()) WHERE store_id IS NULL;
    ALTER TABLE users ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE products ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE transactions ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE transaction_items ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE app_settings ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE suppliers ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE customers ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE shifts ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE transaction_returns ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE transaction_return_items ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE held_transactions ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE audit_logs ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE stock_movements ALTER COLUMN store_id SET NOT NULL;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_key') THEN
        ALTER TABLE users DROP CONSTRAINT users_username_key;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_barcode_key') THEN
        ALTER TABLE products DROP CONSTRAINT products_barcode_key;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_pkey') THEN
        ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS users_store_username_unique ON users (store_id, username);
    CREATE UNIQUE INDEX IF NOT EXISTS products_store_barcode_unique ON products (store_id, barcode);
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_store_key_unique ON app_settings (store_id, key);
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_id_unique ON app_settings (id);
    CREATE INDEX IF NOT EXISTS users_store_idx ON users (store_id, active, username);
    CREATE INDEX IF NOT EXISTS products_store_idx ON products (store_id, active, name);
    CREATE INDEX IF NOT EXISTS transactions_store_idx ON transactions (store_id, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS suppliers_store_idx ON suppliers (store_id, active, name);
    CREATE INDEX IF NOT EXISTS customers_store_idx ON customers (store_id, active, name);
    ${tenantTriggerSql}
    CREATE INDEX IF NOT EXISTS users_active_idx ON users (active, username);
    CREATE INDEX IF NOT EXISTS suppliers_active_name_idx ON suppliers (active, name);
    CREATE INDEX IF NOT EXISTS customers_active_name_idx ON customers (active, name);
    CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone);
    CREATE INDEX IF NOT EXISTS products_supplier_idx ON products (supplier_id);
    CREATE INDEX IF NOT EXISTS transactions_customer_idx ON transactions (customer_id, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS shifts_user_status_idx ON shifts (user_id, status, opened_at DESC);
    CREATE INDEX IF NOT EXISTS shifts_opened_at_idx ON shifts (opened_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS transactions_shift_idx ON transactions (shift_id, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_status_timestamp_idx ON transactions (status, timestamp DESC);
    CREATE INDEX IF NOT EXISTS transaction_returns_transaction_idx ON transaction_returns (transaction_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS transaction_return_items_item_idx ON transaction_return_items (transaction_item_id);
    CREATE INDEX IF NOT EXISTS held_transactions_user_created_idx ON held_transactions (user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS stock_movements_created_at_idx ON stock_movements (created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS sync_queue (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
      payload JSONB,
      base_payload JSONB,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'synced', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      synced_at TIMESTAMPTZ
    );
    ALTER TABLE sync_queue ADD COLUMN IF NOT EXISTS base_payload JSONB;
    ALTER TABLE sync_queue DROP CONSTRAINT IF EXISTS sync_queue_status_check;
    ALTER TABLE sync_queue ADD CONSTRAINT sync_queue_status_check
      CHECK (status IN ('pending', 'processing', 'synced', 'failed', 'conflict'));
    CREATE INDEX IF NOT EXISTS sync_queue_pending_idx ON sync_queue (status, created_at, id);
    CREATE OR REPLACE FUNCTION enqueue_sync_event()
    RETURNS TRIGGER AS $$
    DECLARE
      event_record JSONB;
      base_record JSONB;
      event_id TEXT;
    BEGIN
      IF current_setting('znnpos.sync_source', true) = 'remote' THEN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END IF;
      event_record := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
      base_record := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
      event_id := event_record->>TG_ARGV[0];
      INSERT INTO sync_queue (table_name, record_id, action, payload, base_payload)
      VALUES (TG_TABLE_NAME, event_id, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
              CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE event_record END, base_record);
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    ${syncTriggerSql}
    CREATE SEQUENCE IF NOT EXISTS products_id_seq;
    CREATE SEQUENCE IF NOT EXISTS transactions_id_seq;
    CREATE SEQUENCE IF NOT EXISTS transaction_items_id_seq;
    ALTER TABLE products ALTER COLUMN id SET DEFAULT nextval('products_id_seq');
    ALTER TABLE transactions ALTER COLUMN id SET DEFAULT nextval('transactions_id_seq');
    ALTER TABLE transaction_items ALTER COLUMN id SET DEFAULT nextval('transaction_items_id_seq');
    ALTER SEQUENCE products_id_seq OWNED BY products.id;
    ALTER SEQUENCE transactions_id_seq OWNED BY transactions.id;
    ALTER SEQUENCE transaction_items_id_seq OWNED BY transaction_items.id;
    SELECT setval('products_id_seq', COALESCE((SELECT MAX(id) FROM products), 0) + 1, false);
    SELECT setval('transactions_id_seq', COALESCE((SELECT MAX(id) FROM transactions), 0) + 1, false);
    SELECT setval('transaction_items_id_seq', COALESCE((SELECT MAX(id) FROM transaction_items), 0) + 1, false);
    ${tenantPolicySql}
    SELECT set_config('znnkasir.store_id', '', false);
  `);

  const executeQuery = async (client, query, params, mode) => {
    let sql = scopeTenantQuery(translateQuery(query));
    const needsId = mode === 'run' && /^\s*INSERT INTO (products|transactions|transaction_items|users|audit_logs)/i.test(query);
    if (needsId && !/RETURNING/i.test(sql)) sql += ' RETURNING id';
    const result = await client.query(sql, params);
    return { result, row: result.rows[0] };
  };

  const execute = (query, params, callback, mode) => {
    ready.then(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const storeId = getCurrentStoreId();
        if (storeId) await client.query("SELECT set_config('znnkasir.store_id', $1, true)", [String(storeId)]);
        const { result, row } = await executeQuery(client, query, params, mode);
        await client.query('COMMIT');
        if (mode === 'get') callback(null, row);
        else if (mode === 'all') callback(null, result.rows);
        else callback.call({ lastID: row?.id, changes: result.rowCount }, null);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        callback(error);
      } finally {
        client.release();
      }
    }).catch((err) => callback(err));
  };

  return {
    ready,
    run(query, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      execute(query, params || [], callback || (() => {}), 'run');
    },
    get(query, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      execute(query, params || [], callback, 'get');
    },
    all(query, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      execute(query, params || [], callback, 'all');
    },
    async transaction(work) {
      await ready;
      const client = await pool.connect();
      const transactionDb = {
        async setStoreContext(storeId) {
          await client.query("SELECT set_config('znnkasir.store_id', $1, true)", [String(storeId)]);
        },
        async run(query, params = []) {
          const { result, row } = await executeQuery(client, query, params, 'run');
          return { lastID: row?.id, changes: result.rowCount };
        },
        async get(query, params = []) {
          const { row } = await executeQuery(client, query, params, 'get');
          return row;
        },
        async all(query, params = []) {
          const { result } = await executeQuery(client, query, params, 'all');
          return result.rows;
        }
      };

      try {
        await client.query('BEGIN');
        const storeId = getCurrentStoreId();
        if (storeId) await client.query("SELECT set_config('znnkasir.store_id', $1, true)", [String(storeId)]);
        const result = await work(transactionDb);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

function initDb() {
  const databaseUrl = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://imac@localhost:5432/znnpos';
  dbInstance = createPostgresDb(databaseUrl);
  console.log('Connecting to PostgreSQL database (runtime)');
  return dbInstance;
}

function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized');
  }
  return dbInstance;
}

module.exports = { initDb, getDb, getCurrentStoreId, withStoreContext };
