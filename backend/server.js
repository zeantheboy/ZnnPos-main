const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const { initDb, getDb, withStoreContext } = require('./database');
const { initRealtimeSync } = require('./realtimeWorker');
const { PAYMENT_METHODS, roundMoney, calculateCheckoutTotals } = require('./checkoutRules');

const app = express();
const server = http.createServer(app);

const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const isPrivateIpv4 = (hostname) => {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (configuredCorsOrigins.includes(origin)) return true;
  if (process.env.ALLOW_LOCAL_ORIGINS === 'false') return false;

  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || isPrivateIpv4(url.hostname);
  } catch {
    return false;
  }
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origin tidak diizinkan'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
};

const io = new Server(server, {
  cors: corsOptions
});

app.use(cors(corsOptions));
app.use(express.json());

// Saat frontend sudah dibuild, backend HTTPS juga menyajikan dashboard mobile.
// Dengan demikian HP dapat membuka POS dan kamera pada origin HTTPS yang sama.
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

app.get('/', (req, res) => {
  const frontendIndex = path.join(frontendDist, 'index.html');
  if (require('fs').existsSync(frontendIndex)) {
    return res.sendFile(frontendIndex);
  }
  res.json({
    name: 'ZnnCashier API',
    status: 'running',
    endpoints: [
      '/api/products',
      '/api/products/:barcode',
      '/api/checkout',
      '/api/stats',
      '/scanner'
    ]
  });
});

// Serve static files for the mobile scanner
app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

// Fallback untuk refresh langsung pada route React dari HP.
app.get(/^\/(?!api(?:\/|$)|scanner(?:\/|$)).*/, (req, res, next) => {
  const frontendIndex = path.join(frontendDist, 'index.html');
  if (require('fs').existsSync(frontendIndex)) return res.sendFile(frontendIndex);
  next();
});

const normalizeSocketChannel = (value) => {
  const channel = String(value || '').trim();
  return /^[a-z0-9-]{8,80}$/i.test(channel) ? channel : null;
};

io.use((socket, next) => {
  const role = socket.handshake.auth?.role;
  const channel = normalizeSocketChannel(socket.handshake.auth?.channel);
  if (!['pos', 'scanner'].includes(role) || !channel) {
    return next(new Error('Sesi scanner tidak valid'));
  }
  const session = role === 'pos'
    ? getStoredAuthSession(String(socket.handshake.auth?.sessionToken || ''))
    : null;
  if (role === 'pos' && !session) return next(new Error('Login POS diperlukan'));
  const storeId = Number(session?.user?.storeId || socket.handshake.auth?.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) return next(new Error('Toko scanner tidak valid'));
  socket.data.role = role;
  socket.data.channel = channel;
  socket.data.storeId = storeId;
  socket.data.user = session?.user || null;
  return next();
});

// Socket.IO for real-time barcode scanning. Every POS/scanner pair has its own room.
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const room = `scanner:${socket.data.storeId}:${socket.data.channel}`;
  socket.join(room);

  socket.on('barcode_scanned', (data) => {
    if (socket.data.role !== 'scanner') return;
    const barcode = String(data?.barcode || '').trim();
    if (!barcode || barcode.length > 128) return;
    console.log('Barcode scanned via mobile:', data.barcode);
    io.to(room).emit('pos_barcode', {
      barcode,
      timestamp: new Date().toISOString(),
      channel: socket.data.channel
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// REST API
// GET all products
app.get('/api/products', requireRole(['super_admin', 'admin', 'cashier']), (req, res) => {
  const status = req.query.status === 'archived' ? 0 : 1;
  getDb().all('SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.active = ? ORDER BY p.name COLLATE NOCASE', [status], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET product by barcode
app.get('/api/products/:barcode', requireRole(['super_admin', 'admin', 'cashier']), (req, res) => {
  getDb().get('SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.barcode = ? AND p.active = 1', [req.params.barcode], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  });
});

// Penghapusan massal hanya boleh dilakukan oleh Super Admin toko yang sedang aktif.
// Produk yang memiliki riwayat transaksi diarsipkan agar laporan lama tetap aman;
// produk tanpa riwayat transaksi dapat dihapus permanen.
app.post('/api/products/bulk-delete', requireRole(['super_admin']), async (req, res) => {
  const deleteAll = req.body?.all === true;
  const rawProductIds = Array.isArray(req.body?.product_ids) ? req.body.product_ids : [];
  const productIds = [...new Set(rawProductIds.map(parsePositiveId).filter(Boolean))];
  const confirmation = String(req.body?.confirmation || '').trim();
  const pin = String(req.body?.pin || '');

  if (!deleteAll && productIds.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal satu produk' });
  }
  if (deleteAll && confirmation !== 'HAPUS SEMUA') {
    return res.status(400).json({ error: 'Konfirmasi penghapusan semua produk tidak sesuai' });
  }
  if (!/^\d{4,12}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN Super Admin wajib diisi' });
  }

  try {
    const currentUser = await getDbRow('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const legacyPinHash = await getSetting('admin_pin_hash');
    const validAccountPin = currentUser && verifyAdminPin(pin, currentUser.password_hash);
    const validLegacyPin = legacyPinHash && verifyAdminPin(pin, legacyPinHash);
    if (!currentUser || (!validAccountPin && !validLegacyPin)) {
      return res.status(401).json({ error: 'PIN Super Admin salah' });
    }

    const result = await getDb().transaction(async (database) => {
      const products = deleteAll
        ? await database.all('SELECT id, name FROM products WHERE active = 1 ORDER BY id')
        : await database.all(
          `SELECT id, name FROM products WHERE active = 1 AND id IN (${productIds.map(() => '?').join(', ')}) ORDER BY id`,
          productIds
        );

      if (products.length === 0) throw checkoutError('Tidak ada produk aktif yang dapat diproses', 404);

      const archived = [];
      const deleted = [];
      for (const product of products) {
        const usage = await database.get('SELECT COUNT(*)::int AS total FROM transaction_items WHERE product_id = ?', [product.id]);
        if (Number(usage?.total || 0) > 0) {
          await database.run('UPDATE products SET active = 0 WHERE id = ? AND active = 1', [product.id]);
          archived.push(product.name);
        } else {
          await database.run('DELETE FROM products WHERE id = ? AND active = 1', [product.id]);
          deleted.push(product.name);
        }
      }

      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?)',
        [
          req.user.id,
          'bulk_delete',
          'product',
          deleteAll ? 'all-active' : 'selected',
          JSON.stringify({ scope: deleteAll ? 'all' : 'selected', requestedCount: products.length, archivedCount: archived.length, deletedCount: deleted.length }),
          deleteAll ? 'Penghapusan semua produk aktif oleh Super Admin' : 'Penghapusan produk terpilih oleh Super Admin'
        ]
      );

      return { processedCount: products.length, archived, deleted };
    });

    return res.json({
      success: true,
      scope: deleteAll ? 'all' : 'selected',
      processedCount: result.processedCount,
      archivedCount: result.archived.length,
      deletedCount: result.deleted.length,
      archived: result.archived,
      deleted: result.deleted
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/products/:id/stock-movements', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const productId = Number(req.params.id);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size, 10) || 20));
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ error: 'ID produk tidak valid' });
  }

  try {
    const database = getDb();
    const offset = (page - 1) * pageSize;
    const [count, movements] = await Promise.all([
      getDbRow('SELECT COUNT(*)::int AS total FROM stock_movements WHERE product_id = ?', [productId]),
      allDbRows(
        `SELECT sm.id, sm.product_id, p.name AS product_name, sm.user_id, u.username,
                sm.movement_type, sm.quantity_change, sm.stock_before, sm.stock_after,
                sm.reason, sm.reference_type, sm.reference_id, sm.created_at
         FROM stock_movements sm
         LEFT JOIN products p ON p.id = sm.product_id
         LEFT JOIN users u ON u.id = sm.user_id
         WHERE sm.product_id = ?
         ORDER BY sm.created_at DESC, sm.id DESC
         LIMIT ? OFFSET ?`,
        [productId, pageSize, offset]
      )
    ]);
    const total = Number(count?.total || 0);
    return res.json({
      items: movements,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total ? Math.ceil(total / pageSize) : 0
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const getSetting = (key) => new Promise((resolve, reject) => {
  getDb().get('SELECT value FROM app_settings WHERE store_id = current_store_id() AND key = ?', [key], (err, row) => {
    if (err) return reject(err);
    resolve(row?.value || null);
  });
});

const saveSetting = (key, value) => new Promise((resolve, reject) => {
  getDb().run(
    'INSERT INTO app_settings (store_id, key, value) VALUES (current_store_id(), ?, ?) ON CONFLICT (store_id, key) DO UPDATE SET value = excluded.value',
    [key, value],
    (err) => err ? reject(err) : resolve()
  );
});

const hashAdminPin = (pin) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyAdminPin = (pin, storedHash) => {
  try {
    if (!storedHash || typeof pin !== 'string') return false;
    const [salt, hash] = String(storedHash).split(':');
    if (!salt || !hash || !/^[a-f0-9]+$/i.test(hash) || hash.length !== 128) return false;
    const actual = crypto.scryptSync(pin, salt, 64).toString('hex');
    const actualBuffer = Buffer.from(actual, 'hex');
    const storedBuffer = Buffer.from(hash, 'hex');
    if (actualBuffer.length !== storedBuffer.length) return false;
    return crypto.timingSafeEqual(actualBuffer, storedBuffer);
  } catch {
    return false;
  }
};

const runDb = (query, params = []) => new Promise((resolve, reject) => {
  getDb().run(query, params, function onRun(error) {
    if (error) return reject(error);
    return resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const getDbRow = (query, params = []) => new Promise((resolve, reject) => {
  getDb().get(query, params, (error, row) => error ? reject(error) : resolve(row || null));
});

const allDbRows = (query, params = []) => new Promise((resolve, reject) => {
  getDb().all(query, params, (error, rows) => error ? reject(error) : resolve(rows || []));
});

const SALES_RETENTION_MONTHS = 2;
const SALES_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let salesCleanupInProgress = null;

const getMakassarDateParts = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  return parts.reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
};

const cleanupOldSalesIfDue = async () => {
  const dateParts = getMakassarDateParts();
  if (salesCleanupInProgress) return salesCleanupInProgress;

  salesCleanupInProgress = (async () => {
    const currentPeriod = `${dateParts.year}-${dateParts.month}`;
    const stores = await allDbRows('SELECT id, code FROM stores ORDER BY id');
    const cutoffExpression = `((date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Makassar') - INTERVAL '${SALES_RETENTION_MONTHS} months') AT TIME ZONE 'Asia/Makassar')`;
    let deletedTransactions = 0;

    for (const store of stores) {
      const result = await withStoreContext(Number(store.id), () => getDb().transaction(async (database) => {
        const lastCleanup = await database.get(
          'SELECT value FROM app_settings WHERE key = ?',
          ['sales_cleanup_period']
        );
        if (lastCleanup?.value === currentPeriod) return { skipped: true, deletedTransactions: 0 };

        const oldSales = await database.get(
          `SELECT COUNT(*)::int AS total FROM transactions WHERE timestamp < ${cutoffExpression}`
        );
        const oldTransactionCount = Number(oldSales?.total || 0);

        if (oldTransactionCount > 0) {
          await database.run(
            `DELETE FROM stock_movements
             WHERE (reference_type IN ('transaction', 'transaction_void')
                    AND reference_id IN (SELECT id::text FROM transactions WHERE timestamp < ${cutoffExpression}))
                OR (reference_type = 'transaction_return'
                    AND reference_id IN (
                      SELECT id::text FROM transaction_returns
                      WHERE transaction_id IN (SELECT id FROM transactions WHERE timestamp < ${cutoffExpression})
                    ))`
          );
          await database.run(
            `DELETE FROM audit_logs
             WHERE entity = 'transaction'
               AND entity_id IN (SELECT id::text FROM transactions WHERE timestamp < ${cutoffExpression})`
          );
          await database.run(
            `DELETE FROM transaction_return_items
             WHERE return_id IN (
                     SELECT id FROM transaction_returns
                     WHERE transaction_id IN (SELECT id FROM transactions WHERE timestamp < ${cutoffExpression})
                   )
                OR transaction_item_id IN (
                     SELECT id FROM transaction_items
                     WHERE transaction_id IN (SELECT id FROM transactions WHERE timestamp < ${cutoffExpression})
                   )`
          );
          await database.run(
            `DELETE FROM transaction_returns
             WHERE transaction_id IN (SELECT id FROM transactions WHERE timestamp < ${cutoffExpression})`
          );
          await database.run(
            `DELETE FROM transaction_items
             WHERE transaction_id IN (SELECT id FROM transactions WHERE timestamp < ${cutoffExpression})`
          );
          await database.run(
            `DELETE FROM transactions WHERE timestamp < ${cutoffExpression}`
          );
        }

        await database.run(
          `INSERT INTO app_settings (store_id, key, value)
           VALUES (current_store_id(), ?, ?)
           ON CONFLICT (store_id, key) DO UPDATE SET value = excluded.value`,
          ['sales_cleanup_period', currentPeriod]
        );
        return { skipped: false, deletedTransactions: oldTransactionCount };
      }));

      deletedTransactions += Number(result.deletedTransactions || 0);
      if (result.deletedTransactions > 0) {
        console.log(`Pembersihan otomatis toko ${store.code}: ${result.deletedTransactions} transaksi lebih lama dari ${SALES_RETENTION_MONTHS} bulan dihapus.`);
      }
    }

    return { skipped: false, deletedTransactions };
  })();

  try {
    return await salesCleanupInProgress;
  } finally {
    salesCleanupInProgress = null;
  }
};

const getDefaultStore = () => getDbRow("SELECT id, code, name, status, license_key, created_at FROM stores WHERE code = 'utama' LIMIT 1");
const withDefaultStore = async (callback) => {
  const store = await getDefaultStore();
  if (!store) throw new Error('Toko utama belum tersedia');
  return withStoreContext(Number(store.id), () => callback(store));
};

const AUTH_ROLES = new Set(['super_admin', 'admin', 'cashier']);
const authSessions = new Map();
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const normalizeUsername = (value) => String(value || '').trim().toLowerCase();
const normalizeStoreCode = (value) => String(value || '').trim().toLowerCase();

const normalizeContactField = (value, maxLength) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
};

const parsePositiveId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const isValidUsername = (username) => /^[a-z0-9][a-z0-9._-]{2,49}$/.test(username);

const sanitizeUser = (user) => ({
  id: Number(user.id),
  username: user.username,
  role: user.role,
  active: Number(user.active) === 1,
  platformAdmin: Number(user.is_platform_admin) === 1,
  storeId: Number(user.store_id),
  storeCode: user.store_code,
  storeName: user.store_name,
  createdAt: user.created_at,
  lastLoginAt: user.last_login_at
});

const sanitizeStore = (store) => ({
  id: Number(store.id),
  code: store.code,
  name: store.name,
  status: store.status,
  licenseKey: store.license_key,
  userLimit: Number(store.user_limit || 3),
  createdAt: store.created_at
});

const DEVICE_TYPES = new Set(['cashier', 'scanner', 'tablet', 'other']);
const DEVICE_STATUSES = new Set(['pending', 'active', 'revoked']);

const sanitizeDevice = (device) => ({
  id: Number(device.id),
  storeId: Number(device.store_id),
  storeCode: device.store_code,
  storeName: device.store_name,
  name: device.name,
  deviceType: device.device_type,
  deviceId: device.device_id || null,
  activationCode: device.activation_code,
  status: device.status,
  activatedAt: device.activated_at,
  lastSeenAt: device.last_seen_at,
  createdAt: device.created_at
});

const createDeviceActivationCode = () => `ZC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const normalizeDeviceId = (value) => String(value || '').trim().slice(0, 128);

const claimDeviceSlot = async (storeId, deviceId) => {
  const slots = await allDbRows(
    'SELECT id, store_id, device_id, status FROM store_devices WHERE store_id = ? ORDER BY id ASC',
    [storeId]
  );
  const activeSlots = slots.filter((slot) => slot.status === 'active');
  if (!activeSlots.length) return { ok: true };
  if (!deviceId) return { ok: false, error: 'Perangkat belum memiliki identitas. Muat ulang aplikasi lalu coba lagi.' };

  const deviceRegistration = await getDbRow(
    'SELECT id, store_id, status FROM store_devices WHERE device_id = ? LIMIT 1',
    [deviceId]
  );
  if (deviceRegistration && Number(deviceRegistration.store_id) !== Number(storeId)) {
    return { ok: false, error: 'Perangkat ini sudah terdaftar pada toko lain.' };
  }
  if (deviceRegistration?.status === 'revoked') {
    return { ok: false, error: 'Perangkat ini sudah dicabut oleh pengelola toko.' };
  }
  if (deviceRegistration?.status === 'active') {
    await runDb('UPDATE store_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [deviceRegistration.id]);
    return { ok: true, deviceId };
  }

  const availableSlot = activeSlots.find((slot) => !slot.device_id);
  if (!availableSlot) {
    return { ok: false, error: 'Kuota device toko sudah habis. Hubungi Toko Utama untuk menambah mesin kasir.' };
  }
  await runDb(
    `UPDATE store_devices
     SET device_id = ?, activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP), last_seen_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [deviceId, availableSlot.id]
  );
  return { ok: true, deviceId };
};

const issueAuthSession = (user) => {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, {
    user: sanitizeUser(user),
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS
  });
  return token;
};

const getStoredAuthSession = (token) => {
  if (!token) return null;

  const session = authSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    authSessions.delete(token);
    return null;
  }
  return { token, ...session };
};

const getAuthSession = (req) => {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return getStoredAuthSession(token);
};

function requireRole(roles) {
  return async (req, res, next) => {
    const session = getAuthSession(req);
    if (!session) return res.status(401).json({ error: 'Login diperlukan' });
    try {
      const currentUser = await withStoreContext(session.user.storeId, () => getDbRow(
         `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                s.code AS store_code, s.name AS store_name
         FROM users u
         INNER JOIN stores s ON s.id = u.store_id
         WHERE u.id = ? AND s.status = 'active'`,
        [session.user.id]
      ));
      if (!currentUser || Number(currentUser.active) !== 1) {
        authSessions.delete(session.token);
        return res.status(401).json({ error: 'Sesi pengguna sudah tidak aktif' });
      }
      if (!roles.includes(currentUser.role)) return res.status(403).json({ error: 'Akses tidak diizinkan' });
      req.user = sanitizeUser(currentUser);
      req.storeId = req.user.storeId;
      req.authToken = session.token;
      return withStoreContext(req.storeId, () => next());
    } catch (error) {
      return next(error);
    }
  };
}

const requirePlatformAdmin = (req, res, next) => requireRole(['super_admin'])(req, res, () => {
  if (!req.user.platformAdmin) return res.status(403).json({ error: 'Akses hanya untuk pengelola platform' });
  return next();
});

const writeAuditLog = async ({ userId = null, action, entity, entityId = null, beforeData = null, afterData = null, reason = null }) => {
  await runDb(
    'INSERT INTO audit_logs (user_id, action, entity, entity_id, before_data, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)',
    [userId, action, entity, entityId === null ? null : String(entityId), beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null, reason]
  );
};

app.get('/api/auth/status', async (req, res) => {
  try {
    return await withDefaultStore(async () => {
      const superAdminCount = await getDbRow("SELECT COUNT(*)::int AS total FROM users WHERE role = 'super_admin' AND active = 1");
      return res.json({
        configured: Number(superAdminCount?.total || 0) > 0,
        legacyPinConfigured: Boolean(await getSetting('admin_pin_hash')),
        defaultStore: 'utama'
      });
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/bootstrap', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const pin = String(req.body?.pin || '');
  if (!isValidUsername(username) || !/^\d{4,12}$/.test(pin)) {
    return res.status(400).json({ error: 'Username atau PIN Super Admin tidak valid' });
  }

  try {
    return await withDefaultStore(async () => {
      const superAdminCount = await getDbRow("SELECT COUNT(*)::int AS total FROM users WHERE role = 'super_admin' AND active = 1");
      if (Number(superAdminCount?.total || 0) > 0) {
        return res.status(409).json({ error: 'Super Admin awal sudah dibuat' });
      }

      const legacyHash = await getSetting('admin_pin_hash');
      if (legacyHash && !verifyAdminPin(pin, legacyHash)) {
        return res.status(401).json({ error: 'PIN Admin lama salah' });
      }

      const passwordHash = legacyHash || hashAdminPin(pin);
      const inserted = await runDb(
        'INSERT INTO users (username, password_hash, role, is_platform_admin) VALUES (?, ?, ?, ?) RETURNING id',
        [username, passwordHash, 'super_admin', 1]
      );
      if (!legacyHash) await saveSetting('admin_pin_hash', passwordHash);

      const user = await getDbRow(
        `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                s.code AS store_code, s.name AS store_name
         FROM users u INNER JOIN stores s ON s.id = u.store_id WHERE u.id = ?`,
        [inserted.lastID]
      );
      const token = issueAuthSession(user);
      await writeAuditLog({ userId: user.id, action: 'bootstrap', entity: 'user', entityId: user.id, afterData: sanitizeUser(user) });
      return res.status(201).json({ token, user: sanitizeUser(user) });
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'Username sudah digunakan' });
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const storeCode = normalizeStoreCode(req.body?.store_code || 'utama');
  const pin = String(req.body?.pin || req.body?.password || '');
  const deviceId = normalizeDeviceId(req.body?.device_id);
  if ((username && !isValidUsername(username)) || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(storeCode) || !pin) return res.status(400).json({ error: 'Kode toko, username, dan PIN wajib diisi' });

  try {
    const store = await getDbRow('SELECT id, code, name, status FROM stores WHERE code = ?', [storeCode]);
    if (!store || store.status !== 'active') return res.status(404).json({ error: 'Kode toko tidak ditemukan atau sedang dinonaktifkan' });

    return await withStoreContext(Number(store.id), async () => {
      let user = username
        ? await getDbRow(
          `SELECT u.id, u.username, u.password_hash, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                  s.code AS store_code, s.name AS store_name
           FROM users u INNER JOIN stores s ON s.id = u.store_id
           WHERE u.username = ? AND u.store_id = ?`,
          [username, store.id]
        )
        : null;
      let authenticatedWithLegacyPin = false;

      if (user && Number(user.active) === 1 && verifyAdminPin(pin, user.password_hash)) {
        authenticatedWithLegacyPin = true;
      } else {
        const legacyHash = await getSetting('admin_pin_hash');
        if (legacyHash && verifyAdminPin(pin, legacyHash)) {
          const superAdmins = await allDbRows(
            `SELECT u.id, u.username, u.password_hash, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                    s.code AS store_code, s.name AS store_name
             FROM users u INNER JOIN stores s ON s.id = u.store_id
             WHERE u.store_id = ? AND u.role = 'super_admin' AND u.active = 1 ORDER BY u.id`,
            [store.id]
          );
          const matchingSuperAdmin = superAdmins.length === 1
            && (!username || superAdmins[0].username === username)
            ? superAdmins[0]
            : null;
          if (matchingSuperAdmin) {
            user = matchingSuperAdmin;
            authenticatedWithLegacyPin = true;
          }
        }
      }

      if (!user || Number(user.active) !== 1 || !authenticatedWithLegacyPin) {
        return res.status(401).json({ error: 'Username atau PIN salah' });
      }

      const deviceAccess = await claimDeviceSlot(Number(store.id), deviceId);
      if (!deviceAccess.ok) return res.status(403).json({ error: deviceAccess.error });

      await runDb('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
      const token = issueAuthSession({ ...user, last_login_at: new Date().toISOString() });
      await writeAuditLog({ userId: user.id, action: 'login', entity: 'user', entityId: user.id });
      return res.json({ token, user: sanitizeUser(user) });
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const session = getAuthSession(req);
  if (!session) return res.status(401).json({ error: 'Login diperlukan' });
  return res.json({ user: session.user, expiresAt: new Date(session.expiresAt).toISOString() });
});

app.post('/api/auth/logout', (req, res) => {
  const session = getAuthSession(req);
  if (session) authSessions.delete(session.token);
  return res.json({ success: true });
});

app.get('/api/stores', requirePlatformAdmin, async (req, res) => {
  try {
    const stores = await allDbRows(
      'SELECT id, code, name, status, license_key, user_limit, created_at FROM stores ORDER BY created_at ASC, id ASC'
    );
    return res.json(stores.map(sanitizeStore));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/stores', requirePlatformAdmin, async (req, res) => {
  const code = normalizeStoreCode(req.body?.code);
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const ownerUsername = normalizeUsername(req.body?.owner_username);
  const ownerPin = String(req.body?.owner_pin || '');
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(code) || !name || !isValidUsername(ownerUsername) || !/^\d{4,12}$/.test(ownerPin)) {
    return res.status(400).json({ error: 'Kode toko, nama toko, username pemilik, dan PIN tidak valid' });
  }
  if (code === 'utama') return res.status(400).json({ error: 'Kode toko utama tidak dapat digunakan kembali' });

  try {
    const result = await getDb().transaction(async (database) => {
      const licenseKey = `ZK-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const storeInsert = await database.run(
        'INSERT INTO stores (code, name, status, license_key) VALUES (?, ?, ?, ?) RETURNING id',
        [code, name, 'active', licenseKey]
      );
      await database.setStoreContext(storeInsert.lastID);
      const ownerInsert = await database.run(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id',
        [ownerUsername, hashAdminPin(ownerPin), 'super_admin']
      );
      await database.run(
        'INSERT INTO app_settings (store_id, key, value) VALUES (current_store_id(), ?, ?)',
        ['currency', 'Rp']
      );
      await database.run(
        'INSERT INTO app_settings (store_id, key, value) VALUES (current_store_id(), ?, ?)',
        ['store_name', name]
      );
      await database.run(
        'INSERT INTO app_settings (store_id, key, value) VALUES (current_store_id(), ?, ?)',
        ['tax_rate', '0']
      );
      await database.run(
        `INSERT INTO store_devices (store_id, name, device_type, activation_code, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [storeInsert.lastID, 'Perangkat Utama', 'cashier', createDeviceActivationCode()]
      );
      const store = await database.get('SELECT id, code, name, status, license_key, created_at FROM stores WHERE id = ?', [storeInsert.lastID]);
      const owner = await database.get('SELECT id, username, role, active, is_platform_admin, store_id, created_at, last_login_at FROM users WHERE id = ?', [ownerInsert.lastID]);
      return { store, owner };
    });
    return res.status(201).json({ store: sanitizeStore(result.store), owner: sanitizeUser({ ...result.owner, store_code: code, store_name: name }) });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'Kode toko atau username pemilik sudah digunakan' });
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/stores/:id', requirePlatformAdmin, async (req, res) => {
  const storeId = parsePositiveId(req.params.id);
  const name = req.body?.name === undefined ? null : String(req.body.name || '').trim().slice(0, 120);
  const status = req.body?.status === undefined ? null : String(req.body.status);
  const userLimit = req.body?.user_limit === undefined ? null : Number(req.body.user_limit);
  if (!storeId || (name !== null && !name) || (status !== null && !['active', 'suspended'].includes(status)) || (userLimit !== null && (!Number.isInteger(userLimit) || userLimit < 1 || userLimit > 100))) {
    return res.status(400).json({ error: 'Perubahan toko atau batas pengguna tidak valid' });
  }
  if (storeId === req.user.storeId && status === 'suspended') return res.status(400).json({ error: 'Toko yang sedang digunakan tidak dapat dinonaktifkan' });

  try {
    const current = await getDbRow('SELECT id, code, name, status, license_key, user_limit, created_at FROM stores WHERE id = ?', [storeId]);
    if (!current) return res.status(404).json({ error: 'Toko tidak ditemukan' });
    if (userLimit !== null) {
      const activeCount = await withStoreContext(storeId, () => getDbRow('SELECT COUNT(*)::int AS total FROM users WHERE active = 1'));
      if (userLimit < Number(activeCount?.total || 0)) {
        return res.status(409).json({ error: `Batas pengguna tidak dapat diatur ke ${userLimit}. Masih ada ${activeCount.total} akun aktif.` });
      }
    }
    await runDb(
      'UPDATE stores SET name = COALESCE(?, name), status = COALESCE(?, status), user_limit = COALESCE(?, user_limit) WHERE id = ?',
      [name, status, userLimit, storeId]
    );
    const store = await getDbRow('SELECT id, code, name, status, license_key, user_limit, created_at FROM stores WHERE id = ?', [storeId]);
    return res.json({ store: sanitizeStore(store) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/store-devices', requirePlatformAdmin, async (req, res) => {
  const storeId = req.query.store_id === undefined ? null : parsePositiveId(req.query.store_id);
  if (req.query.store_id !== undefined && !storeId) {
    return res.status(400).json({ error: 'ID toko tidak valid' });
  }

  try {
    const params = storeId ? [storeId] : [];
    const where = storeId ? 'WHERE d.store_id = ?' : '';
    const devices = await allDbRows(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.activation_code, d.status,
              d.activated_at, d.last_seen_at, d.created_at
       FROM store_devices d
       INNER JOIN stores s ON s.id = d.store_id
       ${where}
       ORDER BY s.name ASC, d.created_at DESC, d.id DESC`,
      params
    );
    return res.json(devices.map(sanitizeDevice));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/store-devices/quota', requirePlatformAdmin, async (req, res) => {
  const storeId = parsePositiveId(req.body?.store_id);
  const deviceLimit = Number.parseInt(req.body?.device_limit, 10);
  if (!storeId || !Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 50) {
    return res.status(400).json({ error: 'Toko dan batas device harus berupa angka antara 1 sampai 50' });
  }

  try {
    const store = await getDbRow('SELECT id, code, name, status FROM stores WHERE id = ?', [storeId]);
    if (!store) return res.status(404).json({ error: 'Toko tujuan tidak ditemukan' });
    if (store.status !== 'active') return res.status(400).json({ error: 'Toko tujuan sedang ditangguhkan' });

    const currentSlots = await allDbRows(
      'SELECT id, store_id, name, device_type, device_id, status FROM store_devices WHERE store_id = ? ORDER BY id ASC',
      [storeId]
    );
    const activeSlots = currentSlots.filter((slot) => slot.status === 'active');
    const boundSlots = activeSlots.filter((slot) => slot.device_id);
    if (deviceLimit < boundSlots.length) {
      return res.status(409).json({ error: `Batas tidak dapat diatur ke ${deviceLimit}. Masih ada ${boundSlots.length} device yang sudah terpasang.` });
    }

    if (deviceLimit < activeSlots.length) {
      const slotsToRevoke = activeSlots.filter((slot) => !slot.device_id).slice(deviceLimit - boundSlots.length).reverse();
      for (const slot of slotsToRevoke) {
        await runDb("UPDATE store_devices SET status = 'revoked' WHERE id = ?", [slot.id]);
      }
    }

    const slotsAfterReduction = activeSlots.length - Math.max(0, activeSlots.length - deviceLimit);
    const slotsToAdd = Math.max(0, deviceLimit - slotsAfterReduction);
    for (let index = 0; index < slotsToAdd; index += 1) {
      const activationCode = createDeviceActivationCode();
      await runDb(
        `INSERT INTO store_devices (store_id, name, device_type, activation_code, status)
         VALUES (?, ?, 'cashier', ?, 'active')`,
        [storeId, `Kasir ${slotsAfterReduction + index + 1}`, activationCode]
      );
    }

    const devices = await allDbRows(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.activation_code, d.status,
              d.activated_at, d.last_seen_at, d.created_at
       FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
       WHERE d.store_id = ?
       ORDER BY d.id ASC`,
      [storeId]
    );
    await writeAuditLog({ userId: req.user.id, action: 'update', entity: 'store_device_quota', entityId: storeId, afterData: { storeId, deviceLimit }, reason: `Batas device toko ${store.code} diubah menjadi ${deviceLimit}` });
    return res.json({ store: sanitizeStore(store), deviceLimit, devices: devices.map(sanitizeDevice) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/store-devices', requirePlatformAdmin, async (req, res) => {
  const storeId = parsePositiveId(req.body?.store_id);
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const deviceType = String(req.body?.device_type || 'cashier').trim().toLowerCase();
  const quantity = Math.min(20, Math.max(1, Number.parseInt(req.body?.quantity, 10) || 1));
  if (!storeId || !name || !DEVICE_TYPES.has(deviceType) || quantity < 1) {
    return res.status(400).json({ error: 'Toko, nama device, jenis device, dan jumlah slot wajib valid' });
  }

  try {
    const store = await getDbRow('SELECT id, code, name, status FROM stores WHERE id = ?', [storeId]);
    if (!store) return res.status(404).json({ error: 'Toko tujuan tidak ditemukan' });
    if (store.status !== 'active') return res.status(400).json({ error: 'Toko tujuan sedang ditangguhkan' });

    const devices = [];
    for (let slotIndex = 0; slotIndex < quantity; slotIndex += 1) {
      let device = null;
      for (let attempt = 0; attempt < 3 && !device; attempt += 1) {
        try {
          const activationCode = createDeviceActivationCode();
          const slotName = quantity === 1 ? name : `${name} ${slotIndex + 1}`;
          const inserted = await runDb(
            `INSERT INTO store_devices (store_id, name, device_type, activation_code, status)
             VALUES (?, ?, ?, ?, 'active') RETURNING id`,
            [storeId, slotName, deviceType, activationCode]
          );
          device = await getDbRow(
            `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
                    d.name, d.device_type, d.device_id, d.activation_code, d.status,
                    d.activated_at, d.last_seen_at, d.created_at
             FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
             WHERE d.id = ?`,
            [inserted.lastID]
          );
        } catch (error) {
          if (!String(error.message).includes('duplicate key') || attempt === 2) throw error;
        }
      }
      devices.push(device);
    }
    for (const device of devices) {
      await writeAuditLog({ userId: req.user.id, action: 'create', entity: 'store_device', entityId: device.id, afterData: sanitizeDevice(device), reason: `Device ditambahkan untuk toko ${store.code}` });
    }
    return res.status(201).json({ devices: devices.map(sanitizeDevice), device: sanitizeDevice(devices[0]), added: devices.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/store-devices/activate', async (req, res) => {
  const activationCode = String(req.body?.activation_code || '').trim().toUpperCase();
  if (!/^ZC-[A-F0-9]{8}$/.test(activationCode)) {
    return res.status(400).json({ error: 'Kode aktivasi device tidak valid' });
  }

  try {
    const current = await getDbRow(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.activation_code, d.status,
              d.activated_at, d.last_seen_at, d.created_at
       FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
       WHERE d.activation_code = ? AND s.status = 'active'`,
      [activationCode]
    );
    if (!current || current.status === 'revoked') return res.status(404).json({ error: 'Kode aktivasi tidak ditemukan atau sudah dicabut' });

    await runDb(
      `UPDATE store_devices
       SET status = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP), last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [current.id]
    );
    const device = await getDbRow(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.activation_code, d.status,
              d.activated_at, d.last_seen_at, d.created_at
       FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
       WHERE d.id = ?`,
      [current.id]
    );
    return res.json({ device: sanitizeDevice(device), store: sanitizeStore({ id: device.store_id, code: device.store_code, name: device.store_name, status: 'active' }) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/store-devices/:id', requirePlatformAdmin, async (req, res) => {
  const deviceId = parsePositiveId(req.params.id);
  const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
  const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
  const name = hasName ? String(req.body.name || '').trim().slice(0, 80) : null;
  const status = hasStatus ? String(req.body.status || '').trim().toLowerCase() : null;
  if (!deviceId || (hasName && !name) || (hasStatus && !DEVICE_STATUSES.has(status))) {
    return res.status(400).json({ error: 'Perubahan device tidak valid' });
  }

  try {
    const current = await getDbRow('SELECT id, store_id, name, device_type, activation_code, status FROM store_devices WHERE id = ?', [deviceId]);
    if (!current) return res.status(404).json({ error: 'Device tidak ditemukan' });
    await runDb(
      `UPDATE store_devices
       SET name = COALESCE(?, name), status = COALESCE(?, status),
           activated_at = CASE WHEN ? = 'active' AND activated_at IS NULL THEN CURRENT_TIMESTAMP ELSE activated_at END
       WHERE id = ?`,
      [name, status, status, deviceId]
    );
    const device = await getDbRow(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.activation_code, d.status,
              d.activated_at, d.last_seen_at, d.created_at
       FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
       WHERE d.id = ?`,
      [deviceId]
    );
    await writeAuditLog({ userId: req.user.id, action: 'update', entity: 'store_device', entityId: deviceId, beforeData: current, afterData: sanitizeDevice(device) });
    return res.json({ device: sanitizeDevice(device) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/store-devices/:id', requirePlatformAdmin, async (req, res) => {
  const deviceId = parsePositiveId(req.params.id);
  if (!deviceId) return res.status(400).json({ error: 'ID device tidak valid' });

  try {
    const device = await getDbRow(
      `SELECT d.id, d.store_id, s.code AS store_code, s.name AS store_name,
              d.name, d.device_type, d.device_id, d.status
       FROM store_devices d INNER JOIN stores s ON s.id = d.store_id
       WHERE d.id = ?`,
      [deviceId]
    );
    if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });
    if (device.status === 'active') {
      const activeCount = await getDbRow("SELECT COUNT(*)::int AS total FROM store_devices WHERE store_id = ? AND status = 'active'", [device.store_id]);
      if (Number(activeCount?.total || 0) <= 1) {
        return res.status(409).json({ error: 'Minimal harus ada satu device aktif. Turunkan batas device terlebih dahulu jika diperlukan.' });
      }
    }

    await runDb('DELETE FROM store_devices WHERE id = ?', [deviceId]);
    await writeAuditLog({ userId: req.user.id, action: 'delete', entity: 'store_device', entityId: deviceId, beforeData: sanitizeDevice(device), reason: `Device dihapus dari toko ${device.store_code}` });
    return res.json({ success: true, deviceId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size, 10) || 50));
  const search = String(req.query.search || '').trim().slice(0, 100);
  const includeInactive = req.query.include_inactive === 'true' && req.user.role !== 'cashier';
  const conditions = includeInactive ? [] : ['c.active = 1'];
  const params = [];
  if (search) {
    conditions.push("(LOWER(c.name) LIKE LOWER(?) OR COALESCE(c.phone, '') LIKE ? OR LOWER(COALESCE(c.email, '')) LIKE LOWER(?))");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const offset = (page - 1) * pageSize;
    const [count, items] = await Promise.all([
      getDbRow(`SELECT COUNT(*)::int AS total FROM customers c ${whereClause}`, params),
      allDbRows(
        `SELECT c.id, c.name, c.phone, c.email, c.address, c.notes, c.active, c.created_at, c.updated_at
         FROM customers c ${whereClause}
         ORDER BY c.name ASC, c.id ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )
    ]);
    const total = Number(count?.total || 0);
    return res.json({
      items,
      pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const phone = normalizeContactField(req.body?.phone, 40);
  const email = normalizeContactField(req.body?.email, 160);
  const address = normalizeContactField(req.body?.address, 300);
  const notes = normalizeContactField(req.body?.notes, 500);
  if (!name) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });

  try {
    const inserted = await runDb(
      'INSERT INTO customers (name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [name, phone, email, address, notes]
    );
    const customer = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM customers WHERE id = ?', [inserted.lastID]);
    await writeAuditLog({ userId: req.user.id, action: 'create', entity: 'customer', entityId: inserted.lastID, afterData: customer });
    return res.status(201).json({ customer });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/customers/:id', requireRole(['super_admin', 'admin']), async (req, res) => {
  const customerId = parsePositiveId(req.params.id);
  if (!customerId) return res.status(400).json({ error: 'ID pelanggan tidak valid' });
  const has = (key) => Object.prototype.hasOwnProperty.call(req.body || {}, key);

  try {
    const current = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM customers WHERE id = ?', [customerId]);
    if (!current) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

    const nextName = has('name') ? String(req.body.name || '').trim().slice(0, 120) : current.name;
    if (!nextName) return res.status(400).json({ error: 'Nama pelanggan wajib diisi' });
    const nextPhone = has('phone') ? normalizeContactField(req.body.phone, 40) : current.phone;
    const nextEmail = has('email') ? normalizeContactField(req.body.email, 160) : current.email;
    const nextAddress = has('address') ? normalizeContactField(req.body.address, 300) : current.address;
    const nextNotes = has('notes') ? normalizeContactField(req.body.notes, 500) : current.notes;
    const nextActive = has('active') ? (req.body.active ? 1 : 0) : Number(current.active) === 1 ? 1 : 0;

    await runDb(
      'UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, notes = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextName, nextPhone, nextEmail, nextAddress, nextNotes, nextActive, customerId]
    );
    const customer = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM customers WHERE id = ?', [customerId]);
    await writeAuditLog({ userId: req.user.id, action: 'update', entity: 'customer', entityId: customerId, beforeData: current, afterData: customer });
    return res.json({ customer });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/suppliers', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size, 10) || 50));
  const search = String(req.query.search || '').trim().slice(0, 100);
  const includeInactive = req.query.include_inactive === 'true' && req.user.role !== 'cashier';
  const conditions = includeInactive ? [] : ['s.active = 1'];
  const params = [];
  if (search) {
    conditions.push("(LOWER(s.name) LIKE LOWER(?) OR COALESCE(s.phone, '') LIKE ? OR LOWER(COALESCE(s.email, '')) LIKE LOWER(?))");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const offset = (page - 1) * pageSize;
    const [count, items] = await Promise.all([
      getDbRow(`SELECT COUNT(*)::int AS total FROM suppliers s ${whereClause}`, params),
      allDbRows(
        `SELECT s.id, s.name, s.phone, s.email, s.address, s.notes, s.active, s.created_at, s.updated_at
         FROM suppliers s ${whereClause}
         ORDER BY s.name ASC, s.id ASC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )
    ]);
    const total = Number(count?.total || 0);
    return res.json({
      items,
      pagination: { page, pageSize, total, totalPages: total ? Math.ceil(total / pageSize) : 0 }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/suppliers', requireRole(['super_admin', 'admin']), async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const phone = normalizeContactField(req.body?.phone, 40);
  const email = normalizeContactField(req.body?.email, 160);
  const address = normalizeContactField(req.body?.address, 300);
  const notes = normalizeContactField(req.body?.notes, 500);
  if (!name) return res.status(400).json({ error: 'Nama supplier wajib diisi' });

  try {
    const inserted = await runDb(
      'INSERT INTO suppliers (name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [name, phone, email, address, notes]
    );
    const supplier = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM suppliers WHERE id = ?', [inserted.lastID]);
    await writeAuditLog({ userId: req.user.id, action: 'create', entity: 'supplier', entityId: inserted.lastID, afterData: supplier });
    return res.status(201).json({ supplier });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/suppliers/:id', requireRole(['super_admin', 'admin']), async (req, res) => {
  const supplierId = parsePositiveId(req.params.id);
  if (!supplierId) return res.status(400).json({ error: 'ID supplier tidak valid' });
  const has = (key) => Object.prototype.hasOwnProperty.call(req.body || {}, key);

  try {
    const current = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM suppliers WHERE id = ?', [supplierId]);
    if (!current) return res.status(404).json({ error: 'Supplier tidak ditemukan' });
    const nextName = has('name') ? String(req.body.name || '').trim().slice(0, 120) : current.name;
    if (!nextName) return res.status(400).json({ error: 'Nama supplier wajib diisi' });
    const nextPhone = has('phone') ? normalizeContactField(req.body.phone, 40) : current.phone;
    const nextEmail = has('email') ? normalizeContactField(req.body.email, 160) : current.email;
    const nextAddress = has('address') ? normalizeContactField(req.body.address, 300) : current.address;
    const nextNotes = has('notes') ? normalizeContactField(req.body.notes, 500) : current.notes;
    const nextActive = has('active') ? (req.body.active ? 1 : 0) : Number(current.active) === 1 ? 1 : 0;

    await runDb(
      'UPDATE suppliers SET name = ?, phone = ?, email = ?, address = ?, notes = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextName, nextPhone, nextEmail, nextAddress, nextNotes, nextActive, supplierId]
    );
    const supplier = await getDbRow('SELECT id, name, phone, email, address, notes, active, created_at, updated_at FROM suppliers WHERE id = ?', [supplierId]);
    await writeAuditLog({ userId: req.user.id, action: 'update', entity: 'supplier', entityId: supplierId, beforeData: current, afterData: supplier });
    return res.json({ supplier });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/current', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  try {
    const shift = await getDbRow(
      `SELECT s.id, s.user_id, u.username, s.status, s.opening_cash, s.closing_cash,
              s.expected_cash, s.variance, s.notes, s.opened_at, s.closed_at
       FROM shifts s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? AND s.status = 'open'
       ORDER BY s.opened_at DESC, s.id DESC
       LIMIT 1`,
      [req.user.id]
    );
    return res.json({ shift });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/shifts/open', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const openingCash = Number(req.body?.opening_cash ?? 0);
  const notes = String(req.body?.notes || '').trim().slice(0, 500) || null;
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    return res.status(400).json({ error: 'Saldo awal shift tidak valid' });
  }

  try {
    const shift = await getDb().transaction(async (database) => {
      const existing = await database.get(
        `SELECT id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [req.user.id]
      );
      if (existing) throw checkoutError(`Shift #${existing.id} masih terbuka`, 409);

      const inserted = await database.run(
        'INSERT INTO shifts (user_id, status, opening_cash, notes) VALUES (?, ?, ?, ?) RETURNING id',
        [req.user.id, 'open', roundMoney(openingCash), notes]
      );
      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?)',
        [req.user.id, 'open', 'shift', String(inserted.lastID), JSON.stringify({ openingCash: roundMoney(openingCash), notes }), notes]
      );
      return database.get(
        `SELECT id, user_id, status, opening_cash, closing_cash, expected_cash, variance, notes, opened_at, closed_at
         FROM shifts WHERE id = ?`,
        [inserted.lastID]
      );
    });
    return res.status(201).json({ success: true, shift });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/shifts/:id/close', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const shiftId = Number(req.params.id);
  const closingCash = Number(req.body?.closing_cash);
  const notes = String(req.body?.notes || '').trim().slice(0, 500) || null;
  if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ error: 'ID shift tidak valid' });
  if (!Number.isFinite(closingCash) || closingCash < 0) return res.status(400).json({ error: 'Saldo akhir shift tidak valid' });

  try {
    const shift = await getDb().transaction(async (database) => {
      const current = await database.get(
        `SELECT id, user_id, status, opening_cash, notes FROM shifts WHERE id = ? FOR UPDATE`,
        [shiftId]
      );
      if (!current) throw checkoutError('Shift tidak ditemukan', 404);
      if (current.status !== 'open') throw checkoutError('Shift sudah ditutup', 409);
      const canClose = req.user.role === 'super_admin' || req.user.role === 'admin' || Number(current.user_id) === req.user.id;
      if (!canClose) throw checkoutError('Anda tidak dapat menutup shift kasir lain', 403);

      const cashSales = await database.get(
        `SELECT COALESCE(SUM(amount_paid - change), 0) AS total
         FROM transactions
         WHERE shift_id = ? AND status = 'completed' AND payment_method = 'cash'`,
        [shiftId]
      );
      const expectedCash = roundMoney(Number(current.opening_cash || 0) + Number(cashSales?.total || 0));
      const actualCash = roundMoney(closingCash);
      const variance = roundMoney(actualCash - expectedCash);
      const updated = await database.run(
        `UPDATE shifts
         SET status = 'closed', closing_cash = ?, expected_cash = ?, variance = ?, notes = COALESCE(?, notes), closed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'open'`,
        [actualCash, expectedCash, variance, notes, shiftId]
      );
      if (updated.changes !== 1) throw checkoutError('Shift gagal ditutup. Silakan ulangi.', 409);
      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, before_data, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)',
        [
          req.user.id,
          'close',
          'shift',
          String(shiftId),
          JSON.stringify({ status: current.status, openingCash: Number(current.opening_cash || 0) }),
          JSON.stringify({ status: 'closed', closingCash: actualCash, expectedCash, variance }),
          notes
        ]
      );
      return database.get(
        `SELECT id, user_id, status, opening_cash, closing_cash, expected_cash, variance, notes, opened_at, closed_at
         FROM shifts WHERE id = ?`,
        [shiftId]
      );
    });
    return res.json({ success: true, shift });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/held-transactions', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  try {
    const canSeeAll = req.user.role === 'super_admin' || req.user.role === 'admin';
    const held = canSeeAll
      ? await allDbRows(
        `SELECT ht.id, ht.user_id, u.username, ht.label, ht.payload, ht.created_at, ht.updated_at
         FROM held_transactions ht
         LEFT JOIN users u ON u.id = ht.user_id
         ORDER BY ht.created_at DESC, ht.id DESC`
      )
      : await allDbRows(
        `SELECT ht.id, ht.user_id, u.username, ht.label, ht.payload, ht.created_at, ht.updated_at
         FROM held_transactions ht
         LEFT JOIN users u ON u.id = ht.user_id
         WHERE ht.user_id = ?
         ORDER BY ht.created_at DESC, ht.id DESC`,
        [req.user.id]
      );
    return res.json(held);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/held-transactions', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 120) || 'Transaksi tertunda';
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    return res.status(400).json({ error: 'Keranjang transaksi tertunda tidak valid' });
  }

  const normalizedItems = [];
  for (const item of items) {
    const rawId = item?.id;
    const isCustom = typeof rawId === 'string' && rawId.startsWith('custom-');
    const id = isCustom ? rawId : Number(rawId);
    const quantity = Number(item?.qty ?? item?.quantity);
    const price = Number(item?.price);
    const name = String(item?.name || '').trim();
    if ((!isCustom && (!Number.isInteger(id) || id <= 0)) || (isCustom && !id) || !name || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Isi transaksi tertunda tidak valid' });
    }
    normalizedItems.push({ id, name, qty: quantity, price, isCustom });
  }

  const requestedPaymentMethod = String(req.body?.payment_method || 'cash').trim().toLowerCase();
  if (!PAYMENT_METHODS.has(requestedPaymentMethod)) {
    return res.status(400).json({ error: 'Metode pembayaran hanya Tunai atau QRIS' });
  }
  const paymentMethod = requestedPaymentMethod;
  const heldCustomerId = req.body?.customer_id === null || req.body?.customer_id === undefined || req.body?.customer_id === '' ? null : parsePositiveId(req.body.customer_id);
  if (req.body?.customer_id !== null && req.body?.customer_id !== undefined && req.body?.customer_id !== '' && !heldCustomerId) {
    return res.status(400).json({ error: 'Pelanggan transaksi tertunda tidak valid' });
  }
  const payload = {
    items: normalizedItems,
    discount: Math.max(0, Number(req.body?.discount || 0)),
    paymentMethod,
    paymentReference: String(req.body?.payment_reference || '').trim().slice(0, 120),
    customerId: heldCustomerId
  };

  try {
    const inserted = await runDb(
      'INSERT INTO held_transactions (user_id, label, payload) VALUES (?, ?, ?::jsonb) RETURNING id',
      [req.user.id, label, JSON.stringify(payload)]
    );
    await writeAuditLog({ userId: req.user.id, action: 'hold', entity: 'transaction', entityId: inserted.lastID, afterData: { label, itemCount: normalizedItems.length } });
    const held = await getDbRow('SELECT id, user_id, label, payload, created_at, updated_at FROM held_transactions WHERE id = ?', [inserted.lastID]);
    return res.status(201).json(held);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/held-transactions/:id', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const heldId = Number(req.params.id);
  if (!Number.isInteger(heldId) || heldId <= 0) return res.status(400).json({ error: 'ID transaksi tertunda tidak valid' });
  try {
    const held = await getDbRow('SELECT id, user_id, label FROM held_transactions WHERE id = ?', [heldId]);
    if (!held) return res.status(404).json({ error: 'Transaksi tertunda tidak ditemukan' });
    const canManage = req.user.role === 'super_admin' || req.user.role === 'admin' || Number(held.user_id) === req.user.id;
    if (!canManage) return res.status(403).json({ error: 'Transaksi tertunda milik kasir lain' });
    await runDb('DELETE FROM held_transactions WHERE id = ?', [heldId]);
    await writeAuditLog({ userId: req.user.id, action: 'delete', entity: 'held_transaction', entityId: heldId, beforeData: held });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', requireRole(['super_admin']), async (req, res) => {
  try {
    const users = await allDbRows(
      `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
              s.code AS store_code, s.name AS store_name
       FROM users u INNER JOIN stores s ON s.id = u.store_id
       ORDER BY u.username COLLATE NOCASE`
    );
    return res.json(users.map(sanitizeUser));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/quota', requireRole(['super_admin']), async (req, res) => {
  try {
    const [store, activeCount] = await Promise.all([
      getDbRow('SELECT user_limit FROM stores WHERE id = ?', [req.storeId]),
      getDbRow('SELECT COUNT(*)::int AS total FROM users WHERE active = 1')
    ]);
    return res.json({ userLimit: Number(store?.user_limit || 3), activeCount: Number(activeCount?.total || 0) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireRole(['super_admin']), async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const pin = String(req.body?.pin || '');
  const role = String(req.body?.role || 'cashier');
  if (!isValidUsername(username) || !/^\d{4,12}$/.test(pin) || !AUTH_ROLES.has(role)) {
    return res.status(400).json({ error: 'Username, PIN, atau role tidak valid' });
  }

  try {
    const passwordHash = hashAdminPin(pin);
    const user = await getDb().transaction(async (database) => {
      const store = await database.get('SELECT id, user_limit FROM stores WHERE id = ? FOR UPDATE', [req.storeId]);
      const activeCount = await database.get("SELECT COUNT(*)::int AS total FROM users WHERE active = 1");
      const userLimit = Number(store?.user_limit || 3);
      if (Number(activeCount?.total || 0) >= userLimit) {
        const limitError = new Error(`Batas akun aktif toko ini adalah ${userLimit}. Minta Toko Utama menambah kuota pengguna.`);
        limitError.status = 409;
        throw limitError;
      }

      const inserted = await database.run(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id',
        [username, passwordHash, role]
      );
      return database.get(
        `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                s.code AS store_code, s.name AS store_name
         FROM users u INNER JOIN stores s ON s.id = u.store_id WHERE u.id = ?`,
        [inserted.lastID]
      );
    });
    await writeAuditLog({ userId: req.user.id, action: 'create', entity: 'user', entityId: user.id, afterData: sanitizeUser(user) });
    return res.status(201).json({ user: sanitizeUser(user) });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'Username sudah digunakan' });
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/users/:id', requireRole(['super_admin']), async (req, res) => {
  const userId = Number(req.params.id);
  const nextRole = req.body?.role === undefined ? null : String(req.body.role);
  const nextActive = req.body?.active === undefined ? null : Boolean(req.body.active);
  const nextPin = req.body?.pin === undefined ? null : String(req.body.pin);
  if (!Number.isInteger(userId) || userId <= 0 || (nextRole !== null && !AUTH_ROLES.has(nextRole)) || (nextPin !== null && !/^\d{4,12}$/.test(nextPin))) {
    return res.status(400).json({ error: 'Perubahan pengguna tidak valid' });
  }

  try {
    const { current, updated } = await getDb().transaction(async (database) => {
      const store = await database.get('SELECT id, user_limit FROM stores WHERE id = ? FOR UPDATE', [req.storeId]);
      const current = await database.get(
        `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                s.code AS store_code, s.name AS store_name
         FROM users u INNER JOIN stores s ON s.id = u.store_id WHERE u.id = ?`,
        [userId]
      );
      if (!current) {
        const notFoundError = new Error('Pengguna tidak ditemukan');
        notFoundError.status = 404;
        throw notFoundError;
      }
      if (userId === req.user.id && nextActive === false) {
        const selfDeactivateError = new Error('Anda tidak dapat menonaktifkan akun sendiri');
        selfDeactivateError.status = 400;
        throw selfDeactivateError;
      }
      if (userId === req.user.id && nextRole !== null && nextRole !== 'super_admin') {
        const selfRoleError = new Error('Anda tidak dapat menurunkan role sendiri');
        selfRoleError.status = 400;
        throw selfRoleError;
      }

      const resultingRole = nextRole || current.role;
      const resultingActive = nextActive === null ? Number(current.active) === 1 : nextActive;
      if (current.role === 'super_admin' && (resultingRole !== 'super_admin' || !resultingActive)) {
        const count = await database.get("SELECT COUNT(*)::int AS total FROM users WHERE role = 'super_admin' AND active = 1 AND id <> ?", [userId]);
        if (Number(count?.total || 0) < 1) {
          const lastAdminError = new Error('Minimal harus ada satu Super Admin aktif');
          lastAdminError.status = 400;
          throw lastAdminError;
        }
      }
      if (resultingActive && Number(current.active) !== 1) {
        const activeCount = await database.get("SELECT COUNT(*)::int AS total FROM users WHERE active = 1");
        const userLimit = Number(store?.user_limit || 3);
        if (Number(activeCount?.total || 0) >= userLimit) {
          const limitError = new Error(`Batas akun aktif toko ini adalah ${userLimit}. Minta Toko Utama menambah kuota pengguna.`);
          limitError.status = 409;
          throw limitError;
        }
      }

      const fields = [];
      const values = [];
      if (nextRole !== null) { fields.push('role = ?'); values.push(nextRole); }
      if (nextActive !== null) { fields.push('active = ?'); values.push(nextActive ? 1 : 0); }
      if (nextPin !== null) { fields.push('password_hash = ?'); values.push(hashAdminPin(nextPin)); }
      if (!fields.length) {
        const noChangeError = new Error('Tidak ada perubahan pengguna');
        noChangeError.status = 400;
        throw noChangeError;
      }
      values.push(userId);
      await database.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
      const updated = await database.get(
        `SELECT u.id, u.username, u.role, u.active, u.is_platform_admin, u.store_id, u.created_at, u.last_login_at,
                s.code AS store_code, s.name AS store_name
         FROM users u INNER JOIN stores s ON s.id = u.store_id WHERE u.id = ?`,
        [userId]
      );
      return { current, updated };
    });
    await writeAuditLog({ userId: req.user.id, action: 'update', entity: 'user', entityId: userId, beforeData: sanitizeUser(current), afterData: sanitizeUser(updated) });
    return res.json({ user: sanitizeUser(updated) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/admin/status', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  try {
    res.json({ configured: Boolean(await getSetting('admin_pin_hash')) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/setup', async (req, res) => {
  return res.status(410).json({ error: 'Gunakan proses pembuatan Super Admin pada /api/auth/bootstrap' });
});

app.post('/api/admin/verify', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  const pin = String(req.body?.pin || '');
  try {
    const storedHash = await getSetting('admin_pin_hash');
    if (!verifyAdminPin(pin, storedHash)) return res.status(401).json({ error: 'PIN Admin salah' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  try {
    const [currency, taxRate, storeName, receiptFooter] = await Promise.all([
      getSetting('currency'),
      getSetting('tax_rate'),
      getSetting('store_name'),
      getSetting('receipt_footer')
    ]);

    res.json({
      currency: currency || 'Rp',
      taxRate: Number.isFinite(Number(taxRate)) ? Number(taxRate) : 0,
      storeName: /^znnpos$/i.test(storeName || '') ? 'ZnnCashier' : storeName || 'ZnnCashier',
      receiptFooter: receiptFooter || 'Terima kasih sudah berbelanja!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/settings', requireRole(['super_admin']), async (req, res) => {
  const currency = String(req.body?.currency || '').trim();
  const storeName = String(req.body?.store_name || '').trim();
  const receiptFooter = String(req.body?.receipt_footer || '').trim();
  const taxRate = Number(req.body?.tax_rate);

  if (!currency || currency.length > 12 || !storeName || storeName.length > 120 || receiptFooter.length > 5000) {
    return res.status(400).json({ error: 'Pengaturan toko tidak valid' });
  }
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    return res.status(400).json({ error: 'Pajak harus berada di antara 0 dan 100' });
  }

  try {
    await saveSetting('currency', currency);
    await saveSetting('tax_rate', String(taxRate));
    await saveSetting('store_name', storeName);
    await saveSetting('receipt_footer', receiptFooter);
    await runDb('UPDATE stores SET name = ? WHERE id = ?', [storeName, req.storeId]);
    const activeSession = authSessions.get(req.authToken);
    if (activeSession) {
      activeSession.user = { ...activeSession.user, storeName };
    }
    res.json({ success: true, currency, taxRate, storeName, receiptFooter });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/change-pin', requireRole(['super_admin']), async (req, res) => {
  const currentPin = String(req.body?.currentPin || '');
  const newPin = String(req.body?.newPin || '');
  if (!/^\d{4,12}$/.test(newPin)) return res.status(400).json({ error: 'PIN baru harus terdiri dari 4 sampai 12 angka' });
  try {
    const storedHash = await getSetting('admin_pin_hash');
    if (!verifyAdminPin(currentPin, storedHash)) return res.status(401).json({ error: 'PIN Admin salah' });
    const newHash = hashAdminPin(newPin);
    await saveSetting('admin_pin_hash', newHash);
    await runDb('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/stock', requireRole(['super_admin', 'admin']), async (req, res) => {
  const action = req.body?.action;
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 500) || `Perubahan stok: ${action}`;
  if (!['add', 'subtract', 'set'].includes(action) || !Number.isInteger(amount) || amount < 0) {
    return res.status(400).json({ error: 'Perubahan stok tidak valid' });
  }
  try {
    const result = await getDb().transaction(async (database) => {
      const product = await database.get('SELECT id, name, stock, active FROM products WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!product) throw checkoutError('Produk tidak ditemukan', 404);
      if (Number(product.active) !== 1) throw checkoutError('Produk sudah diarsipkan', 409);

      const stockBefore = Number(product.stock || 0);
      const nextStock = action === 'add' ? stockBefore + amount : action === 'subtract' ? stockBefore - amount : amount;
      if (nextStock < 0) throw checkoutError('Stok tidak boleh kurang dari 0');

      const updated = await database.run('UPDATE products SET stock = ? WHERE id = ? AND active = 1', [nextStock, req.params.id]);
      if (updated.changes !== 1) throw checkoutError('Stok gagal diperbarui. Silakan ulangi.', 409);

      await database.run(
        'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [product.id, req.user.id, `stock_${action}`, nextStock - stockBefore, stockBefore, nextStock, reason, 'manual_adjustment']
      );
      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?)',
        [req.user.id, 'stock_adjustment', 'product', String(product.id), JSON.stringify({ product: product.name, stockBefore, stockAfter: nextStock, quantityChange: nextStock - stockBefore }), reason]
      );

      return { product: product.name, stock: nextStock, quantityChange: nextStock - stockBefore };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/stock-opname', requireRole(['super_admin', 'admin']), async (req, res) => {
  const countedStock = Number(req.body?.counted_stock);
  const reason = String(req.body?.reason || '').trim().slice(0, 500) || 'Stok opname';
  if (!Number.isInteger(countedStock) || countedStock < 0) {
    return res.status(400).json({ error: 'Jumlah stok fisik harus berupa bilangan bulat 0 atau lebih' });
  }

  try {
    const result = await getDb().transaction(async (database) => {
      const product = await database.get(
        'SELECT id, name, stock, active FROM products WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!product) throw checkoutError('Produk tidak ditemukan', 404);
      if (Number(product.active) !== 1) throw checkoutError('Produk sudah diarsipkan', 409);

      const stockBefore = Number(product.stock || 0);
      const quantityChange = countedStock - stockBefore;
      const updated = await database.run(
        'UPDATE products SET stock = ? WHERE id = ? AND active = 1',
        [countedStock, req.params.id]
      );
      if (updated.changes !== 1) throw checkoutError('Stok opname gagal disimpan. Silakan ulangi.', 409);

      await database.run(
        'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [product.id, req.user.id, 'opname', quantityChange, stockBefore, countedStock, reason, 'stock_opname']
      );
      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, before_data, after_data, reason) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)',
        [
          req.user.id,
          'stock_opname',
          'product',
          String(product.id),
          JSON.stringify({ product: product.name, stock: stockBefore }),
          JSON.stringify({ product: product.name, stock: countedStock, quantityChange }),
          reason
        ]
      );

      return {
        product: product.name,
        stockBefore,
        stock: countedStock,
        quantityChange
      };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/products/:id', requireRole(['super_admin', 'admin']), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const barcode = String(req.body?.barcode || '').trim();
  const price = Number(req.body?.price);
  const costPrice = Number(req.body?.cost_price ?? 0);
  const supplierId = req.body?.supplier_id === null || req.body?.supplier_id === undefined || req.body?.supplier_id === '' ? null : parsePositiveId(req.body.supplier_id);
  if (!name || !barcode || !Number.isFinite(price) || price < 0 || !Number.isFinite(costPrice) || costPrice < 0) {
    return res.status(400).json({ error: 'Nama, barcode, harga jual, dan harga modal harus diisi dengan benar' });
  }
  if (req.body?.supplier_id !== null && req.body?.supplier_id !== undefined && req.body?.supplier_id !== '' && !supplierId) {
    return res.status(400).json({ error: 'Supplier tidak valid' });
  }
  try {
    if (supplierId) {
      const supplier = await getDbRow('SELECT id FROM suppliers WHERE id = ? AND active = 1', [supplierId]);
      if (!supplier) return res.status(400).json({ error: 'Supplier tidak ditemukan atau sudah tidak aktif' });
    }
    getDb().run(
      'UPDATE products SET name = ?, barcode = ?, price = ?, cost_price = ?, supplier_id = ? WHERE id = ?',
      [name, barcode, price, costPrice, supplierId, req.params.id],
      function(err) {
        if (err) {
          if (String(err.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'Barcode sudah digunakan produk lain' });
          return res.status(500).json({ error: err.message });
        }
        if (!this.changes) return res.status(404).json({ error: 'Produk tidak ditemukan' });
        res.json({ success: true, product: { id: Number(req.params.id), name, barcode, price, cost_price: costPrice, supplier_id: supplierId } });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireRole(['super_admin', 'admin']), async (req, res) => {
  try {
    const database = getDb();
    database.get('SELECT id, name FROM products WHERE id = ?', [req.params.id], (findErr, product) => {
      if (findErr) return res.status(500).json({ error: findErr.message });
      if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
      database.get('SELECT COUNT(*) AS total FROM transaction_items WHERE product_id = ?', [req.params.id], (usageErr, usage) => {
        if (usageErr) return res.status(500).json({ error: usageErr.message });
        if (usage.total > 0) {
          return database.run('UPDATE products SET active = 0 WHERE id = ?', [req.params.id], (archiveErr) => {
            if (archiveErr) return res.status(500).json({ error: archiveErr.message });
            res.json({ success: true, archived: true, product: product.name, message: 'Produk memiliki riwayat transaksi dan dipindahkan ke arsip' });
          });
        }
        database.run('DELETE FROM products WHERE id = ?', [req.params.id], (deleteErr) => {
          if (deleteErr) return res.status(500).json({ error: deleteErr.message });
          res.json({ success: true, product: product.name });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/restore', requireRole(['super_admin', 'admin']), async (req, res) => {
  try {
    getDb().run('UPDATE products SET active = 1 WHERE id = ?', [req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (!this.changes) return res.status(404).json({ error: 'Produk arsip tidak ditemukan' });
      res.json({ success: true, message: 'Produk berhasil dipulihkan' });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id/permanent', requireRole(['super_admin', 'admin']), async (req, res) => {
  try {
    const database = getDb();
    database.get('SELECT id, name FROM products WHERE id = ? AND active = 0', [req.params.id], (findErr, product) => {
      if (findErr) return res.status(500).json({ error: findErr.message });
      if (!product) return res.status(404).json({ error: 'Produk arsip tidak ditemukan' });
      database.run('DELETE FROM products WHERE id = ?', [req.params.id], (deleteErr) => {
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });
        res.json({ success: true, product: product.name });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add new product
app.post('/api/products', requireRole(['super_admin', 'admin']), async (req, res) => {
  const { name, barcode, price, cost_price = 0, category, stock, supplier_id = null } = req.body;
  const initialStock = Number(stock || 0);
  const supplierId = supplier_id === null || supplier_id === undefined || supplier_id === '' ? null : parsePositiveId(supplier_id);
  if (!name || price === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!Number.isFinite(Number(price)) || Number(price) < 0 || !Number.isFinite(Number(cost_price)) || Number(cost_price) < 0 || !Number.isInteger(initialStock) || initialStock < 0) {
    return res.status(400).json({ error: 'Harga jual dan harga modal harus berupa angka yang valid' });
  }
  if (supplier_id !== null && supplier_id !== undefined && supplier_id !== '' && !supplierId) {
    return res.status(400).json({ error: 'Supplier tidak valid' });
  }

  // Barcode boleh dikosongkan; sistem membuat kode unik agar produk tetap
  // kompatibel dengan scanner dan aturan UNIQUE/NOT NULL di database.
  const normalizedBarcode = String(barcode || '').trim();
  // Barcode otomatis selalu berformat 13 karakter: A + 12 angka.
  const generatedBarcode = normalizedBarcode || `A${String(crypto.randomInt(0, 1_000_000_000_000)).padStart(12, '0')}`;

  try {
    const result = await getDb().transaction(async (database) => {
      if (supplierId) {
        const supplier = await database.get('SELECT id FROM suppliers WHERE id = ? AND active = 1 FOR UPDATE', [supplierId]);
        if (!supplier) throw checkoutError('Supplier tidak ditemukan atau sudah tidak aktif');
      }
      const inserted = await database.run(
        'INSERT INTO products (name, barcode, price, cost_price, category, stock, active, supplier_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        [name, generatedBarcode, price, cost_price, category, initialStock, supplierId]
      );

      if (initialStock > 0) {
        await database.run(
          'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [inserted.lastID, req.user.id, 'initial', initialStock, 0, initialStock, 'Stok awal produk', 'product_creation']
        );
      }

      return { id: inserted.lastID, name, barcode: generatedBarcode, price, cost_price, category, stock: initialStock, supplier_id: supplierId };
    });
    return res.json(result);
  } catch (err) {
    if (String(err.message).includes('duplicate key')) return res.status(409).json({ error: 'Barcode sudah digunakan produk lain' });
    return res.status(500).json({ error: err.message });
  }
});

const checkoutError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

// POST checkout transaction. Harga produk, stok, pajak, total, dan kembalian
// dihitung ulang di backend agar nilai dari browser tidak menjadi sumber kebenaran.
app.post('/api/checkout', requireRole(['super_admin', 'admin', 'cashier']), async (req, res) => {
  try {
    const { discount = 0, tax_rate = 0, amount_paid, payment_method = 'cash', payment_reference = '', customer_id = null, items } = req.body || {};
    const paymentMethod = String(payment_method || 'cash').trim().toLowerCase();
    const paymentReference = String(payment_reference || '').trim().slice(0, 120);
    const customerId = customer_id === null || customer_id === undefined || customer_id === '' ? null : parsePositiveId(customer_id);

    if (customer_id !== null && customer_id !== undefined && customer_id !== '' && !customerId) {
      throw checkoutError('Pelanggan tidak valid');
    }

    if (!PAYMENT_METHODS.has(paymentMethod)) {
      throw checkoutError('Metode pembayaran tidak valid');
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw checkoutError('Keranjang masih kosong');
    }

    const normalizedItems = items.map((item, index) => {
      const rawId = item?.id ?? item?.product_id;
      const isCustom = typeof rawId === 'string' && rawId.startsWith('custom-');
      const id = isCustom ? rawId : Number(rawId);
      const quantity = Number(item?.quantity ?? item?.qty ?? 0);

      if (!isCustom && (!Number.isInteger(id) || id <= 0)) {
        throw checkoutError(`ID produk pada item ${index + 1} tidak valid`);
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw checkoutError(`Jumlah item pada baris ${index + 1} tidak valid`);
      }

      if (isCustom) {
        const name = String(item?.name || '').trim();
        const price = Number(item?.price ?? item?.unit_price ?? 0);
        if (!name || !Number.isFinite(price) || price < 0) {
          throw checkoutError(`Item kustom pada baris ${index + 1} tidak valid`);
        }
        return { id, name, price: roundMoney(price), costPrice: 0, quantity, isCustom: true };
      }

      return { id, quantity, isCustom: false };
    });

    const numericDiscount = Number(discount);
    const requestedTaxRate = Number(tax_rate);
    const numericAmountPaid = Number(amount_paid);

    if (!Number.isFinite(numericDiscount) || numericDiscount < 0) {
      throw checkoutError('Potongan harga tidak valid');
    }
    if (!Number.isFinite(requestedTaxRate) || requestedTaxRate < 0 || requestedTaxRate > 100) {
      throw checkoutError('Persentase pajak harus berada di antara 0 dan 100');
    }
    if (!Number.isFinite(numericAmountPaid) || numericAmountPaid < 0) {
      throw checkoutError('Nominal pembayaran tidak valid');
    }

    const result = await getDb().transaction(async (database) => {
      const activeShift = await database.get(
        `SELECT id, user_id FROM shifts
         WHERE user_id = ? AND status = 'open'
         ORDER BY opened_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [req.user.id]
      );
      if (!activeShift) throw checkoutError('Buka shift kasir terlebih dahulu sebelum checkout', 409);

      let customer = null;
      if (customerId) {
        customer = await database.get(
          'SELECT id, name, phone FROM customers WHERE id = ? AND active = 1 FOR UPDATE',
          [customerId]
        );
        if (!customer) throw checkoutError('Pelanggan tidak ditemukan atau sudah tidak aktif', 409);
      }

      const pricedItems = [];
      const projectedStocks = new Map();
      let subtotal = 0;
      const taxSetting = await database.get('SELECT value FROM app_settings WHERE key = ?', ['tax_rate']);
      const storedTaxRate = taxSetting?.value === undefined || taxSetting?.value === null ? null : Number(taxSetting.value);
      const numericTaxRate = storedTaxRate === null ? requestedTaxRate : storedTaxRate;
      if (!Number.isFinite(numericTaxRate) || numericTaxRate < 0 || numericTaxRate > 100) {
        throw checkoutError('Tarif pajak pada pengaturan tidak valid');
      }

      for (const item of normalizedItems) {
        if (item.isCustom) {
          const lineTotal = roundMoney(item.price * item.quantity);
          subtotal = roundMoney(subtotal + lineTotal);
          pricedItems.push({ ...item, lineTotal });
          continue;
        }

        const product = await database.get(
          'SELECT id, name, price, cost_price, stock, active FROM products WHERE id = ? FOR UPDATE',
          [item.id]
        );
        if (!product || Number(product.active) !== 1) {
          throw checkoutError('Produk tidak tersedia atau sudah diarsipkan', 409);
        }

        const stock = projectedStocks.has(Number(product.id))
          ? projectedStocks.get(Number(product.id))
          : Number(product.stock || 0);
        if (stock < item.quantity) {
          throw checkoutError(`Stok ${product.name} tidak mencukupi. Tersisa ${stock}.`, 409);
        }

        const stockAfter = stock - item.quantity;
        projectedStocks.set(Number(product.id), stockAfter);

        const price = roundMoney(product.price);
        const lineTotal = roundMoney(price * item.quantity);
        subtotal = roundMoney(subtotal + lineTotal);
        pricedItems.push({
          id: Number(product.id),
          name: product.name,
          price,
          costPrice: roundMoney(product.cost_price || 0),
          quantity: item.quantity,
          lineTotal,
          stockBefore: stock,
          stockAfter,
          isCustom: false
        });
      }

      const totals = calculateCheckoutTotals({
        subtotal,
        discount: numericDiscount,
        taxRate: numericTaxRate,
        amountPaid: numericAmountPaid,
        paymentMethod
      });
      const { appliedDiscount, taxableSubtotal, vat, total, change } = {
        appliedDiscount: totals.discount,
        taxableSubtotal: totals.taxableSubtotal,
        vat: totals.vat,
        total: totals.total,
        change: totals.change
      };

      const transaction = await database.run(
        'INSERT INTO transactions (user_id, shift_id, customer_id, total, discount, vat, amount_paid, change, payment_method, payment_reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, activeShift.id, customerId, total, appliedDiscount, vat, numericAmountPaid, change, paymentMethod, paymentReference || null]
      );

      for (const item of pricedItems) {
        await database.run(
          'INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, price, cost_price) VALUES (?, ?, ?, ?, ?, ?)',
          [transaction.lastID, item.isCustom ? null : item.id, item.name, item.quantity, item.price, item.costPrice]
        );

        if (!item.isCustom) {
          const updated = await database.run(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND stock >= ?',
            [item.quantity, item.id, item.quantity]
          );
          if (updated.changes !== 1) {
            throw checkoutError(`Stok ${item.name} berubah. Silakan ulangi transaksi.`, 409);
          }

          await database.run(
            'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [item.id, req.user.id, 'sale', -item.quantity, item.stockBefore, item.stockAfter, 'Penjualan', 'transaction', String(transaction.lastID)]
          );
        }
      }

      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, after_data) VALUES (?, ?, ?, ?, ?::jsonb)',
        [req.user.id, 'checkout', 'transaction', String(transaction.lastID), JSON.stringify({ shiftId: activeShift.id, customerId, total, discount: appliedDiscount, vat, amountPaid: numericAmountPaid, paymentMethod, paymentReference: paymentReference || null, itemCount: pricedItems.length })]
      );

      return {
        transactionId: transaction.lastID,
        shiftId: activeShift.id,
        customerId,
        customerName: customer?.name || null,
        subtotal,
        discount: appliedDiscount,
        taxRate: numericTaxRate,
        vat,
        total,
        amountPaid: numericAmountPaid,
        change,
        paymentMethod,
        paymentReference: paymentReference || null,
        items: pricedItems.map(({ id, name, price, quantity, isCustom }) => ({ id, name, price, quantity, isCustom }))
      };
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(error.status || 500).json({
      error: error.message || 'Transaksi tidak dapat diproses'
    });
  }
});

app.post('/api/transactions/:id/void', requireRole(['super_admin', 'admin']), async (req, res) => {
  const transactionId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return res.status(400).json({ error: 'ID transaksi tidak valid' });
  }
  if (!reason) return res.status(400).json({ error: 'Alasan void wajib diisi' });

  try {
    const result = await getDb().transaction(async (database) => {
      const transaction = await database.get(
        'SELECT id, status, total FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
      );
      if (!transaction) throw checkoutError('Transaksi tidak ditemukan', 404);
      if (transaction.status !== 'completed') throw checkoutError('Transaksi sudah dibatalkan sebelumnya', 409);

      const items = await database.all(
        'SELECT product_id, product_name, quantity FROM transaction_items WHERE transaction_id = ? AND product_id IS NOT NULL ORDER BY id ASC',
        [transactionId]
      );

      for (const item of items) {
        const product = await database.get('SELECT id, name, stock FROM products WHERE id = ? FOR UPDATE', [item.product_id]);
        if (!product) continue;
        const stockBefore = Number(product.stock || 0);
        const stockAfter = stockBefore + Number(item.quantity || 0);
        await database.run('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
        await database.run(
          'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [item.product_id, req.user.id, 'void', Number(item.quantity || 0), stockBefore, stockAfter, `Void transaksi #${transactionId}: ${reason}`, 'transaction_void', String(transactionId)]
        );
      }

      await database.run(
        'UPDATE transactions SET status = ?, voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ? WHERE id = ? AND status = ?',
        ['voided', req.user.id, reason, transactionId, 'completed']
      );
      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, reason, after_data) VALUES (?, ?, ?, ?, ?, ?::jsonb)',
        [req.user.id, 'void', 'transaction', String(transactionId), reason, JSON.stringify({ status: 'voided', total: Number(transaction.total || 0), restoredItems: items.length })]
      );
      return { transactionId, restoredItems: items.length };
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Transaksi tidak dapat di-void' });
  }
});

app.post('/api/transactions/:id/returns', requireRole(['super_admin', 'admin']), async (req, res) => {
  const transactionId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return res.status(400).json({ error: 'ID transaksi tidak valid' });
  }
  if (!reason) return res.status(400).json({ error: 'Alasan retur wajib diisi' });
  if (requestedItems.length === 0) return res.status(400).json({ error: 'Pilih minimal satu barang untuk diretur' });

  const quantitiesByItem = new Map();
  for (const item of requestedItems) {
    const transactionItemId = Number(item?.transaction_item_id);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(transactionItemId) || transactionItemId <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Rincian jumlah retur tidak valid' });
    }
    quantitiesByItem.set(transactionItemId, (quantitiesByItem.get(transactionItemId) || 0) + quantity);
  }

  try {
    const result = await getDb().transaction(async (database) => {
      const transaction = await database.get(
        'SELECT id, status FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
      );
      if (!transaction) throw checkoutError('Transaksi tidak ditemukan', 404);
      if (transaction.status !== 'completed') throw checkoutError('Transaksi yang sudah VOID tidak dapat diretur', 409);

      const itemIds = [...quantitiesByItem.keys()].sort((left, right) => left - right);
      const returnableItems = [];
      for (const transactionItemId of itemIds) {
        const item = await database.get(
          `SELECT id, product_id, product_name, quantity, price
           FROM transaction_items
           WHERE id = ? AND transaction_id = ?
           FOR UPDATE`,
          [transactionItemId, transactionId]
        );
        if (!item) throw checkoutError('Barang retur tidak berasal dari transaksi tersebut', 400);

        const returned = await database.get(
          'SELECT COALESCE(SUM(quantity), 0)::int AS returned_quantity FROM transaction_return_items WHERE transaction_item_id = ?',
          [transactionItemId]
        );
        const soldQuantity = Number(item.quantity || 0);
        const returnedQuantity = Number(returned?.returned_quantity || 0);
        const availableQuantity = soldQuantity - returnedQuantity;
        const requestedQuantity = quantitiesByItem.get(transactionItemId);
        if (requestedQuantity > availableQuantity) {
          throw checkoutError(`Jumlah retur ${item.product_name || 'barang'} melebihi sisa yang dapat diretur (${availableQuantity})`, 409);
        }
        returnableItems.push({ ...item, quantity: requestedQuantity, availableQuantity });
      }

      const returnTotal = roundMoney(returnableItems.reduce((total, item) => total + Number(item.price || 0) * item.quantity, 0));
      const returnRecord = await database.run(
        'INSERT INTO transaction_returns (transaction_id, user_id, reason, total_amount) VALUES (?, ?, ?, ?) RETURNING id',
        [transactionId, req.user.id, reason, returnTotal]
      );
      const returnId = returnRecord.lastID;

      for (const item of returnableItems) {
        await database.run(
          'INSERT INTO transaction_return_items (return_id, transaction_item_id, product_id, quantity, price) VALUES (?, ?, ?, ?, ?)',
          [returnId, item.id, item.product_id, item.quantity, item.price]
        );

        if (item.product_id) {
          const product = await database.get(
            'SELECT id, name, stock FROM products WHERE id = ? FOR UPDATE',
            [item.product_id]
          );
          if (!product) throw checkoutError(`Produk ${item.product_name || item.product_id} sudah tidak tersedia`, 409);
          const stockBefore = Number(product.stock || 0);
          const stockAfter = stockBefore + item.quantity;
          await database.run('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
          await database.run(
            'INSERT INTO stock_movements (product_id, user_id, movement_type, quantity_change, stock_before, stock_after, reason, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [item.product_id, req.user.id, 'return', item.quantity, stockBefore, stockAfter, `Retur transaksi #${transactionId}: ${reason}`, 'transaction_return', String(returnId)]
          );
        }
      }

      await database.run(
        'INSERT INTO audit_logs (user_id, action, entity, entity_id, reason, after_data) VALUES (?, ?, ?, ?, ?, ?::jsonb)',
        [req.user.id, 'return', 'transaction', String(transactionId), reason, JSON.stringify({ returnId, total: returnTotal, itemCount: returnableItems.length })]
      );

      return {
        returnId,
        transactionId,
        total: returnTotal,
        items: returnableItems.map((item) => ({ transactionItemId: item.id, quantity: item.quantity, productId: item.product_id }))
      };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Retur tidak dapat diproses' });
  }
});

// GET transaction history for the dashboard
app.get('/api/transactions', requireRole(['super_admin', 'admin']), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size, 10) || 25));
  const { period = 'daily', startDate, endDate, includeVoided } = req.query;
  const conditions = includeVoided === 'true' ? [] : ["status = 'completed'"];
  const params = [];

  if (startDate && endDate) {
    conditions.push("date(timestamp, 'localtime') BETWEEN date(?) AND date(?)");
    params.push(startDate, endDate);
  } else if (period === 'weekly') {
    conditions.push("date(timestamp, 'localtime') >= date('now', 'localtime', '-6 days')");
  } else if (period === 'monthly') {
    conditions.push("strftime('%Y-%m', timestamp, 'localtime') = strftime('%Y-%m', 'now', 'localtime')");
  } else {
    conditions.push("date(timestamp, 'localtime') = date('now', 'localtime')");
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  try {
    const [count, summary, transactions] = await Promise.all([
      getDbRow(`SELECT COUNT(*)::int AS total FROM transactions ${whereClause}`, params),
      getDbRow(
        `WITH filtered_transactions AS (
           SELECT t.id, t.total, t.discount, t.vat, t.payment_method,
                  COALESCE((SELECT SUM(tr.total_amount) FROM transaction_returns tr WHERE tr.transaction_id = t.id), 0) AS returned_total
           FROM transactions t
           ${whereClause}
         ),
         transaction_summary AS (
           SELECT COUNT(*)::int AS transaction_count,
                  COALESCE(SUM(total), 0) AS total,
                  COALESCE(SUM(discount), 0) AS discount,
                  COALESCE(SUM(vat), 0) AS tax,
                  COALESCE(SUM(returned_total), 0) AS returned_total,
                  COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total - returned_total ELSE 0 END), 0) AS cash_total,
                  COALESCE(SUM(CASE WHEN payment_method = 'qris' THEN total - returned_total ELSE 0 END), 0) AS qris_total
           FROM filtered_transactions
         ),
         item_summary AS (
           SELECT COALESCE(SUM(GREATEST(ti.quantity - COALESCE((SELECT SUM(tri.quantity) FROM transaction_return_items tri WHERE tri.transaction_item_id = ti.id), 0), 0)), 0)::int AS item_count,
                  COALESCE(SUM(ti.price * ti.quantity), 0) AS gross_sales,
                  COALESCE(SUM((ti.price - ti.cost_price) * GREATEST(ti.quantity - COALESCE((SELECT SUM(tri.quantity) FROM transaction_return_items tri WHERE tri.transaction_item_id = ti.id), 0), 0)), 0) AS item_profit
           FROM transaction_items ti
           INNER JOIN filtered_transactions ft ON ft.id = ti.transaction_id
         )
         SELECT ts.transaction_count, ts.total, ts.discount, ts.tax, ts.returned_total,
                ts.cash_total, ts.qris_total, item_summary.item_count, item_summary.gross_sales,
                item_summary.item_profit - ts.discount AS profit
         FROM transaction_summary ts
         CROSS JOIN item_summary`,
        params
      ),
      allDbRows(
        `SELECT transactions.id, transactions.user_id, u.username, transactions.shift_id, transactions.customer_id, c.name AS customer_name, c.phone AS customer_phone,
                transactions.total, transactions.discount, transactions.vat, transactions.amount_paid, transactions.change, transactions.payment_method, transactions.payment_reference, transactions.status, transactions.voided_at, transactions.voided_by, transactions.void_reason, transactions.timestamp AS created_at,
                COALESCE((SELECT SUM(tr.total_amount) FROM transaction_returns tr WHERE tr.transaction_id = transactions.id), 0) AS returned_total
         FROM transactions
         LEFT JOIN users u ON u.id = transactions.user_id
         LEFT JOIN customers c ON c.id = transactions.customer_id
         ${whereClause}
         ORDER BY transactions.timestamp DESC, transactions.id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )
    ]);

    let items = [];
    if (transactions.length > 0) {
      const transactionIds = transactions.map((transaction) => transaction.id);
      items = await allDbRows(
        `SELECT ti.id AS transaction_item_id, ti.transaction_id, ti.product_id, ti.quantity, ti.price, ti.cost_price,
                COALESCE(ti.product_name, p.name, 'Item kustom') AS name,
                COALESCE((SELECT SUM(tri.quantity) FROM transaction_return_items tri WHERE tri.transaction_item_id = ti.id), 0)::int AS returned_quantity
         FROM transaction_items ti
         LEFT JOIN products p ON p.id = ti.product_id
         WHERE ti.transaction_id IN (${transactionIds.map(() => '?').join(',')})
         ORDER BY ti.id ASC`,
        transactionIds
      );
    }

    const itemsByTransaction = items.reduce((grouped, item) => {
      (grouped[item.transaction_id] ||= []).push(item);
      return grouped;
    }, {});
    const total = Number(count?.total || 0);
    return res.json({
      items: transactions.map((transaction) => ({
        ...transaction,
        items: itemsByTransaction[transaction.id] || []
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total ? Math.ceil(total / pageSize) : 0
      },
      summary: {
        transactionCount: Number(summary?.transaction_count || 0),
        itemCount: Number(summary?.item_count || 0),
        total: Number(summary?.total || 0),
        discount: Number(summary?.discount || 0),
        tax: Number(summary?.tax || 0),
        returnedTotal: Number(summary?.returned_total || 0),
        cashTotal: Number(summary?.cash_total || 0),
        qrisTotal: Number(summary?.qris_total || 0),
        grossSales: Number(summary?.gross_sales || 0),
        profit: Number(summary?.profit || 0)
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit-logs', requireRole(['super_admin', 'admin']), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size, 10) || 25));
  const action = String(req.query.action || '').trim().slice(0, 80);
  const entity = String(req.query.entity || '').trim().slice(0, 80);
  const conditions = [];
  const params = [];
  if (action) {
    conditions.push('al.action = ?');
    params.push(action);
  }
  if (entity) {
    conditions.push('al.entity = ?');
    params.push(entity);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const offset = (page - 1) * pageSize;
    const countParams = [...params];
    const [count, items] = await Promise.all([
      getDbRow(`SELECT COUNT(*)::int AS total FROM audit_logs al ${whereClause}`, countParams),
      allDbRows(
        `SELECT al.id, al.user_id, u.username, al.action, al.entity, al.entity_id,
                al.before_data, al.after_data, al.reason, al.created_at
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         ${whereClause}
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )
    ]);
    const total = Number(count?.total || 0);
    return res.json({
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total ? Math.ceil(total / pageSize) : 0
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET dashboard stats
app.get('/api/stats', requireRole(['super_admin', 'admin']), (req, res) => {
  getDb().get("SELECT COUNT(*) as transactions, SUM(total) as revenue FROM transactions WHERE status = 'completed' AND date(timestamp, 'localtime') = date('now', 'localtime')", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    
    getDb().all('SELECT * FROM products WHERE stock < 10', (err, lowStock) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        dailyRevenue: row.revenue || 0,
        transactions: row.transactions || 0,
        lowStockItems: lowStock
      });
    });
  });
});

// GET local network IP and Tunnel URL for mobile scanner
const os = require('os');
app.get('/api/ip', requireRole(['super_admin', 'admin', 'cashier']), (req, res) => {
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1)
      if (net.family === 'IPv4' && !net.internal) {
        ip = net.address;
        break;
      }
    }
    if (ip !== 'localhost') break;
  }
  res.json({
    ip,
    httpsPort: req.app.locals.httpsPort || 3002,
    mobilePosAvailable: require('fs').existsSync(path.join(frontendDist, 'index.html'))
  });
});

// Generic error handler middleware
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

function initServer(port = 3001) {
  const database = initDb();
  
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Please close any other instances.`);
    } else {
      console.error(`Server error: ${e.message}`);
    }
  });

  server.listen(port, '0.0.0.0', () => {
  console.log(`Backend running on http://localhost:${port}`);
  
  // 🚀 Tambahkan baris ini di sini agar worker realtime Anda aktif saat server menyala
  database.ready
    .then(async () => {
      try {
        await cleanupOldSalesIfDue();
      } catch (error) {
        console.error('Pembersihan otomatis data penjualan gagal:', error.message);
      }
      return initRealtimeSync(io);
    })
    .catch((error) => console.error('Database initialization failed:', error.message));
});

  const salesCleanupTimer = setInterval(() => {
    cleanupOldSalesIfDue().catch((error) => {
      console.error('Pembersihan otomatis data penjualan gagal:', error.message);
    });
  }, SALES_CLEANUP_INTERVAL_MS);
  salesCleanupTimer.unref?.();


  // Start HTTPS server on port + 1 to bypass mobile camera restrictions
  (async () => {
    try {
      const os = require('os');
      const nets = os.networkInterfaces();
      let ip = 'localhost';
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            ip = net.address;
            break;
          }
        }
        if (ip !== 'localhost') break;
      }

      const attrs = [{ name: 'commonName', value: ip }];
      const opts = {
        days: 365,
        extensions: [{
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' }, // DNS
            { type: 7, ip: '127.0.0.1' },    // IP
            { type: 7, ip: ip }              // IP
          ]
        }]
      };
      
      const pems = await selfsigned.generate(attrs, opts);
      const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
      io.attach(httpsServer);
      
      const httpsPort = parseInt(port) + 1;
      app.locals.httpsPort = httpsPort;
      
      httpsServer.listen(httpsPort, '0.0.0.0', () => {
        console.log(`Secure Backend running on https://localhost:${httpsPort}`);
        console.log(`Mobile scanner: https://${ip}:${httpsPort}/scanner`);
        if (require('fs').existsSync(frontendDist)) {
          console.log(`Mobile POS app: https://${ip}:${httpsPort}/`);
        }
      });
      
      httpsServer.on('error', (e) => {
        console.error(`HTTPS Server error: ${e.message}`);
      });
    } catch (err) {
      console.error('Failed to start local HTTPS server:', err);
    }
  })();

  return { app, server, io };
}

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  initServer(PORT);
}

module.exports = { initServer };
