import { Search, Sun, Moon, Camera, Settings, Wifi, WifiOff, CircleUserRound, LogOut, BriefcaseBusiness } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BarcodeScannerModal from './BarcodeScannerModal';
import api from '../api';
import { useAuth } from '../auth/useAuth';
import { formatNumber } from '../utils/numberFormat';

export default function Navbar({ theme, toggleTheme, searchQuery, setSearchQuery, onSearchEnter, onBarcodeScanned, currentShift, onShiftChange, cartHasItems }) {
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [connectionState, setConnectionState] = useState(navigator.onLine ? 'checking' : 'offline');
  const [shiftLoading, setShiftLoading] = useState(false);
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const roleLabel = user?.role === 'super_admin' ? 'Super Admin' : user?.role === 'admin' ? 'Admin Toko' : 'Kasir';

  useEffect(() => {
    const markOffline = () => setConnectionState('offline');
    const checkBackend = async () => {
      if (!navigator.onLine) {
        setConnectionState('offline');
        return;
      }
      try {
        await api.get('/auth/status', { timeout: 4000 });
        setConnectionState('online');
      } catch {
        setConnectionState('offline');
      }
    };

    window.addEventListener('online', checkBackend);
    window.addEventListener('offline', markOffline);
    checkBackend();
    const interval = window.setInterval(checkBackend, 30000);
    return () => {
      window.removeEventListener('online', checkBackend);
      window.removeEventListener('offline', markOffline);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    api.get('/shifts/current')
      .then((response) => {
        if (mounted) onShiftChange?.(response.data?.shift || null);
      })
      .catch(() => {
        if (mounted) onShiftChange?.(null);
      });
    return () => { mounted = false; };
  }, [onShiftChange]);

  const handleOpenShift = async () => {
    const openingCashInput = window.prompt('Saldo awal kas (boleh 0):', '0');
    if (openingCashInput === null) return;
    const openingCash = Number(openingCashInput);
    if (!Number.isFinite(openingCash) || openingCash < 0) {
      toast.error('Saldo awal kas tidak valid');
      return;
    }
    setShiftLoading(true);
    try {
      const response = await api.post('/shifts/open', { opening_cash: openingCash });
      onShiftChange?.(response.data.shift);
      toast.success(`Shift #${formatNumber(response.data.shift.id)} dibuka`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal membuka shift');
    } finally {
      setShiftLoading(false);
    }
  };

  const handleCloseShift = async () => {
    if (!currentShift) return;
    if (cartHasItems && !window.confirm('Keranjang masih berisi barang. Tutup shift tetap dilanjutkan?')) return;
    const closingCashInput = window.prompt('Saldo akhir kas fisik:', String(currentShift.expected_cash ?? currentShift.opening_cash ?? 0));
    if (closingCashInput === null) return;
    const closingCash = Number(closingCashInput);
    if (!Number.isFinite(closingCash) || closingCash < 0) {
      toast.error('Saldo akhir kas tidak valid');
      return;
    }
    setShiftLoading(true);
    try {
      const response = await api.post(`/shifts/${currentShift.id}/close`, { closing_cash: closingCash });
      onShiftChange?.(null);
      toast.success(`Shift ditutup. Selisih: ${formatNumber(response.data.shift.variance || 0)}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menutup shift');
    } finally {
      setShiftLoading(false);
    }
  };

  const openSettings = () => {
    if (user?.role !== 'super_admin') {
      toast.error('Pengaturan hanya dapat dibuka oleh Super Admin');
      return;
    }
    navigate('/settings');
  };

  return (
    <>
      <div className="navbar">
        <div className="navbar-store-title" aria-label={`Toko aktif: ${user?.storeName || 'Toko Utama'}`}>
          <span className="navbar-brand-name">ZnnCashier</span>
          <strong>{user?.storeName || 'Toko Utama'}</strong>
          <span className="navbar-store-code">Kode: {user?.storeCode || 'utama'}</span>
        </div>
        <div className="search-bar">
          <Search size={20} color="var(--text-secondary)" />
          <input 
            type="text" 
            placeholder="Cari produk atau scan barcode..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onSearchEnter) {
                onSearchEnter(searchQuery);
              }
            }}
          />
          <button type="button" onClick={() => setShowCameraScanner(true)} aria-label="Scan barcode dengan kamera" title="Scan barcode dengan kamera" style={{ color: 'var(--primary)', display: 'flex', alignItems: 'center', padding: '4px' }}>
            <Camera size={21} />
          </button>
        </div>

        <div className="navbar-actions" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className={`navbar-shift-control${currentShift ? ' active' : ''}`} title={currentShift ? `Shift aktif #${formatNumber(currentShift.id)}` : 'Shift belum dibuka'}>
            <div className="navbar-shift-status" aria-label={currentShift ? `Shift aktif nomor ${currentShift.id}` : 'Shift belum dibuka'}>
              <BriefcaseBusiness size={17} />
              <span className="navbar-shift-indicator" aria-hidden="true" />
              <span className="navbar-shift-label">{currentShift ? `Shift Aktif · #${formatNumber(currentShift.id)}` : 'Shift Belum Dibuka'}</span>
            </div>
            <button type="button" className="navbar-shift-action" onClick={currentShift ? handleCloseShift : handleOpenShift} disabled={shiftLoading}>
              {shiftLoading ? 'Memproses...' : currentShift ? 'Tutup Shift' : 'Buka Shift'}
            </button>
          </div>
          <div
            title={connectionState === 'online' ? 'Terhubung ke backend' : connectionState === 'checking' ? 'Memeriksa koneksi' : 'Backend tidak terhubung'}
            aria-label={connectionState === 'online' ? 'Status koneksi online' : connectionState === 'checking' ? 'Status koneksi sedang diperiksa' : 'Status koneksi offline'}
            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: connectionState === 'online' ? 'var(--success)' : connectionState === 'checking' ? 'var(--text-secondary)' : 'var(--danger)', fontSize: '0.72rem', whiteSpace: 'nowrap' }}
          >
            {connectionState === 'offline' ? <WifiOff size={17} /> : <Wifi size={17} />}
            <span className="connection-status-label">{connectionState === 'online' ? 'Online' : connectionState === 'checking' ? 'Cek...' : 'Offline'}</span>
          </div>
          <button type="button" onClick={toggleTheme} aria-label="Ubah mode tampilan" title="Ubah mode tampilan" style={{ color: 'var(--text-primary)', transition: 'transform 0.2s', ':hover': { transform: 'scale(1.1)' } }}>
            {theme === 'dark' ? <Sun size={24} /> : <Moon size={24} />}
          </button>
          {user?.role === 'super_admin' && (
            <button type="button" onClick={openSettings} aria-label="Buka pengaturan" title="Pengaturan" style={{ color: 'var(--text-primary)', display: 'flex', alignItems: 'center', padding: '4px' }}>
              <Settings size={22} />
            </button>
          )}
          <div className={`navbar-account-menu${showAccountMenu ? ' open' : ''}`}>
            <button
              type="button"
              className="navbar-account-toggle"
              onClick={() => setShowAccountMenu((current) => !current)}
              aria-label={`Akun aktif: ${user?.username || '-'} · ${roleLabel}`}
              aria-expanded={showAccountMenu}
              title={`Akun aktif: ${user?.username || '-'} · ${roleLabel}`}
            >
              <CircleUserRound size={22} />
            </button>
            {showAccountMenu && (
              <>
                <div className="navbar-account-store">
                  <strong>{user?.storeName || 'Toko Utama'}</strong>
                  <span>Kode: {user?.storeCode || 'utama'}</span>
                </div>
                <button type="button" className="navbar-account-logout" onClick={logout} aria-label="Keluar dari akun" title="Keluar">
                  <LogOut size={17} />
                  <span>Keluar</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      
      {showCameraScanner && <BarcodeScannerModal onClose={() => setShowCameraScanner(false)} onScan={onBarcodeScanned} />}
    </>
  );
}
