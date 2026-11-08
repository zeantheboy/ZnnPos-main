import React, { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-hot-toast';
import api from '../api';
import { formatNumber } from '../utils/numberFormat';

function Cart({ items, setItems, currentShift, heldTransactionsOpenRequest = 0, onHeldTransactionsChanged, isMobilePopup = false, onClose }) {
  const totalPrice = items.reduce((acc, item) => acc + item.price * item.qty, 0);
  const [discount, setDiscount] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [showPaymentMethods, setShowPaymentMethods] = useState(false);
  const [change, setChange] = useState(0);
  const [heldTransactions, setHeldTransactions] = useState([]);
  const [showHeldTransactions, setShowHeldTransactions] = useState(false);
  const [heldLoading, setHeldLoading] = useState(false);
  const hadItemsRef = useRef(items.length > 0);
  const [settings, setSettings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('pos_settings') || '{}');
    } catch {
      return {};
    }
  });
  const currency = settings.currency || 'Rp ';
  const storeName = /^znnpos$/i.test(settings.storeName || '') ? 'ZnnCashier' : settings.storeName || 'ZnnCashier';
  const receiptFooter = settings.receiptFooter || 'Terima kasih sudah berbelanja!';
  const taxRate = Math.min(Math.max(Number(settings.taxRate) || 0, 0), 100);
  const discountValue = Math.min(Math.max(Number(discount) || 0, 0), totalPrice);
  const taxableSubtotal = Math.max(totalPrice - discountValue, 0);
  const taxAmount = Math.round((taxableSubtotal * taxRate / 100 + Number.EPSILON) * 100) / 100;
  const payableTotal = Math.round((taxableSubtotal + taxAmount + Number.EPSILON) * 100) / 100;
  const paymentMethodLabel = {
    cash: 'Tunai',
    qris: 'QRIS'
  }[paymentMethod] || 'Metode Pembayaran';

  useEffect(() => {
    if (items.length > 0) {
      hadItemsRef.current = true;
      return;
    }
    if (isMobilePopup && hadItemsRef.current) {
      hadItemsRef.current = false;
      onClose?.();
    }
  }, [items.length, isMobilePopup, onClose]);

  useEffect(() => {
    const applySettings = (nextSettings) => {
      if (nextSettings && typeof nextSettings === 'object') setSettings(nextSettings);
    };

    api.get('/settings').then((response) => {
      const nextSettings = response.data || {};
      applySettings(nextSettings);
      localStorage.setItem('pos_settings', JSON.stringify(nextSettings));
    }).catch(() => {});

    const handleSettingsUpdated = () => {
      try {
        applySettings(JSON.parse(localStorage.getItem('pos_settings') || '{}'));
      } catch {
        applySettings({});
      }
    };
    window.addEventListener('settings_updated', handleSettingsUpdated);
    return () => window.removeEventListener('settings_updated', handleSettingsUpdated);
  }, []);

  // Otomatis menghitung uang kembalian setiap kali uang yang dibayarkan diketik
  useEffect(() => {
    if (!paymentMethod) {
      setChange(0);
      return;
    }
    if (paymentMethod !== 'cash') {
      setAmountPaid(String(payableTotal));
      setChange(0);
      return;
    }
    if (amountPaid && Number(amountPaid) >= payableTotal) {
      setChange(Number(amountPaid) - payableTotal);
    } else {
      setChange(0);
    }
  }, [amountPaid, payableTotal, paymentMethod]);

  const updateQty = (id, delta) => {
    setItems(prev => prev.map(item => {
      if (item.id === id) {
        const newQty = item.qty + delta;
        return newQty > 0 ? { ...item, qty: newQty } : item;
      }
      return item;
    }));
  };

  const removeItem = (id) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const loadHeldTransactions = useCallback(async () => {
    setHeldLoading(true);
    try {
      const response = await api.get('/held-transactions');
      setHeldTransactions(response.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memuat transaksi tertunda');
    } finally {
      setHeldLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!heldTransactionsOpenRequest) return;
    setShowHeldTransactions(true);
    loadHeldTransactions();
  }, [heldTransactionsOpenRequest, loadHeldTransactions]);

  const handleHoldTransaction = async () => {
    if (items.length === 0) return;
    const label = window.prompt('Nama transaksi tertunda:', `Pelanggan ${new Date().toLocaleTimeString('id-ID')}`);
    if (label === null) return;
    try {
      await api.post('/held-transactions', {
        label,
        discount: discountValue,
        payment_method: paymentMethod || 'cash',
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          qty: Number(item.qty),
          price: Number(item.price),
          isCustom: Boolean(item.isCustom)
        }))
      });
      setItems([]);
      setDiscount('');
      setAmountPaid('');
      setPaymentMethod('');
      setShowPaymentMethods(false);
      onHeldTransactionsChanged?.();
      toast.success('Transaksi disimpan sementara');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menyimpan transaksi tertunda');
    }
  };

  const handleRestoreHeld = async (held) => {
    const payload = held.payload || {};
    const restoredItems = Array.isArray(payload.items) ? payload.items : [];
    if (!restoredItems.length) {
      toast.error('Transaksi tertunda ini tidak memiliki item');
      return;
    }
    try {
      await api.delete(`/held-transactions/${held.id}`);
      setHeldTransactions((current) => current.filter((item) => item.id !== held.id));
      onHeldTransactionsChanged?.();
      setItems(restoredItems);
      setDiscount(payload.discount ? String(payload.discount) : '');
      setPaymentMethod(payload.paymentMethod || '');
      setShowPaymentMethods(false);
      setAmountPaid('');
      setShowHeldTransactions(false);
      toast.success('Transaksi tertunda dimuat ke keranjang');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Transaksi tertunda gagal dimuat');
    }
  };

  const handleDeleteHeld = async (held) => {
    if (!window.confirm(`Hapus transaksi tertunda "${held.label || 'Transaksi'}"?`)) return;
    try {
      await api.delete(`/held-transactions/${held.id}`);
      setHeldTransactions((current) => current.filter((item) => item.id !== held.id));
      onHeldTransactionsChanged?.();
      toast.success('Transaksi tertunda dihapus');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menghapus transaksi tertunda');
    }
  };

  // Fungsi Rahasia untuk Mencetak Nota Struk Belanja ke Printer Thermal / Simpan PDF
  const handlePrintReceipt = (payload) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      toast.error('Izinkan pop-up browser untuk mencetak struk');
      return;
    }
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
    const formatCurrency = (value) => `${currency}${formatNumber(value)}`;

    printWindow.document.write(`
      <html>
        <head>
          <title>ZnnCashier - ${escapeHtml(storeName)} - Nota Belanja</title>
          <style>
            body { font-family: 'Courier New', Courier, monospace; width: 280px; padding: 10px; margin: 0; font-size: 13px; color: #000; }
            .text-center { text-align: center; }
            .line { border-bottom: 1px dashed #000; margin: 8px 0; }
            .flex { display: flex; justify-content: space-between; }
            .bold { font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="text-center bold" style="font-size: 16px;">ZnnCashier</div>
          <div class="text-center bold" style="font-size: 14px;">${escapeHtml(storeName)}</div>
          <div class="line"></div>
          <div>Tanggal: ${new Date().toLocaleString('id-ID')}</div>
          <div class="line"></div>
          ${payload.items.map(item => `
            <div class="flex">
              <div>${escapeHtml(item.name)} (${formatNumber(item.quantity)}x)</div>
              <div>${formatCurrency(item.price * item.quantity)}</div>
            </div>
          `).join('')}
          <div class="line"></div>
          <div class="flex"><div>SUBTOTAL:</div><div>${formatCurrency(payload.subtotal)}</div></div>
          ${payload.discount > 0 ? `<div class="flex"><div>POTONGAN:</div><div>- ${formatCurrency(payload.discount)}</div></div>` : ''}
          ${payload.vat > 0 ? `<div class="flex"><div>PAJAK (${formatNumber(payload.taxRate)}%):</div><div>${formatCurrency(payload.vat)}</div></div>` : ''}
          <div class="flex bold">
            <div>TOTAL TAGIHAN:</div>
            <div>${formatCurrency(payload.total)}</div>
          </div>
          <div class="flex">
            <div>${escapeHtml(paymentMethodLabel.toUpperCase())} / BAYAR:</div>
            <div>${formatCurrency(payload.amountPaid)}</div>
          </div>
          <div class="flex bold" style="color: #000;">
            <div>KEMBALIAN:</div>
            <div>${formatCurrency(payload.change)}</div>
          </div>
          <div class="line"></div>
          <div class="text-center" style="white-space: pre-line;">${escapeHtml(receiptFooter)}</div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print(); // Otomatis memicu pop-up mesin printer cetak struk
  };

  const handleCheckout = async () => {
    if (items.length === 0) return;
    if (!paymentMethod) {
      toast.error('Pilih metode pembayaran terlebih dahulu');
      return;
    }
    if (!currentShift) {
      toast.error('Buka shift kasir terlebih dahulu');
      return;
    }
    
    const cashValue = paymentMethod === 'cash' ? (amountPaid === '' ? payableTotal : Number(amountPaid)) : payableTotal;
    
    if (!Number.isFinite(cashValue) || cashValue < payableTotal) {
      toast.error('Uang yang dibayarkan kurang!');
      return;
    }

    const payload = {
      discount: Number(discountValue),
      tax_rate: Number(taxRate),
      amount_paid: cashValue,
      payment_method: paymentMethod,
      items: items.map(item => ({
        id: typeof item.id === 'string' && item.id.startsWith('custom-') ? item.id : Number(item.id),
        name: item.name,
        quantity: Number(item.qty),
        price: Number(item.price)
      }))
    };

    try {
      const response = await api.post('/checkout', payload);
      const transaction = response.data;

      toast.success('Transaksi Berhasil Disimpan!');
      handlePrintReceipt(transaction);
      setAmountPaid('');
      setPaymentMethod('');
      setShowPaymentMethods(false);
      setDiscount('');
      setItems([]);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memproses transaksi kasir');
    }
  };

  const choosePaymentMethod = (method) => {
    setPaymentMethod(method);
    setShowPaymentMethods(false);
    setDiscount('');
    if (method === 'qris') {
      setAmountPaid(String(payableTotal));
    } else if (paymentMethod === 'qris') {
      setAmountPaid('');
    }
  };

  return (
    <div className="cart-container" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', gap: '1rem', color: '#ffffff' }}>
      {isMobilePopup ? (
        <div className="cart-popup-header">
          <div className="cart-popup-header-actions">
            {items.length > 0 && (
              <button type="button" className="cart-save-held-button" onClick={handleHoldTransaction}>
                Simpan Sementara
              </button>
            )}
            <button type="button" className="cart-popup-close-button" onClick={onClose}>
              ✕ Tutup
            </button>
          </div>
        </div>
      ) : (
        <div className="cart-desktop-actions">
          {items.length > 0 && (
            <button type="button" className="cart-save-held-button" onClick={handleHoldTransaction}>
              Simpan Sementara
            </button>
          )}
        </div>
      )}

      {/* DAFTAR LIST ITEM BELANJAAN */}
      <div className="cart-items-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto', flex: 1, minHeight: '80px' }}>
        {items.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#888', padding: '1rem' }}>Keranjang masih kosong</div>
        ) : (
          items.map(item => (
            <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#222222', padding: '10px', borderRadius: '8px', border: '1px solid #333' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#fff' }}>{item.name}</div>
                <div style={{ fontSize: '12px', color: '#a0aec0' }}>{currency}{formatNumber(item.price)} x {formatNumber(item.qty)}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button type="button" onClick={() => updateQty(item.id, -1)} style={{ background: '#444', color: '#fff', border: 'none', width: '24px', height: '24px', borderRadius: '4px', cursor: 'pointer' }}>-</button>
                <span style={{ fontWeight: 'bold', minWidth: '16px', textAlign: 'center', color: '#fff' }}>{formatNumber(item.qty)}</span>
                <button type="button" onClick={() => updateQty(item.id, 1)} style={{ background: '#444', color: '#fff', border: 'none', width: '24px', height: '24px', borderRadius: '4px', cursor: 'pointer' }}>+</button>
                <button type="button" onClick={() => removeItem(item.id)} style={{ background: '#e53e3e', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', marginLeft: '6px', fontSize: '11px', cursor: 'pointer' }}>Hapus</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* FOOTER TOTAL TAGIHAN & TOMBOL EKSEKUSI */}
      <div style={{ borderTop: '1px solid #333', paddingTop: '1rem', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '12px', color: '#a0aec0' }}>Subtotal: {currency}{formatNumber(totalPrice)}</div>
            {discountValue > 0 && <div style={{ fontSize: '12px', color: '#fbbf24' }}>Potongan: - {currency}{formatNumber(discountValue)}</div>}
            {taxAmount > 0 && <div style={{ fontSize: '12px', color: '#a78bfa' }}>Pajak ({formatNumber(taxRate)}%): {currency}{formatNumber(taxAmount)}</div>}
            <span style={{ fontSize: '14px', color: '#a0aec0' }}>Total Tagihan:</span>
          </div>
          <span style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--primary)' }}>{currency}{formatNumber(payableTotal)}</span>
        </div>
        
        {items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: '#1a1a1a', padding: '12px', borderRadius: '8px', border: '1px solid #2d2d2d' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11px', color: '#a0aec0', marginBottom: '4px' }}>
                {paymentMethod === 'qris' ? 'Nominal Pembayaran QRIS' : 'Uang Diberikan Pelanggan'} ({currency}):
              </label>
              <input
                type="number"
                inputMode="decimal"
                value={amountPaid}
                onChange={e => setAmountPaid(e.target.value)}
                readOnly={paymentMethod === 'qris'}
                style={{ width: '100%', padding: '12px', borderRadius: '6px', border: '1px solid #3b82f6', background: '#121212', color: '#fff', fontSize: '16px', fontWeight: 'bold' }}
                placeholder={`Masukkan uang pelanggan, misal: ${formatNumber(payableTotal)}`}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '4px' }}>
              <span style={{ color: '#a0aec0' }}>Uang Kembalian:</span>
              <span style={{ fontWeight: 'bold', color: change > 0 ? '#3b82f6' : '#fff' }}>{currency}{formatNumber(change)}</span>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <button type="button" disabled style={{ width: '100%', backgroundColor: '#444', color: '#fff', border: 'none', padding: '14px', borderRadius: '8px', fontWeight: 'bold', fontSize: '15px', cursor: 'not-allowed' }}>
            Keranjang Kosong
          </button>
        ) : (
          <>
            {!paymentMethod ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {!showPaymentMethods ? (
                  <button type="button" onClick={() => setShowPaymentMethods(true)} style={{ width: '100%', backgroundColor: '#2563eb', color: '#fff', border: 'none', padding: '16px', borderRadius: '8px', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer' }}>
                    Metode Pembayaran
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ color: '#a0aec0', fontSize: '12px' }}>Pilih metode pembayaran:</div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button type="button" onClick={() => choosePaymentMethod('cash')} style={{ flex: 1, backgroundColor: '#2563eb', color: '#fff', border: 'none', padding: '14px', borderRadius: '8px', fontWeight: 'bold', fontSize: '15px', cursor: 'pointer' }}>
                        Tunai
                      </button>
                      <button type="button" onClick={() => choosePaymentMethod('qris')} style={{ flex: 1, backgroundColor: 'var(--primary-hover)', color: '#fff', border: 'none', padding: '14px', borderRadius: '8px', fontWeight: 'bold', fontSize: '15px', cursor: 'pointer' }}>
                        QRIS
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#a0aec0', fontSize: '12px' }}>
                <span>Metode: <strong style={{ color: '#fff' }}>{paymentMethodLabel}</strong></span>
                <button type="button" onClick={() => { setPaymentMethod(''); setShowPaymentMethods(false); setAmountPaid(''); }} style={{ background: 'transparent', border: 'none', color: '#93c5fd', cursor: 'pointer', fontWeight: '700' }}>
                  Ubah
                </button>
              </div>
            )}

            {!paymentMethod && (
              <div style={{ marginTop: '0.25rem', padding: '12px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.35)' }}>
                <label style={{ display: 'block', fontSize: '12px', color: '#fbbf24', marginBottom: '5px', fontWeight: '700' }}>Masukkan Potongan Harga ({currency}):</label>
                <input
                  type="number"
                  min="0"
                  max={totalPrice}
                  value={discount}
                  onChange={e => setDiscount(e.target.value)}
                  style={{ width: '100%', padding: '13px', borderRadius: '6px', border: '1px solid #f59e0b', background: '#121212', color: '#fff', fontSize: '16px', fontWeight: 'bold' }}
                  placeholder="Masukkan nominal potongan"
                />
              </div>
            )}

            {paymentMethod && (
              <button
                type="button"
                onClick={handleCheckout}
                disabled={!currentShift}
                style={{
                  width: '100%',
                  backgroundColor: !currentShift ? '#444' : 'var(--primary)',
                  color: '#fff',
                  border: 'none',
                  padding: '16px',
                  borderRadius: '8px',
                  fontWeight: 'bold',
                  fontSize: '16px',
                  cursor: !currentShift ? 'not-allowed' : 'pointer'
                }}
              >
                {!currentShift ? 'Buka Shift Terlebih Dahulu' : '💳 KONFIRMASI & CETAK STRUK'}
              </button>
            )}
          </>
        )}
      </div>

      {showHeldTransactions && (
        <div className="modal-overlay" onClick={() => !heldLoading && setShowHeldTransactions(false)}>
          <div className="modal-content" style={{ maxWidth: '560px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Transaksi Tertunda</h2>
              <button type="button" onClick={() => setShowHeldTransactions(false)} style={{ color: 'var(--text-secondary)' }}>×</button>
            </div>
            {heldLoading ? <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Memuat...</div> : heldTransactions.length === 0 ? <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Belum ada transaksi tertunda.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {heldTransactions.map((held) => {
                  const heldItems = Array.isArray(held.payload?.items) ? held.payload.items : [];
                  const itemCount = heldItems.reduce((sum, item) => sum + Number(item.qty || 0), 0);
                  return (
                    <div key={held.id} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                        <div>
                          <strong>{held.label || 'Transaksi tertunda'}</strong>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '0.25rem' }}>{formatNumber(itemCount)} barang · {held.username || 'Anda'} · {new Date(held.created_at).toLocaleString('id-ID')}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <button type="button" className="btn btn-primary" onClick={() => handleRestoreHeld(held)}>Muat</button>
                          <button type="button" className="btn" onClick={() => handleDeleteHeld(held)} style={{ color: '#f43f5e' }}>Hapus</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Cart;
