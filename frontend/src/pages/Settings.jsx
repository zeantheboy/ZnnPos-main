import { useState, useEffect } from 'react';
import { Save, CheckCircle, ShieldCheck, Smartphone } from 'lucide-react';
import api from '../api';
import toast from 'react-hot-toast';
import ScannerConnectModal from '../components/ScannerConnectModal';
import { useAuth } from '../auth/useAuth';

export default function Settings() {
  const { user, updateUser } = useAuth();
  const [currency, setCurrency] = useState('Rp');
  const [taxRate, setTaxRate] = useState('0');
  const [storeName, setStoreName] = useState('ZnnCashier');
  const [receiptFooter, setReceiptFooter] = useState('Thank you for shopping with us!');
  const [saved, setSaved] = useState(false);
  const [adminConfigured, setAdminConfigured] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [adminSaving, setAdminSaving] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [showScannerConnect, setShowScannerConnect] = useState(false);

  useEffect(() => {
    if (user?.role !== 'super_admin') return;
    const applySettings = (settings = {}) => {
      if (settings.currency) setCurrency(settings.currency);
      if (settings.taxRate !== undefined) setTaxRate(String(settings.taxRate));
      if (settings.storeName) setStoreName(/^znnpos$/i.test(settings.storeName) ? 'ZnnCashier' : settings.storeName);
      if (settings.receiptFooter !== undefined) setReceiptFooter(settings.receiptFooter);
    };

    try {
      applySettings(JSON.parse(localStorage.getItem('pos_settings') || '{}'));
    } catch {
      localStorage.removeItem('pos_settings');
    }

    api.get('/settings').then((response) => {
      const settings = response.data || {};
      applySettings(settings);
      localStorage.setItem('pos_settings', JSON.stringify(settings));
    }).catch(() => {});

    api.get('/admin/status').then((response) => setAdminConfigured(response.data.configured)).catch(() => {});
  }, [user?.role]);

  if (user?.role !== 'super_admin') {
    return <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Pengaturan hanya dapat diakses oleh Super Admin.</div>;
  }

  const handleSave = async (e) => {
    e.preventDefault();
    const normalizedTaxRate = Number(taxRate);
    if (!Number.isFinite(normalizedTaxRate) || normalizedTaxRate < 0 || normalizedTaxRate > 100) {
      toast.error('Pajak harus berada di antara 0 dan 100');
      return;
    }

    setSettingsSaving(true);
    try {
      const response = await api.patch('/settings', {
        currency: currency.trim(),
        tax_rate: normalizedTaxRate,
        store_name: storeName.trim(),
        receipt_footer: receiptFooter
      });
      const settings = response.data;
      localStorage.setItem('pos_settings', JSON.stringify(settings));
      setCurrency(settings.currency);
      setTaxRate(String(settings.taxRate));
      setStoreName(settings.storeName);
      setReceiptFooter(settings.receiptFooter);
      updateUser({ storeName: settings.storeName });
      window.dispatchEvent(new Event('settings_updated'));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menyimpan pengaturan');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleAdminPinSave = async (event) => {
    event.preventDefault();
    if (!/^\d{4,12}$/.test(newPin)) {
      toast.error('PIN harus terdiri dari 4 sampai 12 angka');
      return;
    }
    if (newPin !== confirmPin) {
      toast.error('Konfirmasi PIN tidak cocok');
      return;
    }
    setAdminSaving(true);
    try {
      const endpoint = adminConfigured ? '/admin/change-pin' : '/admin/setup';
      const payload = adminConfigured ? { currentPin, newPin } : { pin: newPin };
      await api.post(endpoint, payload);
      setAdminConfigured(true);
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      toast.success(adminConfigured ? 'PIN Admin berhasil diubah' : 'PIN Admin berhasil dibuat');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menyimpan PIN Admin');
    } finally {
      setAdminSaving(false);
    }
  };

  return (
    <div style={{ padding: '1rem', width: '100%', maxWidth: '800px' }}>
      <h2 style={{ margin: '0 0 2rem 0' }}>Pengaturan Aplikasi</h2>

      <div style={{ backgroundColor: 'var(--surface-color)', padding: '2rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div>
              <label className="input-label" style={{ marginBottom: '0.5rem' }}>Nama Toko</label>
              <input 
                className="modal-input" 
                value={storeName} 
                onChange={e => setStoreName(e.target.value)} 
                placeholder="Contoh: Toko Saya" 
                required 
              />
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Akan tampil bersama tulisan ZnnCashier pada nota dan laporan cetak.</div>
            </div>

            <div>
              <label className="input-label" style={{ marginBottom: '0.5rem' }}>Simbol Mata Uang</label>
              <input 
                className="modal-input" 
                value={currency} 
                onChange={e => setCurrency(e.target.value)} 
                placeholder="Rp " 
                required 
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div>
              <label className="input-label" style={{ marginBottom: '0.5rem' }}>Pajak / PPN Bawaan (%)</label>
              <input 
                type="number" 
                step="0.01" 
                min="0"
                className="modal-input" 
                value={taxRate} 
                onChange={e => setTaxRate(e.target.value)} 
                placeholder="0" 
              />
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Otomatis diterapkan pada total keranjang.</div>
            </div>
          </div>

          <div>
            <label className="input-label" style={{ marginBottom: '0.5rem' }}>Pesan Bawah Struk</label>
            <textarea 
              className="modal-input" 
              value={receiptFooter} 
              onChange={e => setReceiptFooter(e.target.value)} 
              placeholder="Terima kasih sudah berbelanja!" 
              rows="3"
              style={{ resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem' }}>
            <button type="submit" className="btn btn-primary" disabled={settingsSaving} style={{ width: 'auto' }}>
              <Save size={20} /> Simpan Pengaturan
            </button>
            {saved && (
              <div style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: '500' }}>
                <CheckCircle size={20} /> Pengaturan berhasil disimpan!
              </div>
            )}
          </div>
        </form>
      </div>

      <div style={{ backgroundColor: 'var(--surface-color)', padding: '1.5rem', marginTop: '1rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
        <h3 style={{ margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}><Smartphone size={21} /> Scanner HP</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0 }}>Buat link scanner yang terhubung hanya ke kasir pada perangkat ini.</p>
        <button type="button" className="btn btn-primary" onClick={() => setShowScannerConnect(true)} style={{ width: 'auto' }}>
          <Smartphone size={18} /> Hubungkan Scanner HP
        </button>
      </div>

      <div style={{ backgroundColor: 'var(--surface-color)', padding: '1.5rem', marginTop: '1rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
        <h3 style={{ margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}><ShieldCheck size={21} /> Keamanan Admin</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 0 }}>PIN ini diperlukan saat mengubah stok produk.</p>
        <form onSubmit={handleAdminPinSave} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          {adminConfigured && <label className="input-label">PIN Admin saat ini<input className="modal-input" type="password" inputMode="numeric" value={currentPin} onChange={(event) => setCurrentPin(event.target.value)} required /></label>}
          <label className="input-label">{adminConfigured ? 'PIN Admin baru' : 'Buat PIN Admin'}<input className="modal-input" type="password" inputMode="numeric" minLength="4" maxLength="12" value={newPin} onChange={(event) => setNewPin(event.target.value)} placeholder="4–12 angka" required /></label>
          <label className="input-label">Konfirmasi PIN<input className="modal-input" type="password" inputMode="numeric" minLength="4" maxLength="12" value={confirmPin} onChange={(event) => setConfirmPin(event.target.value)} required /></label>
          <button type="submit" className="btn btn-primary" disabled={adminSaving} style={{ width: 'auto', alignSelf: 'flex-start' }}>{adminSaving ? 'Menyimpan...' : adminConfigured ? 'Ubah PIN Admin' : 'Simpan PIN Admin'}</button>
        </form>
      </div>

      {showScannerConnect && <ScannerConnectModal onClose={() => setShowScannerConnect(false)} />}
    </div>
  );
}
