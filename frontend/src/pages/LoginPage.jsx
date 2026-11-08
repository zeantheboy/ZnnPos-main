import { useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

export default function LoginPage({ mode }) {
  const { login, bootstrap } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('owner');
  const [storeCode, setStoreCode] = useState('utama');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const isBootstrap = mode === 'bootstrap';

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (isBootstrap) {
        await bootstrap(username, pin);
        toast.success('Super Admin berhasil dibuat');
      } else {
        await login(username, pin, storeCode);
        toast.success('Login berhasil');
      }
      navigate('/', { replace: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Tidak dapat masuk ke aplikasi');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1rem', background: 'var(--bg-color)' }}>
      <div style={{ width: '100%', maxWidth: '420px', background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <ShieldCheck size={32} color="var(--primary)" />
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{isBootstrap ? 'Buat Super Admin' : 'Masuk ke ZnnCashier'}</h1>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{isBootstrap ? 'Buat akun pemilik untuk pertama kali.' : 'Gunakan akun toko Anda.'}</div>
          </div>
        </div>

        {isBootstrap && (
          <div style={{ padding: '0.8rem', marginBottom: '1rem', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Jika PIN Admin lama sudah tersedia, masukkan PIN tersebut untuk mengubahnya menjadi akun Super Admin.
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label className="input-label">
            Kode Toko
            <input className="modal-input" value={storeCode} onChange={(event) => setStoreCode(event.target.value)} minLength="3" maxLength="32" autoComplete="organization" required={!isBootstrap} placeholder="utama" />
            {!isBootstrap && <small style={{ color: 'var(--text-secondary)' }}>Gunakan kode toko yang diberikan pemilik aplikasi.</small>}
          </label>
          <label className="input-label">
            Username {isBootstrap ? '' : '(opsional untuk PIN lama)'}
            <input className="modal-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength="3" maxLength="50" required={isBootstrap} placeholder="owner" />
          </label>
          <label className="input-label">
            PIN / Password
            <input className="modal-input" type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} autoComplete={isBootstrap ? 'new-password' : 'current-password'} minLength="4" maxLength="128" required />
          </label>
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', marginTop: '0.5rem' }}>
            <LogIn size={19} /> {saving ? 'Memproses...' : isBootstrap ? 'Buat Super Admin' : 'Masuk'}
          </button>
        </form>

      </div>
    </div>
  );
}
