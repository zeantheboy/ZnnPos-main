// Tabel yang diizinkan untuk disinkronkan dua arah.
// Saat menambah tabel baru, tambahkan definisinya di sini setelah tabel
// tersebut dibuat pada database lokal dan Supabase.
const SYNC_TABLES = Object.freeze({
  products: Object.freeze({
    key: 'id',
    columns: Object.freeze(['id', 'store_id', 'name', 'barcode', 'price', 'cost_price', 'category', 'stock', 'active'])
  }),
  transactions: Object.freeze({
    key: 'id',
    columns: Object.freeze(['id', 'store_id', 'total', 'discount', 'vat', 'amount_paid', 'change', 'payment_method', 'payment_reference', 'status', 'voided_at', 'voided_by', 'void_reason', 'timestamp'])
  }),
  transaction_items: Object.freeze({
    key: 'id',
    columns: Object.freeze(['id', 'store_id', 'transaction_id', 'product_id', 'product_name', 'quantity', 'price', 'cost_price'])
  }),
  app_settings: Object.freeze({
    key: 'id',
    columns: Object.freeze(['id', 'store_id', 'key', 'value'])
  })
});

module.exports = { SYNC_TABLES };
