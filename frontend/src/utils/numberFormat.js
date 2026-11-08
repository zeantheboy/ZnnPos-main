export function formatNumber(value, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';

  return number.toLocaleString('id-ID', {
    maximumFractionDigits: 2,
    ...options
  });
}

export function formatCurrency(value, currency = 'Rp ') {
  return `${currency}${formatNumber(value)}`;
}
