const ensureRemoteSchema = async (pool) => {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.stores (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      license_key TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO public.stores (code, name, status)
    VALUES ('utama', 'Toko Utama', 'active')
    ON CONFLICT (code) DO NOTHING;

    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE public.transaction_items ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS store_id BIGINT;
    ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS id BIGSERIAL;
    -- Harus diaktifkan sebelum UPDATE app_settings di bawah karena tabel ini
    -- dipublikasikan oleh Supabase Realtime dan tidak memiliki primary key.
    ALTER TABLE public.app_settings REPLICA IDENTITY FULL;

    UPDATE public.products
    SET store_id = COALESCE(store_id, (SELECT id FROM public.stores WHERE code = 'utama' LIMIT 1))
    WHERE store_id IS NULL;
    UPDATE public.transactions
    SET store_id = COALESCE(store_id, (SELECT id FROM public.stores WHERE code = 'utama' LIMIT 1))
    WHERE store_id IS NULL;
    UPDATE public.transaction_items ti
    SET store_id = COALESCE(ti.store_id, t.store_id)
    FROM public.transactions t
    WHERE t.id = ti.transaction_id AND ti.store_id IS NULL;
    UPDATE public.transaction_items
    SET store_id = COALESCE(store_id, (SELECT id FROM public.stores WHERE code = 'utama' LIMIT 1))
    WHERE store_id IS NULL;
    UPDATE public.app_settings
    SET store_id = COALESCE(store_id, (SELECT id FROM public.stores WHERE code = 'utama' LIMIT 1))
    WHERE store_id IS NULL;

    ALTER TABLE public.products ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE public.transactions ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE public.transaction_items ALTER COLUMN store_id SET NOT NULL;
    ALTER TABLE public.app_settings ALTER COLUMN store_id SET NOT NULL;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_barcode_key') THEN
        ALTER TABLE public.products DROP CONSTRAINT products_barcode_key;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_pkey') THEN
        ALTER TABLE public.app_settings DROP CONSTRAINT app_settings_pkey;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS products_store_barcode_unique ON public.products (store_id, barcode);
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_store_key_unique ON public.app_settings (store_id, key);
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_id_unique ON public.app_settings (id);

    ALTER TABLE public.transactions
      ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash',
      ADD COLUMN IF NOT EXISTS payment_reference TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_by INTEGER,
      ADD COLUMN IF NOT EXISTS void_reason TEXT;
    ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('completed', 'voided'));
    CREATE INDEX IF NOT EXISTS transactions_status_timestamp_idx
      ON public.transactions (status, timestamp DESC);
  `);
};

module.exports = { ensureRemoteSchema };
