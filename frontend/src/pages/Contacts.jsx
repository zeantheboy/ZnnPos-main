import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Search, Truck, UserRound, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import api from '../api';
import { formatNumber } from '../utils/numberFormat';
import { useAuth } from '../auth/useAuth';

const emptyForm = { name: '', phone: '', email: '', address: '', notes: '' };

export default function Contacts() {
  const { user } = useAuth();
  const canManage = user?.role === 'super_admin' || user?.role === 'admin';
  const [tab, setTab] = useState('customers');
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [pagination, setPagination] = useState({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const isCustomers = tab === 'customers';
  const resource = isCustomers ? 'customers' : 'suppliers';
  const title = isCustomers ? 'Pelanggan' : 'Supplier';

  const loadContacts = useCallback(async (page = 1, nextSearch = appliedSearch) => {
    setLoading(true);
    try {
      const response = await api.get(`/${resource}`, {
        params: { page, page_size: 25, search: nextSearch, include_inactive: canManage ? 'true' : 'false' }
      });
      setItems(response.data?.items || []);
      setPagination(response.data?.pagination || { page, pageSize: 25, total: 0, totalPages: 0 });
    } catch (err) {
      toast.error(err.response?.data?.error || `Gagal memuat ${title.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, canManage, resource, title]);

  useEffect(() => {
    loadContacts(1, appliedSearch);
  }, [appliedSearch, canManage, loadContacts, tab]);

  const startCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setFormOpen(true);
  };

  const startEdit = (item) => {
    setEditing(item);
    setForm({
      name: item.name || '',
      phone: item.phone || '',
      email: item.email || '',
      address: item.address || '',
      notes: item.notes || ''
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    if (!saving) setFormOpen(false);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) {
      toast.error(`Nama ${isCustomers ? 'pelanggan' : 'supplier'} wajib diisi`);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        notes: form.notes.trim()
      };
      if (editing) {
        await api.patch(`/${resource}/${editing.id}`, payload);
        toast.success(`${title} berhasil diperbarui`);
      } else {
        await api.post(`/${resource}`, payload);
        toast.success(`${title} berhasil ditambahkan`);
      }
      setFormOpen(false);
      await loadContacts(editing ? pagination.page : 1, appliedSearch);
    } catch (err) {
      toast.error(err.response?.data?.error || `Gagal menyimpan ${title.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item) => {
    try {
      await api.patch(`/${resource}/${item.id}`, { active: Number(item.active) !== 1 });
      toast.success(`${title} ${Number(item.active) === 1 ? 'dinonaktifkan' : 'diaktifkan'}`);
      await loadContacts(pagination.page, appliedSearch);
    } catch (err) {
      toast.error(err.response?.data?.error || `Gagal mengubah status ${title.toLowerCase()}`);
    }
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setAppliedSearch(search.trim());
    loadContacts(1, search.trim());
  };

  return (
    <div style={{ padding: '1rem', width: '100%', maxWidth: '980px', paddingBottom: '90px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Pelanggan & Supplier</h2>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>Simpan data kontak untuk transaksi dan operasional toko.</p>
        </div>
        {(isCustomers || canManage) && (
          <button type="button" className="btn btn-primary" onClick={startCreate} style={{ width: 'auto' }}>
            <Plus size={18} /> Tambah {isCustomers ? 'Pelanggan' : 'Supplier'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
        <button type="button" onClick={() => setTab('customers')} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: isCustomers ? '#3b82f6' : 'var(--surface-opaque)', color: isCustomers ? '#fff' : 'var(--text-primary)', fontWeight: '700' }}>
          <UserRound size={16} style={{ verticalAlign: 'middle', marginRight: '5px' }} /> Pelanggan
        </button>
        <button type="button" onClick={() => setTab('suppliers')} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: !isCustomers ? '#3b82f6' : 'var(--surface-opaque)', color: !isCustomers ? '#fff' : 'var(--text-primary)', fontWeight: '700' }}>
          <Truck size={16} style={{ verticalAlign: 'middle', marginRight: '5px' }} /> Supplier
        </button>
      </div>

      <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-opaque)' }}>
          <Search size={18} color="var(--text-secondary)" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Cari ${title.toLowerCase()}...`} style={{ width: '100%', padding: '10px 0', border: 0, outline: 0, background: 'transparent', color: 'var(--text-primary)' }} />
        </div>
        <button type="submit" className="btn" style={{ width: 'auto' }}>Cari</button>
      </form>

      <div style={{ marginBottom: '0.6rem', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
        {formatNumber(pagination.total)} {title.toLowerCase()} ditemukan
      </div>

      {loading ? <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Memuat...</div> : items.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '10px', color: 'var(--text-secondary)' }}>Belum ada data {title.toLowerCase()}.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          {items.map((item) => {
            const active = Number(item.active) === 1;
            return (
              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', padding: '0.9rem 1rem', border: '1px solid var(--border-color)', borderRadius: '10px', background: 'var(--surface-opaque)', opacity: active ? 1 : 0.62 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</strong>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '3px' }}>{item.phone || 'Tanpa nomor telepon'}{item.email ? ` · ${item.email}` : ''}</div>
                  {item.address && <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '3px' }}>{item.address}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '0.75rem', color: active ? 'var(--success)' : 'var(--danger)', fontWeight: '700' }}>{active ? 'Aktif' : 'Nonaktif'}</span>
                  {canManage && <>
                    <button type="button" className="btn" onClick={() => startEdit(item)} aria-label={`Edit ${title.toLowerCase()} ${item.name}`} title="Edit" style={{ width: 'auto', padding: '8px' }}><Pencil size={16} /></button>
                    <button type="button" className="btn" onClick={() => toggleActive(item)} style={{ width: 'auto', padding: '8px 10px', color: active ? '#fca5a5' : '#86efac' }}>{active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                  </>}</div>
              </div>
            );
          })}
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}>
          <button type="button" className="btn" disabled={loading || pagination.page <= 1} onClick={() => loadContacts(pagination.page - 1)}>Sebelumnya</button>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Halaman {formatNumber(pagination.page)} / {formatNumber(pagination.totalPages)}</span>
          <button type="button" className="btn" disabled={loading || pagination.page >= pagination.totalPages} onClick={() => loadContacts(pagination.page + 1)}>Berikutnya</button>
        </div>
      )}

      {formOpen && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal-content" style={{ maxWidth: '520px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>{editing ? 'Edit' : 'Tambah'} {title}</h3>
              <button type="button" onClick={closeForm} style={{ color: 'var(--text-secondary)' }}><X size={21} /></button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <label className="input-label">Nama *<input className="modal-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required autoFocus /></label>
              <label className="input-label">Telepon<input className="modal-input" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} inputMode="tel" /></label>
              <label className="input-label">Email<input className="modal-input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
              <label className="input-label">Alamat<textarea className="modal-input" rows="2" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
              <label className="input-label">Catatan<textarea className="modal-input" rows="2" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <div style={{ display: 'flex', gap: '8px', marginTop: '0.25rem' }}>
                <button type="button" className="btn" onClick={closeForm} disabled={saving}>Batal</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Menyimpan...' : 'Simpan'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
