const test = require('node:test');
const assert = require('node:assert/strict');
const { PAYMENT_METHODS, calculateCheckoutTotals } = require('../backend/checkoutRules');

test('checkout menghitung diskon, pajak, total, dan kembalian dari subtotal server', () => {
  const result = calculateCheckoutTotals({
    subtotal: 1000,
    discount: 100,
    taxRate: 10,
    amountPaid: 1000,
    paymentMethod: 'cash'
  });

  assert.deepEqual(result, {
    subtotal: 1000,
    discount: 100,
    taxableSubtotal: 900,
    taxRate: 10,
    vat: 90,
    total: 990,
    amountPaid: 1000,
    change: 10,
    paymentMethod: 'cash'
  });
});

test('checkout hanya menerima Tunai dan QRIS', () => {
  assert.deepEqual([...PAYMENT_METHODS].sort(), ['cash', 'qris']);
  assert.equal(calculateCheckoutTotals({ subtotal: 25000, amountPaid: 25000, paymentMethod: 'QRIS' }).paymentMethod, 'qris');
  assert.throws(
    () => calculateCheckoutTotals({ subtotal: 25000, amountPaid: 25000, paymentMethod: 'bank_transfer' }),
    /Metode pembayaran hanya Tunai atau QRIS/
  );
});

test('pembayaran QRIS harus sama persis dengan total', () => {
  assert.equal(calculateCheckoutTotals({ subtotal: 12500, amountPaid: 12500, paymentMethod: 'qris' }).change, 0);
  assert.throws(
    () => calculateCheckoutTotals({ subtotal: 12500, amountPaid: 13000, paymentMethod: 'qris' }),
    /Pembayaran non-tunai harus sama dengan total tagihan/
  );
});

test('checkout menolak diskon, pajak, dan pembayaran yang tidak valid', () => {
  assert.throws(() => calculateCheckoutTotals({ subtotal: 100, discount: 101, amountPaid: 0 }), /Potongan harga/);
  assert.throws(() => calculateCheckoutTotals({ subtotal: 100, taxRate: 101, amountPaid: 100 }), /Persentase pajak/);
  assert.throws(() => calculateCheckoutTotals({ subtotal: 100, amountPaid: 99 }), /Pembayaran kurang/);
});

