const PAYMENT_METHODS = new Set(['cash', 'qris']);

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const checkoutRuleError = (message) => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const calculateCheckoutTotals = ({ subtotal, discount = 0, taxRate = 0, amountPaid, paymentMethod = 'cash' }) => {
  const numericSubtotal = Number(subtotal);
  const numericDiscount = Number(discount);
  const numericTaxRate = Number(taxRate);
  const numericAmountPaid = Number(amountPaid);
  const normalizedPaymentMethod = String(paymentMethod || 'cash').trim().toLowerCase();

  if (!Number.isFinite(numericSubtotal) || numericSubtotal < 0) {
    throw checkoutRuleError('Subtotal tidak valid');
  }
  if (!Number.isFinite(numericDiscount) || numericDiscount < 0) {
    throw checkoutRuleError('Potongan harga tidak valid');
  }
  if (numericDiscount > numericSubtotal) {
    throw checkoutRuleError('Potongan harga tidak boleh lebih besar dari subtotal');
  }
  if (!Number.isFinite(numericTaxRate) || numericTaxRate < 0 || numericTaxRate > 100) {
    throw checkoutRuleError('Persentase pajak harus berada di antara 0 dan 100');
  }
  if (!Number.isFinite(numericAmountPaid) || numericAmountPaid < 0) {
    throw checkoutRuleError('Nominal pembayaran tidak valid');
  }
  if (!PAYMENT_METHODS.has(normalizedPaymentMethod)) {
    throw checkoutRuleError('Metode pembayaran hanya Tunai atau QRIS');
  }

  const appliedDiscount = roundMoney(numericDiscount);
  const taxableSubtotal = roundMoney(numericSubtotal - appliedDiscount);
  const vat = roundMoney(taxableSubtotal * numericTaxRate / 100);
  const total = roundMoney(taxableSubtotal + vat);
  if (numericAmountPaid < total) {
    throw checkoutRuleError(`Pembayaran kurang ${roundMoney(total - numericAmountPaid)}`);
  }
  if (normalizedPaymentMethod !== 'cash' && roundMoney(numericAmountPaid) !== total) {
    throw checkoutRuleError('Pembayaran non-tunai harus sama dengan total tagihan');
  }

  return {
    subtotal: roundMoney(numericSubtotal),
    discount: appliedDiscount,
    taxableSubtotal,
    taxRate: numericTaxRate,
    vat,
    total,
    amountPaid: roundMoney(numericAmountPaid),
    change: normalizedPaymentMethod === 'cash' ? roundMoney(numericAmountPaid - total) : 0,
    paymentMethod: normalizedPaymentMethod
  };
};

module.exports = { PAYMENT_METHODS, roundMoney, calculateCheckoutTotals };

