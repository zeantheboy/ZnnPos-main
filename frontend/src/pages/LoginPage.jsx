import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, LogIn, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

export default function LoginPage({ mode }) {
  const { login, bootstrap } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('owner');
  const [storeCode, setStoreCode] = useState('utama');
  const [pin, setPin] = useState('');
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const isBootstrap = mode === 'bootstrap';

  useEffect(() => {
    setStep(1);
  }, [mode]);

  const handleStoreSubmit = async (event) => {
    event.preventDefault();
    const normalizedCode = String(storeCode || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(normalizedCode)) {
      toast.error('Kode toko harus 3-32 karakter: huruf kecil, angka, atau tanda hubung');
      return;
    }
    setStoreCode(normalizedCode);
    setStep(2);
  };

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

        <form onSubmit={step === 1 ? handleStoreSubmit : handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {step === 1 ? (
            <>
              <label className="input-label">
                Kode Toko
                <input className="modal-input" value={storeCode} onChange={(event) => setStoreCode(event.target.value)} minLength="3" maxLength="32" autoComplete="organization" autoFocus required placeholder="utama" />
                <small style={{ color: 'var(--text-secondary)' }}>Masukkan kode toko yang diberikan pemilik aplikasi.</small>
              </label>
              <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', marginTop: '0.5rem' }}>
                <ArrowRight size={19} /> {saving ? 'Memeriksa...' : 'Lanjutkan'}
              </button>
            </>
          ) : (
            <>
              <div style={{ padding: '0.85rem 1rem', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '0.78rem' }}>Toko terpilih</div>
                <strong style={{ color: 'var(--text-primary)' }}>Kode toko siap digunakan</strong>
                <div style={{ fontSize: '0.82rem' }}>Kode: {storeCode}</div>
              </div>
              <label className="input-label">
                Username {isBootstrap ? '' : '(opsional untuk PIN lama)'}
                <input className="modal-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus minLength="3" maxLength="50" required={isBootstrap} placeholder="owner" />
              </label>
              <label className="input-label">
                PIN / Password
                <input className="modal-input" type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} autoComplete={isBootstrap ? 'new-password' : 'current-password'} minLength="4" maxLength="128" required />
              </label>
              <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', marginTop: '0.5rem' }}>
                <LogIn size={19} /> {saving ? 'Memproses...' : isBootstrap ? 'Buat Super Admin' : 'Masuk'}
              </button>
              <button type="button" onClick={() => setStep(1)} disabled={saving} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: '0.4rem', padding: '0.25rem' }}>
                <ArrowLeft size={16} /> Ganti kode toko
              </button>
            </>
          )}
        </form>

      </div>
    </div>
  );
}
