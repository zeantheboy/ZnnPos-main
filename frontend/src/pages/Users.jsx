import { useEffect, useState } from 'react';
import { UserPlus, UserCog } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../auth/useAuth';

const roleLabels = {
  super_admin: 'Super Admin',
  admin: 'Admin Toko',
  cashier: 'Kasir'
};
export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState('admin');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userLimit, setUserLimit] = useState(3);
  const activeUserCount = users.filter((item) => item.active).length;
  const activeLimitReached = activeUserCount >= userLimit;

  const loadUsers = async () => {
    try {
      const [usersResponse, quotaResponse] = await Promise.all([api.get('/users'), api.get('/users/quota')]);
      setUsers(usersResponse.data);
      setUserLimit(Number(quotaResponse.data?.userLimit || 3));
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal memuat pengguna');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'super_admin') loadUsers();
  }, [user?.role]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await api.post('/users', { username, pin, role });
      setUsers((current) => [...current, response.data.user].sort((a, b) => a.username.localeCompare(b.username)));
      setUsername('');
      setPin('');
      setRole('admin');
      toast.success('Pengguna berhasil dibuat');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal membuat pengguna');
    } finally {
      setSaving(false);
    }
  };

  const updateUser = async (target, changes) => {
    try {
      const response = await api.patch(`/users/${target.id}`, changes);
      setUsers((current) => current.map((item) => item.id === target.id ? response.data.user : item));
      toast.success('Pengguna berhasil diperbarui');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Gagal memperbarui pengguna');
    }
  };

  const resetPin = (target) => {
    const nextPin = window.prompt(`PIN baru untuk ${target.username} (4–12 angka):`, '');
    if (nextPin === null) return;
    if (!/^\d{4,12}$/.test(nextPin)) {
      toast.error('PIN harus terdiri dari 4 sampai 12 angka');
      return;
    }
    updateUser(target, { pin: nextPin });
  };

  if (user?.role !== 'super_admin') {
    return <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>Manajemen pengguna hanya dapat diakses oleh Super Admin.</div>;
  }

  return (
    <div style={{ padding: '1rem', width: '100%', maxWidth: '900px', paddingBottom: '90px' }}>
      <h2 style={{ margin: '0 0 1.5rem' }}>Manajemen Pengguna</h2>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', marginBottom: '1rem' }}>
        <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><UserPlus size={20} /> Tambah Pengguna</h3>
        <div style={{ marginBottom: '1rem', color: activeLimitReached ? 'var(--danger)' : 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: activeLimitReached ? '700' : '400' }}>
          Akun aktif: {activeUserCount}/{userLimit}. {activeLimitReached ? 'Batas tercapai. Minta Toko Utama menambah kuota atau nonaktifkan salah satu akun.' : `Maksimal ${userLimit} akun aktif untuk toko ini.`}
        </div>
        <form onSubmit={handleCreate} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
          <label className="input-label">Username<input className="modal-input" value={username} onChange={(event) => setUsername(event.target.value)} minLength="3" maxLength="50" autoComplete="off" required /></label>
          <label className="input-label">PIN / Password<input className="modal-input" type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} minLength="4" maxLength="12" autoComplete="new-password" required /></label>
          <label className="input-label">Role<select className="modal-input" value={role} onChange={(event) => setRole(event.target.value)}><option value="admin">Admin Toko</option><option value="cashier">Kasir</option><option value="super_admin">Super Admin</option></select></label>
          <button type="submit" className="btn btn-primary" disabled={saving || activeLimitReached}><UserPlus size={18} /> {saving ? 'Menyimpan...' : activeLimitReached ? 'Batas Akun Tercapai' : 'Buat Akun'}</button>
        </form>
      </div>

      <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', overflowX: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><UserCog size={20} /> Daftar Pengguna</h3>
        {loading ? <div style={{ color: 'var(--text-secondary)' }}>Memuat pengguna...</div> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
            <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}><th style={{ padding: '0.7rem 0.4rem' }}>Username</th><th style={{ padding: '0.7rem 0.4rem' }}>Role</th><th style={{ padding: '0.7rem 0.4rem' }}>Status</th><th style={{ padding: '0.7rem 0.4rem' }}>Aksi</th></tr></thead>
            <tbody>
              {users.map((target) => (
                <tr key={target.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '0.7rem 0.4rem', fontWeight: '600' }}>{target.username}{target.id === user.id ? ' (Anda)' : ''}</td>
                  <td style={{ padding: '0.7rem 0.4rem' }}>
                    <select className="modal-input" value={target.role} onChange={(event) => updateUser(target, { role: event.target.value })} disabled={target.id === user.id}>
                      {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '0.7rem 0.4rem' }}>{target.active ? 'Aktif' : 'Nonaktif'}</td>
                  <td style={{ padding: '0.7rem 0.4rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button type="button" className="btn" onClick={() => updateUser(target, { active: !target.active })} disabled={target.id === user.id}>{target.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
                    <button type="button" className="btn" onClick={() => resetPin(target)}>Reset PIN</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
