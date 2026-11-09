import { useCallback, useEffect, useState } from 'react';
import { Laptop, RefreshCw, Store, Trash2, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../auth/useAuth';
import { formatNumber } from '../utils/numberFormat';

export default function Stores() {
  const { user } = useAuth();
  const canManageStores = user?.role === 'super_admin' && (user?.platformAdmin || user?.storeCode === 'utama');
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', owner_username: '', owner_pin: '' });
  const [createdOwner, setCreatedOwner] = useState(null);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [devices, setDevices] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [deviceQuota, setDeviceQuota] = useState('1');
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [userQuota, setUserQuota] = useState('3');
  const [userQuotaSaving, setUserQuotaSaving] = useState(false);

  const loadStores = async () => {
    try {
      const response = await api.get('/stores');
      const nextStores = response.data || [];
      setStores(nextStores);
      setSelectedStoreId((current) => current || String(nextStores[0]?.id || ''));
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal memuat daftar toko');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canManageStores) loadStores();
  }, [canManageStores]);

  const loadDevices = useCallback(async (storeId = selectedStoreId) => {
    if (!storeId) {
      setDevices([]);
      return;
    }
    setDevicesLoading(true);
    try {
      const response = await api.get('/store-devices', { params: { store_id: storeId } });
      const nextDevices = response.data || [];
      setDevices(nextDevices);
      setDeviceQuota(String(Math.max(1, nextDevices.filter((device) => device.status === 'active').length)));
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal memuat daftar device');
    } finally {
      setDevicesLoading(false);
    }
  }, [selectedStoreId]);

  useEffect(() => {
    if (canManageStores && selectedStoreId) loadDevices(selectedStoreId);
  }, [canManageStores, selectedStoreId, loadDevices]);

  useEffect(() => {
    const selectedStore = stores.find((store) => String(store.id) === String(selectedStoreId));
    if (selectedStore) setUserQuota(String(selectedStore.userLimit || 3));
  }, [stores, selectedStoreId]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setSaving(true);
    setCreatedOwner(null);
    try {
      const response = await api.post('/stores', form);
      setStores((current) => [...current, response.data.store]);
      setSelectedStoreId(String(response.data.store.id));
      setCreatedOwner({ store: response.data.store, owner: response.data.owner });
      setForm({ code: '', name: '', owner_username: '', owner_pin: '' });
      toast.success('Toko berhasil dibuat');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal membuat toko');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (store) => {
    if (store.id === user?.storeId) return;
    try {
      const response = await api.patch(`/stores/${store.id}`, { status: store.status === 'active' ? 'suspended' : 'active' });
      setStores((current) => current.map((item) => item.id === store.id ? response.data.store : item));
      toast.success(response.data.store.status === 'active' ? 'Toko diaktifkan' : 'Toko dinonaktifkan');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal mengubah status toko');
    }
  };

  const handleSaveUserQuota = async (event) => {
    event.preventDefault();
    if (!selectedStoreId) return toast.error('Pilih toko tujuan terlebih dahulu');
    setUserQuotaSaving(true);
    try {
      const response = await api.patch(`/stores/${selectedStoreId}`, { user_limit: Number(userQuota) });
      setStores((current) => current.map((store) => store.id === response.data.store.id ? response.data.store : store));
      setUserQuota(String(response.data.store.userLimit));
      toast.success(`Batas pengguna disimpan: ${response.data.store.userLimit} akun`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal mengubah batas pengguna');
    } finally {
      setUserQuotaSaving(false);
    }
  };

  const handleSaveDeviceQuota = async (event) => {
    event.preventDefault();
    if (!selectedStoreId) return toast.error('Pilih toko tujuan terlebih dahulu');
    setQuotaSaving(true);
    try {
      const response = await api.put('/store-devices/quota', {
        store_id: Number(selectedStoreId),
        device_limit: Number(deviceQuota)
      });
      setDevices(response.data.devices || []);
      setDeviceQuota(String(response.data.deviceLimit));
      toast.success(`Batas device ${response.data.deviceLimit} berhasil disimpan`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal mengubah batas device');
    } finally {
      setQuotaSaving(false);
    }
  };

  const toggleDeviceStatus = async (device) => {
    const nextStatus = device.status === 'revoked' ? 'active' : 'revoked';
    try {
      await api.patch(`/store-devices/${device.id}`, { status: nextStatus });
      await loadDevices(selectedStoreId);
      toast.success(nextStatus === 'active' ? 'Device diaktifkan' : 'Device dicabut');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal mengubah status device');
    }
  };

  const deleteDevice = async (device) => {
    if (!window.confirm(`Hapus device "${device.name}" dari toko ini? Slot device akan berkurang.`)) return;
    try {
      await api.delete(`/store-devices/${device.id}`);
      await loadDevices(selectedStoreId);
      toast.success('Device berhasil dihapus');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal menghapus device');
    }
  };

  if (user?.role !== 'super_admin') {
    return <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Manajemen toko hanya dapat diakses oleh pengelola platform.</div>;
  }

  if (!canManageStores) {
    return (
      <div style={{ padding: '1rem', width: '100%', maxWidth: '700px', paddingBottom: '90px' }}>
        <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem' }}>
          <h2 style={{ margin: '0 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}><Store size={25} color="var(--primary)" /> Toko Saya</h2>
          <p style={{ margin: '0 0 1.25rem', color: 'var(--text-secondary)' }}>Informasi toko yang sedang digunakan oleh akun ini.</p>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div><small style={{ color: 'var(--text-secondary)' }}>Nama Toko</small><strong style={{ display: 'block', fontSize: '1.1rem' }}>{user.storeName || 'Toko Utama'}</strong></div>
            <div><small style={{ color: 'var(--text-secondary)' }}>Kode Toko</small><strong style={{ display: 'block' }}>{user.storeCode || 'utama'}</strong></div>
          </div>
          <p style={{ margin: '1.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Untuk mengganti nama toko, buka menu Pengaturan. Untuk menambah toko baru, masuk menggunakan Super Admin dengan kode toko <strong>utama</strong>.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem', width: '100%', maxWidth: '1050px', paddingBottom: '90px' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.6rem' }}><Store size={25} color="var(--primary)" /> Manajemen Toko</h2>
        <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)' }}>Buat ruang data terpisah untuk setiap toko yang menggunakan ZnnCashier.</p>
      </div>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><UserPlus size={20} /> Tambah Toko dan Pemilik</h3>
        <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <label className="input-label">Kode Toko<input className="modal-input" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value.toLowerCase() })} minLength="3" maxLength="32" placeholder="contoh: toko-baru" required /></label>
          <label className="input-label">Nama Toko<input className="modal-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength="120" placeholder="Contoh: Toko Makmur" required /></label>
          <label className="input-label">Username Pemilik<input className="modal-input" value={form.owner_username} onChange={(event) => setForm({ ...form, owner_username: event.target.value.toLowerCase() })} minLength="3" maxLength="50" placeholder="owner" required /></label>
          <label className="input-label">PIN Pemilik<input className="modal-input" type="password" inputMode="numeric" value={form.owner_pin} onChange={(event) => setForm({ ...form, owner_pin: event.target.value })} minLength="4" maxLength="12" placeholder="4–12 angka" required /></label>
          <button type="submit" className="btn btn-primary" disabled={saving}><UserPlus size={18} /> {saving ? 'Membuat...' : 'Buat Toko'}</button>
        </form>
        {createdOwner && (
          <div style={{ marginTop: '1rem', padding: '0.9rem', borderRadius: '9px', border: '1px solid rgba(59, 130, 246, 0.4)', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--text-primary)', fontSize: '0.86rem' }}>
            <strong>Toko berhasil dibuat.</strong> Simpan informasi login ini untuk pemilik toko: <strong>{createdOwner.store.name}</strong> · Kode <strong>{createdOwner.store.code}</strong> · Username <strong>{createdOwner.owner.username}</strong>.
          </div>
        )}
      </div>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', overflowX: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem' }}>Daftar Toko</h3>
        {loading ? <div style={{ color: 'var(--text-secondary)' }}>Memuat toko...</div> : (
          <table style={{ width: '100%', minWidth: '650px', borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}><th style={{ padding: '0.7rem 0.4rem' }}>Nama Toko</th><th style={{ padding: '0.7rem 0.4rem' }}>Kode</th><th style={{ padding: '0.7rem 0.4rem' }}>Lisensi</th><th style={{ padding: '0.7rem 0.4rem' }}>Status</th><th style={{ padding: '0.7rem 0.4rem' }}>Aksi</th></tr></thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.7rem 0.4rem', fontWeight: '700' }}>{store.name}{store.id === user.storeId ? ' (Toko aktif)' : ''}</td>
                  <td style={{ padding: '0.7rem 0.4rem' }}>{store.code}</td>
                  <td style={{ padding: '0.7rem 0.4rem', fontFamily: 'monospace', fontSize: '0.8rem' }}>{store.licenseKey || '-'}</td>
                  <td style={{ padding: '0.7rem 0.4rem', color: store.status === 'active' ? 'var(--primary)' : 'var(--danger)', fontWeight: '700' }}>{store.status === 'active' ? 'Aktif' : 'Ditangguhkan'}</td>
                  <td style={{ padding: '0.7rem 0.4rem' }}><button type="button" className="btn" onClick={() => toggleStatus(store)} disabled={store.id === user.storeId}>{store.status === 'active' ? 'Tangguhkan' : 'Aktifkan'}</button></td>
                </tr>
              ))}
              {!stores.length && <tr><td colSpan="5" style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>Belum ada toko.</td></tr>}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: '0.8rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Total toko: {formatNumber(stores.length)}</div>
      </div>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginTop: '1rem' }}>
        <h3 style={{ margin: '0 0 0.35rem' }}>Batas Pengguna Toko</h3>
        <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Atur jumlah akun aktif yang boleh digunakan toko terpilih. Batas awal setiap toko adalah 3 akun.</p>
        <form onSubmit={handleSaveUserQuota} style={{ display: 'flex', alignItems: 'end', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label className="input-label" style={{ minWidth: '220px' }}>Toko tujuan<select className="modal-input" value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name} ({store.code})</option>)}</select></label>
          <label className="input-label" style={{ width: '220px' }}>Batas total pengguna<input className="modal-input" type="number" min="1" max="100" value={userQuota} onChange={(event) => setUserQuota(event.target.value)} required /></label>
          <button type="submit" className="btn btn-primary" disabled={userQuotaSaving || !selectedStoreId}>{userQuotaSaving ? 'Menyimpan...' : 'Simpan Batas Pengguna'}</button>
        </form>
      </div>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginTop: '1rem', overflowX: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Laptop size={20} /> Device Toko</h3>
            <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Tentukan kuota mesin kasir untuk toko yang Anda pilih. Penambahan device dikendalikan oleh Toko Utama.</p>
          </div>
        </div>

        <form onSubmit={handleSaveDeviceQuota} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 220px) auto', gap: '0.75rem', alignItems: 'end' }}>
          <label className="input-label">Batas total device<input className="modal-input" type="number" min="1" max="50" value={deviceQuota} onChange={(event) => setDeviceQuota(event.target.value)} required /><small style={{ color: 'var(--text-secondary)' }}>Contoh: isi 6 untuk mengizinkan 6 mesin.</small></label>
          <button type="submit" className="btn btn-primary" disabled={quotaSaving || !selectedStoreId}>{quotaSaving ? 'Menyimpan...' : 'Simpan Batas Device'}</button>
        </form>

        <div style={{ marginTop: '1.25rem' }}>
          {devicesLoading ? <div style={{ color: 'var(--text-secondary)' }}>Memuat device...</div> : (
            <table style={{ width: '100%', minWidth: '760px', borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}><th style={{ padding: '0.7rem 0.4rem' }}>Nama Device</th><th style={{ padding: '0.7rem 0.4rem' }}>Jenis</th><th style={{ padding: '0.7rem 0.4rem' }}>Pemasangan</th><th style={{ padding: '0.7rem 0.4rem' }}>Status</th><th style={{ padding: '0.7rem 0.4rem' }}>Aksi</th></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '0.7rem 0.4rem', fontWeight: '700' }}>{device.name}</td>
                    <td style={{ padding: '0.7rem 0.4rem' }}>{device.deviceType === 'cashier' ? 'Komputer Kasir' : device.deviceType === 'scanner' ? 'HP Scanner' : device.deviceType === 'tablet' ? 'Tablet' : 'Lainnya'}</td>
                    <td style={{ padding: '0.7rem 0.4rem' }}>{device.deviceId ? 'Sudah terpasang' : 'Belum terpasang'}</td>
                    <td style={{ padding: '0.7rem 0.4rem', color: device.status === 'revoked' ? 'var(--danger)' : device.status === 'active' ? 'var(--primary)' : 'var(--text-secondary)', fontWeight: '700' }}>{device.status === 'active' ? 'Aktif' : device.status === 'revoked' ? 'Dicabut' : 'Menunggu Aktivasi'}</td>
                    <td style={{ padding: '0.7rem 0.4rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}><button type="button" className="btn" onClick={() => toggleDeviceStatus(device)}><RefreshCw size={15} /> {device.status === 'revoked' ? 'Aktifkan' : 'Cabut'}</button><button type="button" className="btn" onClick={() => deleteDevice(device)}><Trash2 size={15} /> Hapus</button></td>
                  </tr>
                ))}
                {!devices.length && <tr><td colSpan="5" style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>Belum ada device untuk toko ini.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ marginTop: '0.8rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Kuota device: {formatNumber(devices.filter((device) => device.status === 'active').length)} aktif · Data tetap terikat pada toko yang dipilih.</div>
      </div>
    </div>
  );
}
