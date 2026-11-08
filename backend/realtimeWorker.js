const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const { SYNC_TABLES } = require('./syncConfig');
const { ensureRemoteSchema } = require('./remoteSchema');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Worker ini menyinkronkan perubahan antara PostgreSQL lokal dan Supabase.
const localPool = new Pool({
  connectionString: process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://imac@localhost:5432/znnpos',
  ssl: false
});

const remoteDatabaseUrl = process.env.REMOTE_DATABASE_URL || process.env.SUPABASE_DATABASE_URL;
const remotePool = remoteDatabaseUrl
  ? new Pool({ connectionString: remoteDatabaseUrl, ssl: { rejectUnauthorized: false }, max: 2 })
  : null;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Hash autentikasi hanya boleh dikelola oleh database lokal dan endpoint auth.
// Jangan kirim atau terapkan perubahan PIN melalui sinkronisasi data toko.
const isProtectedSettingChange = (table, payload, basePayload = null) => table === 'app_settings'
  && (payload?.key === 'admin_pin_hash' || basePayload?.key === 'admin_pin_hash');

const syncTable = async (io, table, eventType) => {
  io?.emit('database_changed', { table, eventType });
};

const quoteIdentifier = (identifier) => `"${identifier.replace(/"/g, '""')}"`;

const buildUpsertQuery = (table) => {
  const config = SYNC_TABLES[table];
  const columns = config.columns.map(quoteIdentifier);
  const updates = config.columns
    .filter((column) => column !== config.key)
    .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
    .join(', ');
  const placeholders = config.columns.map((_, index) => `$${index + 1}`).join(', ');
  return `INSERT INTO ${quoteIdentifier(table)} (${columns.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT (${quoteIdentifier(config.key)}) DO UPDATE SET ${updates}`;
};

const buildDeleteQuery = (table) => {
  const config = SYNC_TABLES[table];
  return `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(config.key)} = $1`;
};

const applyRemoteChangeLocally = async (query, params = [], storeId = 1) => {
  const client = await localPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('znnpos.sync_source', 'remote', true)");
    await client.query("SELECT set_config('znnkasir.store_id', $1, true)", [String(storeId || 1)]);
    await client.query(query, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const remoteUpsert = async (table, payload) => {
  if (!remotePool || !payload) return;
  if (isProtectedSettingChange(table, payload)) return;
  const config = SYNC_TABLES[table];
  if (!config) throw new Error(`Tabel sync tidak didukung: ${table}`);
  const values = config.columns.map((column) => payload[column] ?? (column === 'store_id' ? 1 : null));
  await remotePool.query(buildUpsertQuery(table), values);
};

const hydrateQueuePayload = async (item) => {
  const config = SYNC_TABLES[item.table_name];
  if (!config || !item.payload) return item.payload;
  const storeId = Number(item.payload.store_id || 1);
  const columns = config.columns.map(quoteIdentifier).join(', ');
  let result;

  if (item.table_name === 'app_settings' && !item.payload.id && item.payload.key) {
    result = await localPool.query(
      `SELECT ${columns} FROM "app_settings" WHERE "store_id" = $1 AND "key" = $2 LIMIT 1`,
      [storeId, item.payload.key]
    );
  } else if (item.payload[config.key] !== undefined && item.payload[config.key] !== null) {
    result = await localPool.query(
      `SELECT ${columns} FROM ${quoteIdentifier(item.table_name)} WHERE ${quoteIdentifier(config.key)} = $1 AND "store_id" = $2 LIMIT 1`,
      [item.payload[config.key], storeId]
    );
  }

  const current = result?.rows?.[0];
  return { ...(current || {}), ...item.payload, store_id: current?.store_id || storeId };
};

const ensureTransactionItemParents = async (payload) => {
  const storeId = Number(payload.store_id || 1);
  const transactionId = Number(payload.transaction_id);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    throw new Error('transaction_items tidak memiliki transaction_id yang valid');
  }

  const transactionResult = await localPool.query(
    `SELECT id, store_id, total, discount, vat, amount_paid, change, payment_method, payment_reference,
            status, voided_at, voided_by, void_reason, timestamp
     FROM "transactions" WHERE id = $1 AND store_id = $2 LIMIT 1`,
    [transactionId, storeId]
  );
  const transaction = transactionResult.rows[0];
  if (!transaction) throw new Error(`Transaksi induk ${transactionId} belum ditemukan di lokal`);
  await remoteUpsert('transactions', transaction);

  const productId = payload.product_id === null || payload.product_id === undefined ? null : Number(payload.product_id);
  if (productId) {
    const productResult = await localPool.query(
      `SELECT id, store_id, name, barcode, price, cost_price, category, stock, active
       FROM "products" WHERE id = $1 AND store_id = $2 LIMIT 1`,
      [productId, storeId]
    );
    const product = productResult.rows[0];
    if (!product) throw new Error(`Produk induk ${productId} belum ditemukan di lokal`);
    await remoteUpsert('products', product);
  }
};

const normalizedValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
};

const recordsMatch = (left, right, table) => {
  const columns = SYNC_TABLES[table]?.columns || [];
  return columns.every((column) => normalizedValue(left?.[column]) === normalizedValue(right?.[column]));
};

const ensureNoRemoteConflict = async (item) => {
  if (!remotePool || !item.payload) return;
  if (isProtectedSettingChange(item.table_name, item.payload, item.base_payload)) return;
  const config = SYNC_TABLES[item.table_name];
  if (!config) throw new Error(`Tabel sync tidak didukung: ${item.table_name}`);
  const key = config.key;
  const remote = await remotePool.query(
    `SELECT * FROM ${quoteIdentifier(item.table_name)} WHERE ${quoteIdentifier(key)} = $1`,
    [item.record_id]
  );
  const current = remote.rows[0];
  if (!current) {
    if (item.base_payload) {
      const error = new Error('Data online sudah tidak ada');
      error.code = 'SYNC_CONFLICT';
      throw error;
    }
    return;
  }
  if (recordsMatch(current, item.payload, item.table_name)) return;
  // Queue lama tidak memiliki base_payload. Untuk record yang sudah ada,
  // gunakan perubahan lokal sebagai sumber perubahan; cegah hanya bentrokan
  // ID produk yang menunjuk barcode berbeda.
  if (!item.base_payload) {
    if (item.table_name === 'products' && current.barcode !== item.payload.barcode) {
      const error = new Error('ID produk lokal menunjuk barcode berbeda di Supabase');
      error.code = 'SYNC_CONFLICT';
      throw error;
    }
    return;
  }
  if (item.base_payload && recordsMatch(current, item.base_payload, item.table_name)) return;
  const error = new Error('Data online berubah sejak perubahan lokal dibuat');
  error.code = 'SYNC_CONFLICT';
  throw error;
};

const processSyncQueue = async () => {
  if (!remotePool) return;
  const client = await localPool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, table_name, record_id, action, payload, base_payload
       FROM sync_queue
       WHERE status IN ('pending', 'failed')
          OR (status = 'conflict' AND base_payload IS NULL)
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED LIMIT 25`
    );
    for (const item of rows) {
      try {
        const payload = item.action === 'upsert' ? await hydrateQueuePayload(item) : item.payload;
        if (isProtectedSettingChange(item.table_name, payload, item.base_payload)) {
          await client.query(
            `UPDATE sync_queue SET status = 'synced', synced_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = $1`,
            [item.id]
          );
          continue;
        }
        await client.query("UPDATE sync_queue SET status = 'processing' WHERE id = $1", [item.id]);
        if (item.action === 'delete') {
          const config = SYNC_TABLES[item.table_name];
          if (!config) throw new Error(`Tabel sync tidak didukung: ${item.table_name}`);
          const key = config.key;
          if (item.base_payload) {
            const remote = await remotePool.query(
              `SELECT * FROM ${quoteIdentifier(item.table_name)} WHERE ${quoteIdentifier(key)} = $1`,
              [item.record_id]
            );
            if (remote.rows[0] && !recordsMatch(remote.rows[0], item.base_payload, item.table_name)) {
              const error = new Error('Data online berubah sebelum penghapusan lokal dikirim');
              error.code = 'SYNC_CONFLICT';
              throw error;
            }
          }
          await remotePool.query(buildDeleteQuery(item.table_name), [item.record_id]);
        } else {
          const syncItem = { ...item, payload };
          if (item.table_name === 'transaction_items') await ensureTransactionItemParents(payload);
          await ensureNoRemoteConflict(syncItem);
          await remoteUpsert(item.table_name, payload);
        }
        await client.query(
          `UPDATE sync_queue SET status = 'synced', synced_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = $1`,
          [item.id]
        );
      } catch (error) {
        await client.query(
          `UPDATE sync_queue SET status = $2, retry_count = retry_count + 1, last_error = $3 WHERE id = $1`,
          [item.id, error.code === 'SYNC_CONFLICT' ? 'conflict' : 'failed', error.message]
        );
        console.error(`❌ Gagal sync ${item.table_name}/${item.record_id}:`, error.message);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Gagal membaca sync queue:', error.message);
  } finally {
    client.release();
  }
};

const initRealtimeSync = (io) => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('⚠️ Realtime Supabase dinonaktifkan: SUPABASE_URL atau SUPABASE_ANON_KEY belum diatur.');
    return null;
  }

  if (!remotePool) {
    console.warn('⚠️ Sinkronisasi lokal ke Supabase belum aktif: REMOTE_DATABASE_URL atau SUPABASE_DATABASE_URL belum diatur.');
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  let syncTimer = null;
  let retryTimer = null;

  const subscribeToRemoteChanges = () => {
    Object.keys(SYNC_TABLES).forEach((table) => {
      supabase
        .channel(`${table}-sync`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, async (payload) => {
          const { eventType, new: newData, old: oldData } = payload;
          try {
            if (isProtectedSettingChange(table, newData, oldData)) return;
            if (eventType === 'INSERT' || eventType === 'UPDATE') {
              await applyRemoteChangeLocally(
                buildUpsertQuery(table),
                SYNC_TABLES[table].columns.map((column) => newData[column] ?? (column === 'store_id' ? 1 : null)),
                newData?.store_id || 1
              );
            } else if (eventType === 'DELETE') {
              await applyRemoteChangeLocally(
                buildDeleteQuery(table),
                [oldData[SYNC_TABLES[table].key]],
                oldData?.store_id || 1
              );
            }
            await syncTable(io, table, eventType);
            console.log(`✅ [Lokal ${table}] Diselaraskan: ${eventType}`);
          } catch (error) {
            console.error(`❌ Gagal sinkron tabel ${table}:`, error.message);
          }
        })
        .subscribe((status) => console.log(`📡 Supabase ${table}: ${status}`));
    });
  };

  const startSync = async () => {
    if (syncTimer) return;
    try {
      if (remotePool) {
        await ensureRemoteSchema(remotePool);
        console.log('✅ Skema database remote siap untuk sinkronisasi.');
      }
      console.log('🔄 Worker ZnnCashier aktif: mendengarkan perubahan Supabase...');
      subscribeToRemoteChanges();
      syncTimer = setInterval(processSyncQueue, 5000);
      syncTimer.unref?.();
      await processSyncQueue();
    } catch (error) {
      console.error('❌ Skema/sinkronisasi remote belum siap:', error.message);
    }
  };

  startSync();
  retryTimer = setInterval(() => startSync(), 30000);
  retryTimer.unref?.();

  return { supabase, syncTimer: retryTimer };
};

module.exports = { initRealtimeSync };
