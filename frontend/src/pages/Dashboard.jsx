import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { DollarSign, ShoppingBag, AlertTriangle, X, Download, Printer, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/useAuth';
import { formatNumber } from '../utils/numberFormat';

const readStoredSettings = () => {
  try {
    return JSON.parse(localStorage.getItem('pos_settings') || '{}');
  } catch {
    return {};
  }
};

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ dailyRevenue: 0, transactions: 0, lowStockItems: [] });
  const [settings, setSettings] = useState(readStoredSettings);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [reportPagination, setReportPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [reportSummary, setReportSummary] = useState({ transactionCount: 0, itemCount: 0, total: 0, discount: 0, tax: 0, returnedTotal: 0, cashTotal: 0, qrisTotal: 0, grossSales: 0, profit: 0 });
  const [showModal, setShowModal] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportPrintLoading, setReportPrintLoading] = useState(false);
  const [reportPeriod, setReportPeriod] = useState('daily');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [voidingId, setVoidingId] = useState(null);
  const [returningTransaction, setReturningTransaction] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState('');
  const [returnSaving, setReturnSaving] = useState(false);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditPagination, setAuditPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [auditLoading, setAuditLoading] = useState(false);
  const currency = settings.currency || 'Rp ';
  const storeName = /^znnpos$/i.test(settings.storeName || '') ? (user?.storeName || 'Toko Utama') : settings.storeName || user?.storeName || 'Toko Utama';

  const fetchStats = async () => {
    try {
      const res = await api.get('/stats');
      setStats(res.data);
    } catch (err) {
      toast.error('Gagal memuat statistik analisis');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadSettings = async () => {
      try {
        const response = await api.get('/settings');
        if (!mounted) return;
        const nextSettings = response.data || {};
        setSettings(nextSettings);
        localStorage.setItem('pos_settings', JSON.stringify(nextSettings));
      } catch {
        // Pengaturan lokal tetap dipakai jika backend sedang tidak tersedia.
      }
    };
    const handleSettingsUpdated = () => setSettings(readStoredSettings());
    loadSettings();
    window.addEventListener('settings_updated', handleSettingsUpdated);
    return () => {
      mounted = false;
      window.removeEventListener('settings_updated', handleSettingsUpdated);
    };
  }, [user?.storeId]);

  const getReportParams = () => {
    if (reportPeriod === 'custom') {
      return { startDate: customStartDate, endDate: customEndDate };
    }
    return { period: reportPeriod };
  };

  const loadReport = async (page = 1) => {
    if (reportLoading) return;
    if (reportPeriod === 'custom' && (!customStartDate || !customEndDate)) {
      toast.error('Pilih tanggal awal dan tanggal akhir terlebih dahulu');
      return;
    }
    setReportLoading(true);
    try {
      const res = await api.get('/transactions', { params: { ...getReportParams(), page, page_size: 25 } });
      const payload = Array.isArray(res.data) ? { items: res.data } : (res.data || {});
      const nextHistory = payload.items || [];
      setHistory(nextHistory);
      setReportPagination(payload.pagination || { page, pageSize: 25, total: nextHistory.length, totalPages: nextHistory.length ? 1 : 0 });
      setReportSummary(payload.summary || {
        transactionCount: nextHistory.length,
        itemCount: nextHistory.reduce((sum, transaction) => sum + (transaction.items || []).reduce((itemSum, item) => itemSum + Math.max(Number(item.quantity || 0) - Number(item.returned_quantity || 0), 0), 0), 0),
        total: nextHistory.reduce((sum, transaction) => sum + Number(transaction.total || 0), 0),
        discount: nextHistory.reduce((sum, transaction) => sum + Number(transaction.discount || 0), 0),
        tax: nextHistory.reduce((sum, transaction) => sum + Number(transaction.vat || 0), 0),
        returnedTotal: nextHistory.reduce((sum, transaction) => sum + Number(transaction.returned_total || 0), 0),
        cashTotal: nextHistory.filter((transaction) => transaction.payment_method === 'cash').reduce((sum, transaction) => sum + Number(transaction.total || 0), 0),
        qrisTotal: nextHistory.filter((transaction) => transaction.payment_method === 'qris').reduce((sum, transaction) => sum + Number(transaction.total || 0), 0),
        grossSales: nextHistory.reduce((sum, transaction) => sum + (transaction.items || []).reduce((itemSum, item) => itemSum + (Number(item.price || 0) * Number(item.quantity || 0)), 0), 0),
        profit: nextHistory.reduce((sum, transaction) => sum + (transaction.items || []).reduce((itemSum, item) => itemSum + ((Number(item.price || 0) - Number(item.cost_price || 0)) * Math.max(Number(item.quantity || 0) - Number(item.returned_quantity || 0), 0)), 0) - Number(transaction.discount || 0), 0)
      });
      return payload;
    } catch (err) {
      toast.error('Gagal memuat riwayat transaksi. Silakan cek server.');
      console.error(err);
    } finally {
      setReportLoading(false);
    }
  };

  const handleOpenReport = async () => {
    const data = await loadReport();
    if (data) setShowModal(true);
  };

  const handleVoidTransaction = async (transaction) => {
    const reason = window.prompt(`Alasan membatalkan transaksi #${formatNumber(transaction.id)}:`, 'Kesalahan transaksi');
    if (reason === null || !reason.trim()) return;
    setVoidingId(transaction.id);
    try {
      await api.post(`/transactions/${transaction.id}/void`, { reason: reason.trim() });
      toast.success(`Transaksi #${formatNumber(transaction.id)} berhasil di-void dan stok dikembalikan`);
      await Promise.all([fetchStats(), loadReport()]);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Transaksi gagal di-void');
    } finally {
      setVoidingId(null);
    }
  };

  const openReturnModal = (transaction) => {
    const quantities = (transaction.items || []).reduce((result, item) => {
      result[item.transaction_item_id] = '0';
      return result;
    }, {});
    setReturningTransaction(transaction);
    setReturnQuantities(quantities);
    setReturnReason('');
  };

  const closeReturnModal = () => {
    if (returnSaving) return;
    setReturningTransaction(null);
  };

  const handleReturnTransaction = async (event) => {
    event.preventDefault();
    if (!returningTransaction) return;
    const items = Object.entries(returnQuantities)
      .map(([transactionItemId, quantity]) => ({ transaction_item_id: Number(transactionItemId), quantity: Number(quantity) }))
      .filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
    if (!items.length) {
      toast.error('Masukkan jumlah retur minimal satu barang');
      return;
    }
    if (!returnReason.trim()) {
      toast.error('Alasan retur wajib diisi');
      return;
    }

    setReturnSaving(true);
    try {
      const response = await api.post(`/transactions/${returningTransaction.id}/returns`, {
        reason: returnReason.trim(),
        items
      });
      toast.success(`Retur transaksi #${formatNumber(returningTransaction.id)} tersimpan sebesar ${formatCurrency(response.data.total)}`);
      setReturningTransaction(null);
      await Promise.all([fetchStats(), loadReport()]);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Retur gagal diproses');
    } finally {
      setReturnSaving(false);
    }
  };

  const loadAuditLogs = async (page = 1) => {
    setAuditLoading(true);
    try {
      const response = await api.get('/audit-logs', { params: { page, page_size: 25 } });
      setAuditLogs(response.data.items || []);
      setAuditPagination(response.data.pagination || { page, pageSize: 25, total: 0, totalPages: 0 });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memuat log aktivitas');
    } finally {
      setAuditLoading(false);
    }
  };

  const formatAuditData = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const reportTitle = reportPeriod === 'daily' ? 'Harian' : reportPeriod === 'weekly' ? 'Mingguan' : reportPeriod === 'monthly' ? 'Bulanan' : 'Rentang Tanggal';
  const reportTotal = Number(reportSummary.total || 0);
  const reportReturnedTotal = Number(reportSummary.returnedTotal || 0);
  const reportDiscount = Number(reportSummary.discount || 0);
  const reportProfit = Number(reportSummary.profit || 0);
  const reportTax = Number(reportSummary.tax || 0);
  const reportGrossSales = Number(reportSummary.grossSales || 0);
  const reportNetSales = reportGrossSales - reportDiscount - reportReturnedTotal;
  const reportCollectedTotal = reportTotal - reportReturnedTotal;
  const reportAverageTransaction = reportSummary.transactionCount ? reportCollectedTotal / Number(reportSummary.transactionCount) : 0;
  const reportCashTotal = Number(reportSummary.cashTotal || 0);
  const reportQrisTotal = Number(reportSummary.qrisTotal || 0);
  const reportItemCount = Number(reportSummary.itemCount || 0);
  const formatCurrency = (value) => `${currency}${formatNumber(value)}`;
  const parseDatabaseTimestamp = (value) => {
    if (!value) return null;
    const text = String(value);
    return new Date(text.endsWith('Z') ? text : `${text.replace(' ', 'T')}Z`);
  };
  const formatDateTime = (value) => {
    const parsed = parseDatabaseTimestamp(value);
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString('id-ID') : String(value || '-');
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const loadAllReportTransactions = async () => {
    const params = { ...getReportParams(), page: 1, page_size: 100 };
    const firstResponse = await api.get('/transactions', { params });
    const firstPayload = Array.isArray(firstResponse.data) ? { items: firstResponse.data } : (firstResponse.data || {});
    const totalPages = Number(firstPayload.pagination?.totalPages || 1);
    const pageRequests = [];
    for (let page = 2; page <= totalPages; page += 1) {
      pageRequests.push(api.get('/transactions', { params: { ...params, page } }));
    }
    const remainingResponses = await Promise.all(pageRequests);
    return [firstPayload.items || [], ...remainingResponses.map((response) => {
      const payload = Array.isArray(response.data) ? { items: response.data } : (response.data || {});
      return payload.items || [];
    })].flat();
  };

  const getReportMetrics = (transactions) => {
    const metrics = {
      transactionCount: transactions.length,
      itemCount: 0,
      grossSales: 0,
      discount: 0,
      tax: 0,
      returnedTotal: 0,
      total: 0,
      profit: 0,
      cashTotal: 0,
      qrisTotal: 0
    };
    transactions.forEach((transaction) => {
      const returnedTotal = Number(transaction.returned_total || 0);
      const collectedTotal = Number(transaction.total || 0) - returnedTotal;
      metrics.discount += Number(transaction.discount || 0);
      metrics.tax += Number(transaction.vat || 0);
      metrics.returnedTotal += returnedTotal;
      metrics.total += Number(transaction.total || 0);
      if (transaction.payment_method === 'qris') metrics.qrisTotal += collectedTotal;
      else metrics.cashTotal += collectedTotal;
      const transactionItems = transaction.items?.length ? transaction.items : [{ name: 'Item kustom', quantity: 1, returned_quantity: 0, price: transaction.total, cost_price: 0 }];
      transactionItems.forEach((item) => {
        const quantity = Number(item.quantity || 0);
        const returnedQuantity = Number(item.returned_quantity || 0);
        const netQuantity = Math.max(quantity - returnedQuantity, 0);
        metrics.itemCount += netQuantity;
        metrics.grossSales += Number(item.price || 0) * quantity;
        metrics.profit += (Number(item.price || 0) - Number(item.cost_price || 0)) * netQuantity;
      });
    });
    metrics.profit -= metrics.discount;
    return metrics;
  };

  const handlePrintReport = async () => {
    const printWindow = window.open('', '_blank', 'width=1200,height=800');
    if (!printWindow) {
      toast.error('Izinkan pop-up browser untuk mencetak laporan');
      return;
    }
    setReportPrintLoading(true);
    try {
      const transactions = await loadAllReportTransactions();
      const metrics = getReportMetrics(transactions);
      const netSales = metrics.grossSales - metrics.discount - metrics.returnedTotal;
      const collectedTotal = metrics.total - metrics.returnedTotal;
      const averageTransaction = metrics.transactionCount ? collectedTotal / metrics.transactionCount : 0;
      const paymentLabel = { cash: 'Tunai', qris: 'QRIS' };
      const detailRows = transactions.flatMap((transaction) => {
        const transactionItems = transaction.items?.length ? transaction.items : [{ name: 'Item kustom', quantity: 1, returned_quantity: 0, price: transaction.total, cost_price: 0 }];
        return transactionItems.map((item) => {
          const quantity = Number(item.quantity || 0);
          const returnedQuantity = Number(item.returned_quantity || 0);
          const netQuantity = Math.max(quantity - returnedQuantity, 0);
          const lineTotal = Number(item.price || 0) * quantity;
          const lineProfit = (Number(item.price || 0) - Number(item.cost_price || 0)) * netQuantity;
          return `<tr><td>${escapeHtml(formatNumber(transaction.id))}</td><td>${escapeHtml(formatDateTime(transaction.created_at))}</td><td>${escapeHtml(transaction.username || '-')}</td><td>${escapeHtml(paymentLabel[transaction.payment_method] || transaction.payment_method || 'Tunai')}</td><td>${escapeHtml(item.name)}</td><td class="num">${formatNumber(quantity)}</td><td class="num">${formatNumber(returnedQuantity)}</td><td class="num">${formatCurrency(item.price)}</td><td class="num">${formatCurrency(lineTotal)}</td><td class="num">${formatCurrency(lineProfit)}</td></tr>`;
        });
      }).join('');
      const summaryRows = [
        ['Transaksi', formatNumber(metrics.transactionCount)],
        ['Barang terjual bersih', formatNumber(metrics.itemCount)],
        ['Penjualan kotor', formatCurrency(metrics.grossSales)],
        ['Potongan', formatCurrency(metrics.discount)],
        ['Retur', formatCurrency(metrics.returnedTotal)],
        ['Penjualan bersih', formatCurrency(netSales)],
        ['Pajak', formatCurrency(metrics.tax)],
        ['Total dibayar', formatCurrency(collectedTotal)],
        ['Tunai', formatCurrency(metrics.cashTotal)],
        ['QRIS', formatCurrency(metrics.qrisTotal)],
        ['Rata-rata transaksi', formatCurrency(averageTransaction)],
        ['Keuntungan', formatCurrency(metrics.profit)]
      ].map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('');
      printWindow.document.write(`<html><head><title>ZnnCashier - ${escapeHtml(storeName)} - Laporan Keuangan ${escapeHtml(reportTitle)}</title><style>
        @page { size: A4 landscape; margin: 10mm; }*{box-sizing:border-box}body{font-family:Arial,sans-serif;padding:8px;color:#111;font-size:11px}h1{font-size:20px;margin:0 0 2px;color:#2563eb}h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #2563eb;padding-bottom:4px}.store-name{font-size:15px;font-weight:700;margin:0 0 10px}.meta{color:#555;margin:0 0 12px}.summary-table{border-collapse:collapse;width:100%;max-width:520px}.summary-table th,.summary-table td{border:1px solid #bbb;padding:5px;text-align:left}.summary-table th{width:55%;background:#eff6ff}.detail-table{border-collapse:collapse;width:100%;margin-top:6px}.detail-table th,.detail-table td{border:1px solid #aaa;padding:4px 5px;text-align:left;vertical-align:top}.detail-table th{background:#dbeafe;color:#0f172a}.detail-table .num{text-align:right;white-space:nowrap}thead{display:table-header-group}tr{break-inside:avoid}.footer{margin-top:14px;color:#555;font-size:10px}@media print{.detail-table{font-size:9px}}
      </style></head><body><h1>ZnnCashier</h1><p class="store-name">${escapeHtml(storeName)}</p><p class="meta">Laporan Keuangan Penjualan · Format kertas: A4 landscape · Periode: ${escapeHtml(reportTitle)} · Dicetak: ${escapeHtml(new Date().toLocaleString('id-ID'))}</p><h2>Ringkasan Keuangan</h2><table class="summary-table"><tbody>${summaryRows}</tbody></table><h2>Rincian Transaksi dan Produk</h2><table class="detail-table"><thead><tr><th>No. Transaksi</th><th>Tanggal</th><th>Kasir</th><th>Pembayaran</th><th>Produk</th><th>Qty</th><th>Retur</th><th>Harga</th><th>Total Baris</th><th>Untung</th></tr></thead><tbody>${detailRows || '<tr><td colspan="10">Tidak ada transaksi.</td></tr>'}</tbody></table><p class="footer">Catatan: Penjualan bersih = penjualan kotor - potongan - retur. Keuntungan memakai harga modal yang tersimpan pada saat transaksi.</p></body></html>`);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
    } catch (err) {
      printWindow.close();
      toast.error(err.response?.data?.error || 'Gagal menyiapkan laporan cetak');
    } finally {
      setReportPrintLoading(false);
    }
  };

  const handleExportExcel = async () => {
    setReportPrintLoading(true);
    try {
      const transactions = await loadAllReportTransactions();
      const metrics = getReportMetrics(transactions);
      const netSales = metrics.grossSales - metrics.discount - metrics.returnedTotal;
      const rows = [
        ['ZnnCashier', storeName],
        ['Laporan Keuangan Penjualan', reportTitle],
        ['Total transaksi', metrics.transactionCount],
        ['Barang terjual bersih', metrics.itemCount],
        ['Penjualan kotor', metrics.grossSales],
        ['Total potongan', metrics.discount],
        ['Total retur', metrics.returnedTotal],
        ['Penjualan bersih', netSales],
        ['Pajak', metrics.tax],
        ['Total dibayar', metrics.total - metrics.returnedTotal],
        ['Tunai', metrics.cashTotal],
        ['QRIS', metrics.qrisTotal],
        ['Total keuntungan', metrics.profit],
        [],
        ['No. Transaksi', 'Tanggal', 'Kasir', 'Pembayaran', 'Barang', 'Jumlah', 'Retur', 'Harga Jual', 'Harga Modal', 'Untung', 'Total Baris']
      ];
      transactions.forEach((transaction) => (transaction.items?.length ? transaction.items : [{ name: 'Item kustom', quantity: 1, returned_quantity: 0, price: transaction.total, cost_price: 0 }]).forEach((item) => {
        const quantity = Number(item.quantity || 0);
        const returnedQuantity = Number(item.returned_quantity || 0);
        const netQuantity = Math.max(quantity - returnedQuantity, 0);
        rows.push([
          transaction.id,
          formatDateTime(transaction.created_at),
          transaction.username || '-',
          transaction.payment_method === 'qris' ? 'QRIS' : 'Tunai',
          item.name,
          quantity,
          returnedQuantity,
          item.price,
          item.cost_price,
          (Number(item.price || 0) - Number(item.cost_price || 0)) * netQuantity,
          Number(item.price || 0) * quantity
        ]);
      }));
      const content = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join('\t')).join('\n');
      const blob = new Blob([`\ufeff${content}`], { type: 'application/vnd.ms-excel;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `laporan-transaksi-${reportPeriod}.xls`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menyiapkan ekspor laporan');
    } finally {
      setReportPrintLoading(false);
    }
  };

  if (loading) return <div style={{ padding: '2rem' }}>Memuat analisis...</div>;

  return (
    <div style={{ padding: '1rem', width: '100%', display: 'flex', flexDirection: 'column', gap: '2rem', paddingBottom: '90px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.75rem', fontWeight: '700' }}>Dashboard Analisis</h2>
          <p style={{ margin: '0.2rem 0 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Berikut ringkasan kondisi toko Anda hari ini.</p>
        </div>
        <button type="button" onClick={() => { setShowAuditModal(true); loadAuditLogs(1); }} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 12px', borderRadius: '7px', border: '1px solid var(--border-color)', background: 'var(--surface-opaque)', color: 'var(--text-primary)', fontWeight: '700', cursor: 'pointer' }}>
          Log Aktivitas
        </button>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem' }}>
        
        <div style={{ backgroundColor: 'var(--surface-color)', padding: '1.5rem', borderRadius: 'var(--radius-lg)', border: '1px solid rgba(59, 130, 246, 0.2)', display: 'flex', alignItems: 'center', gap: '1.5rem', boxShadow: '0 10px 25px -5px rgba(59, 130, 246, 0.1)', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: '-20px', right: '-20px', width: '100px', height: '100px', background: 'radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, transparent 70%)', borderRadius: '50%' }} />
          <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', padding: '1.2rem', borderRadius: 'var(--radius-md)', color: 'var(--primary)' }}>
            <DollarSign size={32} />
          </div>
          <div style={{ zIndex: 1 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', fontWeight: '500', marginBottom: '0.2rem' }}>Pendapatan Harian</div>
            <div style={{ fontSize: '2.2rem', fontWeight: '800', color: 'var(--text-primary)' }}>{formatCurrency(stats.dailyRevenue || 0)}</div>
          </div>
        </div>

        <div 
          onClick={handleOpenReport}
          style={{ backgroundColor: 'var(--surface-color)', padding: '1.5rem', borderRadius: 'var(--radius-lg)', border: '1px solid rgba(59, 130, 246, 0.2)', display: 'flex', alignItems: 'center', gap: '1.5rem', boxShadow: '0 10px 25px -5px rgba(59, 130, 246, 0.1)', position: 'relative', overflow: 'hidden', cursor: 'pointer' }}
        >
          <div style={{ position: 'absolute', top: '-20px', right: '-20px', width: '100px', height: '100px', background: 'radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, transparent 70%)', borderRadius: '50%' }} />
          <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', padding: '1.2rem', borderRadius: 'var(--radius-md)', color: 'var(--primary)' }}>
            <ShoppingBag size={32} />
          </div>
          <div style={{ zIndex: 1 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', fontWeight: '500', marginBottom: '0.2rem' }}>Transaksi ➔</div>
            <div style={{ fontSize: '2.2rem', fontWeight: '800', color: 'var(--text-primary)' }}>{formatNumber(stats.transactions || 0)} <span style={{ fontSize: '11px', color: 'var(--primary)', display: 'block', fontWeight: 'normal', marginTop: '-4px' }}>{reportLoading ? 'Memuat laporan...' : 'Klik lihat laporan'}</span></div>
          </div>
        </div>

      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
        <div style={{ backgroundColor: 'var(--surface-color)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--danger)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ padding: '1.2rem 1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.8rem', color: 'var(--danger)', fontWeight: '700', backgroundColor: 'rgba(244, 63, 94, 0.05)' }}>
            <AlertTriangle size={22} /> Peringatan Stok Menipis
          </div>
          <div style={{ padding: '0' }}>
            {stats.lowStockItems.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Semua barang memiliki tingkat stok yang mencukupi.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {stats.lowStockItems.map((item, idx) => (
                  <div key={item.id} style={{ padding: '1.2rem 1.5rem', borderBottom: idx === stats.lowStockItems.length - 1 ? 'none' : '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong style={{ fontSize: '1.05rem' }}>{item.name}</strong>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.2rem' }}>Barcode: {item.barcode}</div>
                    </div>
                    <div style={{ backgroundColor: 'rgba(244, 63, 94, 0.1)', color: 'var(--danger)', padding: '0.4rem 1rem', borderRadius: 'var(--radius-full)', fontWeight: 'bold', fontSize: '0.9rem' }}>
                      {formatNumber(item.stock)} tersisa
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0, 0, 0, 0.75)', zIndex: 999999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '15px' }} onClick={() => setShowModal(false)}>
          <div style={{ width: '100%', maxWidth: '650px', backgroundColor: '#1c1c1e', border: '1px solid #333', borderRadius: '16px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid #333', paddingBottom: '0.75rem' }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><ShoppingBag size={18} color="var(--primary)"/> Laporan Keuangan & Penjualan</h3>
              <button onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}><X size={20}/></button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              <select value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value)} style={{ flex: '1 1 150px', minWidth: '150px', padding: '9px', borderRadius: '7px', border: '1px solid #444', background: '#262629', color: '#fff' }}>
                <option value="daily">Harian</option>
                <option value="weekly">Mingguan</option>
                <option value="monthly">Bulanan</option>
                <option value="custom">Tanggal tertentu</option>
              </select>
              <button onClick={loadReport} disabled={reportLoading} style={{ flex: '1 1 110px', border: 'none', borderRadius: '7px', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>{reportLoading ? 'Memuat...' : 'Terapkan'}</button>
              <button onClick={handlePrintReport} disabled={!history.length || reportPrintLoading} style={{ flex: '1 1 110px', border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', cursor: reportPrintLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}><Printer size={15}/> {reportPrintLoading ? 'Menyiapkan...' : 'PDF / Cetak'}</button>
              <button onClick={handleExportExcel} disabled={!history.length || reportPrintLoading} style={{ flex: '1 1 110px', border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', cursor: reportPrintLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}><Download size={15}/> {reportPrintLoading ? 'Menyiapkan...' : 'Excel'}</button>
            </div>
            {reportPeriod === 'custom' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                <label style={{ flex: '1 1 180px', color: '#bbb', fontSize: '12px' }}>Dari tanggal<input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', borderRadius: '6px', border: '1px solid #444', background: '#262629', color: '#fff' }}/></label>
                <label style={{ flex: '1 1 180px', color: '#bbb', fontSize: '12px' }}>Sampai tanggal<input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} style={{ display: 'block', width: '100%', marginTop: '4px', padding: '8px', borderRadius: '6px', border: '1px solid #444', background: '#262629', color: '#fff' }}/></label>
              </div>
            )}
            <div style={{ background: '#262629', borderRadius: '8px', padding: '12px', marginBottom: '12px', color: '#ddd' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '12px' }}>
                <span>Periode: <strong>{reportTitle}</strong></span>
                <span>Transaksi: <strong>{formatNumber(reportSummary.transactionCount)}</strong></span>
                <span>Barang bersih: <strong>{formatNumber(reportItemCount)}</strong></span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '8px' }}>
                {[
                  ['Penjualan kotor', reportGrossSales, 'var(--primary)'],
                  ['Potongan', reportDiscount, '#fbbf24'],
                  ['Retur', reportReturnedTotal, '#f43f5e'],
                  ['Penjualan bersih', reportNetSales, 'var(--primary)'],
                  ['Pajak', reportTax, '#a78bfa'],
                  ['Total dibayar', reportCollectedTotal, 'var(--primary)'],
                  ['Tunai', reportCashTotal, '#60a5fa'],
                  ['QRIS', reportQrisTotal, '#60a5fa'],
                  ['Rata-rata transaksi', reportAverageTransaction, '#60a5fa'],
                  ['Keuntungan', reportProfit, '#60a5fa']
                ].map(([label, value, color]) => (
                  <div key={label} style={{ border: '1px solid #3a3a3c', borderRadius: '7px', padding: '8px', minWidth: 0 }}>
                    <div style={{ color: '#aaa', fontSize: '11px', marginBottom: '3px' }}>{label}</div>
                    <strong style={{ color, fontSize: '13px', overflowWrap: 'anywhere' }}>{formatCurrency(value)}</strong>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '9px', color: '#999', fontSize: '11px' }}>Penjualan bersih = penjualan kotor - potongan - retur. Total dibayar sudah dikurangi retur.</div>
            </div>
            {reportPagination.totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', margin: '12px 0' }}>
                <button type="button" onClick={() => loadReport(reportPagination.page - 1)} disabled={reportLoading || reportPagination.page <= 1} style={{ border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', padding: '8px 12px' }}>Sebelumnya</button>
                <span style={{ color: '#aaa', fontSize: '12px' }}>Halaman {formatNumber(reportPagination.page)} / {formatNumber(reportPagination.totalPages)}</span>
                <button type="button" onClick={() => loadReport(reportPagination.page + 1)} disabled={reportLoading || reportPagination.page >= reportPagination.totalPages} style={{ border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', padding: '8px 12px' }}>Berikutnya</button>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {history.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#666', padding: '1.5rem' }}>Belum ada rincian data nota masuk.</div>
              ) : (
                history.map((trx, index) => (
                  <div key={trx.id || index} style={{ background: '#262629', border: '1px solid #3a3a3c', borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                      <span style={{ fontWeight: 'bold', color: '#3b82f6' }}>NOTA: #{formatNumber(trx.id || (history.length - index))}</span>
                      <span style={{ color: '#aaa' }}>{trx.created_at ? formatDateTime(trx.created_at) : 'Barusan'}</span>
                    </div>
                    <div style={{ borderBottom: '1px dashed #444', margin: '2px 0' }}></div>
                    {trx.items?.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        {trx.items.map((item, itemIndex) => (
                          <div key={`${trx.id}-${itemIndex}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#ddd' }}>
                            <span>{item.name} × {formatNumber(item.quantity)}{Number(item.returned_quantity || 0) > 0 && <small style={{ color: '#fbbf24' }}> · retur {formatNumber(item.returned_quantity)}</small>}</span>
                            <span>{formatCurrency(item.price * item.quantity)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '11px', color: '#bbb' }}>Bayar: {formatCurrency(trx.amount_paid || trx.total)}</div>
                        <div style={{ fontSize: '11px', color: '#f43f5e' }}>Kembali: {formatCurrency(trx.change || 0)}</div>
                        <div style={{ fontSize: '11px', color: '#bbb' }}>Metode: {({ cash: 'Tunai', qris: 'QRIS', debit_card: 'Kartu debit', credit_card: 'Kartu kredit', bank_transfer: 'Transfer bank', e_wallet: 'E-wallet' }[trx.payment_method] || trx.payment_method || 'Tunai')}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '15px', fontWeight: '800', color: 'var(--primary)' }}>{formatCurrency(trx.total)}</div>
                        {Number(trx.discount || 0) > 0 && <div style={{ fontSize: '10px', color: '#fbbf24' }}>Potongan: {formatCurrency(trx.discount)}</div>}
                        <div style={{ fontSize: '10px', color: 'var(--primary)' }}>Untung: {formatCurrency((trx.items || []).reduce((sum, item) => sum + ((Number(item.price || 0) - Number(item.cost_price || 0)) * Number(item.quantity || 0)), 0) - Number(trx.discount || 0))}</div>
                        <span style={{ fontSize: '10px', background: trx.status === 'voided' ? 'rgba(244, 63, 94, 0.15)' : 'rgba(59, 130, 246, 0.15)', color: trx.status === 'voided' ? '#f43f5e' : 'var(--primary)', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold' }}>{trx.status === 'voided' ? 'VOID' : 'LUNAS'}</span>
                      </div>
                    </div>
                    {user?.role !== 'cashier' && trx.status === 'completed' && (
                      <div style={{ alignSelf: 'flex-end', display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '6px' }}>
                        {(trx.items || []).some((item) => Number(item.quantity || 0) > Number(item.returned_quantity || 0)) && (
                          <button type="button" onClick={() => openReturnModal(trx)} disabled={returnSaving} style={{ border: '1px solid rgba(245, 158, 11, 0.45)', borderRadius: '6px', background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', padding: '6px 10px', cursor: returnSaving ? 'wait' : 'pointer', fontWeight: '700', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}><RotateCcw size={13} /> Retur</button>
                        )}
                        <button type="button" onClick={() => handleVoidTransaction(trx)} disabled={voidingId === trx.id} style={{ border: '1px solid rgba(244, 63, 94, 0.45)', borderRadius: '6px', background: 'rgba(244, 63, 94, 0.12)', color: '#f43f5e', padding: '6px 10px', cursor: voidingId === trx.id ? 'wait' : 'pointer', fontWeight: '700', fontSize: '11px' }}>{voidingId === trx.id ? 'Memproses...' : 'Void Transaksi'}</button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {returningTransaction && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0, 0, 0, 0.78)', zIndex: 1000000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '15px' }} onClick={closeReturnModal}>
          <div style={{ width: '100%', maxWidth: '520px', backgroundColor: '#1c1c1e', border: '1px solid #333', borderRadius: '16px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #333', paddingBottom: '0.75rem' }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><RotateCcw size={18} color="#fbbf24" /> Retur Transaksi #{formatNumber(returningTransaction.id)}</h3>
              <button type="button" onClick={closeReturnModal} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <form onSubmit={handleReturnTransaction} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {(returningTransaction.items || []).map((item) => {
                  const available = Math.max(Number(item.quantity || 0) - Number(item.returned_quantity || 0), 0);
                  if (available <= 0) return null;
                  return (
                    <label key={item.transaction_item_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px', border: '1px solid #3a3a3c', borderRadius: '8px', color: '#ddd' }}>
                      <span style={{ minWidth: 0 }}><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</strong><small style={{ color: '#aaa' }}>Terjual {formatNumber(item.quantity)} · Sisa retur {formatNumber(available)}</small></span>
                      <input type="number" min="0" max={available} step="1" value={returnQuantities[item.transaction_item_id] ?? '0'} onChange={(event) => setReturnQuantities((current) => ({ ...current, [item.transaction_item_id]: event.target.value }))} style={{ width: '76px', padding: '8px', borderRadius: '6px', border: '1px solid #555', background: '#262629', color: '#fff' }} />
                    </label>
                  );
                })}
              </div>
              <label style={{ color: '#bbb', fontSize: '12px' }}>Alasan retur<textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} rows="3" maxLength={500} placeholder="Contoh: barang rusak atau salah barang" style={{ display: 'block', width: '100%', marginTop: '4px', padding: '9px', borderRadius: '6px', border: '1px solid #444', background: '#262629', color: '#fff', resize: 'vertical' }} required /></label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={closeReturnModal} disabled={returnSaving} style={{ flex: 1, border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', padding: '10px' }}>Batal</button>
                <button type="submit" disabled={returnSaving} style={{ flex: 1, border: 'none', borderRadius: '7px', background: '#d97706', color: '#fff', padding: '10px', fontWeight: '700' }}>{returnSaving ? 'Memproses...' : 'Simpan Retur'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAuditModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0, 0, 0, 0.78)', zIndex: 1000001, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '15px' }} onClick={() => setShowAuditModal(false)}>
          <div style={{ width: '100%', maxWidth: '760px', backgroundColor: '#1c1c1e', border: '1px solid #333', borderRadius: '16px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #333', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ margin: 0, color: '#fff', fontSize: '16px' }}>Log Aktivitas</h3>
                <p style={{ margin: '4px 0 0', color: '#aaa', fontSize: '12px' }}>Riwayat perubahan data dan aktivitas operasional pengguna.</p>
              </div>
              <button type="button" onClick={() => setShowAuditModal(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            {auditLoading ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#aaa' }}>Memuat log...</div> : auditLogs.length === 0 ? <div style={{ padding: '1.5rem', textAlign: 'center', color: '#aaa' }}>Belum ada aktivitas tercatat.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {auditLogs.map((log) => (
                  <div key={log.id} style={{ border: '1px solid #3a3a3c', borderRadius: '9px', padding: '10px', color: '#ddd' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <strong style={{ color: '#60a5fa' }}>{log.action} · {log.entity}{log.entity_id ? ` #${formatNumber(log.entity_id)}` : ''}</strong>
                      <span style={{ color: '#aaa' }}>{formatDateTime(log.created_at)}</span>
                    </div>
                    <div style={{ marginTop: '4px', color: '#bbb', fontSize: '12px' }}>Pengguna: {log.username || 'Sistem'}{log.reason ? ` · ${log.reason}` : ''}</div>
                    {(log.before_data || log.after_data) && (
                      <details style={{ marginTop: '6px', color: '#aaa', fontSize: '11px' }}>
                        <summary style={{ cursor: 'pointer' }}>Lihat detail perubahan</summary>
                        {log.before_data && <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: '6px 0 0', color: '#fca5a5' }}>Sebelum: {formatAuditData(log.before_data)}</pre>}
                        {log.after_data && <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: '6px 0 0', color: '#86efac' }}>Sesudah: {formatAuditData(log.after_data)}</pre>}
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
            {auditPagination.totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '1rem' }}>
                <button type="button" onClick={() => loadAuditLogs(auditPagination.page - 1)} disabled={auditLoading || auditPagination.page <= 1} style={{ border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', padding: '8px 12px' }}>Sebelumnya</button>
                <span style={{ color: '#aaa', fontSize: '12px' }}>Halaman {formatNumber(auditPagination.page)} / {formatNumber(auditPagination.totalPages)}</span>
                <button type="button" onClick={() => loadAuditLogs(auditPagination.page + 1)} disabled={auditLoading || auditPagination.page >= auditPagination.totalPages} style={{ border: '1px solid #555', borderRadius: '7px', background: '#333', color: '#fff', padding: '8px 12px' }}>Berikutnya</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
