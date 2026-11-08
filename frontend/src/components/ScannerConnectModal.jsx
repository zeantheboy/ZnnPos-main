import { useState, useEffect } from 'react';
import { X, Smartphone, Wifi, Copy, ShieldCheck, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import api from '../api';
import { getScannerChannel } from '../utils/scannerSession';
import { useAuth } from '../auth/useAuth';

export default function ScannerConnectModal({ onClose }) {
  const [localIp, setLocalIp] = useState('');
  const [httpsPort, setHttpsPort] = useState(3002);
  const [mobilePosAvailable, setMobilePosAvailable] = useState(false);
  const [copiedLink, setCopiedLink] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuth();
  
  useEffect(() => {
    api.get('/ip')
      .then(res => {
        setLocalIp(res.data.ip);
        if (res.data.httpsPort) setHttpsPort(res.data.httpsPort);
        setMobilePosAvailable(Boolean(res.data.mobilePosAvailable));
      })
      .catch(err => console.error('Failed to get IP', err))
      .finally(() => setIsLoading(false));
  }, []);

  const mobilePosUrl = `https://${localIp || 'localhost'}:${httpsPort}/`;
  const scannerUrl = `https://${localIp || 'localhost'}:${httpsPort}/scanner?channel=${encodeURIComponent(getScannerChannel())}&store=${encodeURIComponent(user?.storeId || '')}`;

  const copyLink = async (url, label) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(label);
      window.setTimeout(() => setCopiedLink(''), 2000);
    } catch (error) {
      console.error('Failed to copy link', error);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '500px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Smartphone size={24} /> Akses POS & Scanner di HP
          </h2>
          <button onClick={onClose} style={{ cursor: 'pointer', background: 'none', border: 'none' }}>
            <X size={24} color="var(--text-secondary)" />
          </button>
        </div>

        <div style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.35)', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
          <div style={{ fontWeight: '800', color: 'var(--primary)', marginBottom: '0.4rem' }}>
            1. LINK UTAMA — BUKA POS LENGKAP DI HP
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Gunakan link ini untuk membuka kasir, produk, analisis, dan scanner kamera langsung dari HP.
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ background: '#fff', padding: '1rem', borderRadius: '12px', display: 'inline-block', marginBottom: '1rem' }}>
            {!isLoading ? (
              <QRCodeSVG value={mobilePosUrl} size={200} />
            ) : (
              <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9', color: '#000' }}>Loading...</div>
            )}
            </div>
            <div style={{ fontSize: '0.95rem', fontWeight: 'bold', wordBreak: 'break-all' }}>
              {isLoading ? 'Mengambil alamat...' : mobilePosUrl}
            </div>
            <button type="button" onClick={() => copyLink(mobilePosUrl, 'pos')} disabled={isLoading} style={{ marginTop: '0.75rem', padding: '0.6rem 0.9rem', border: 'none', borderRadius: '8px', background: 'var(--primary)', color: '#fff', cursor: isLoading ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <Copy size={16} /> {copiedLink === 'pos' ? 'Link POS tersalin' : 'Salin link POS'}
            </button>
          </div>
          {!isLoading && !mobilePosAvailable && (
            <div style={{ marginTop: '1rem', padding: '0.75rem', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)', fontSize: '0.82rem' }}>
              POS lengkap belum tersedia pada server HTTPS. Jalankan <strong>npm run build:frontend</strong>, lalu buka ulang aplikasi. Link scanner di bawah tetap dapat digunakan.
            </div>
          )}
        </div>

        <div style={{ background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ fontWeight: '800', color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
            2. LINK SCANNER BARCODE SAJA
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            Gunakan ini jika HP hanya dipakai sebagai pemindai barcode nirkabel.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <code style={{ flex: '1 1 260px', padding: '0.65rem', background: 'var(--surface-color)', borderRadius: '8px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
              {isLoading ? 'Mengambil alamat...' : scannerUrl}
            </code>
            <button type="button" onClick={() => copyLink(scannerUrl, 'scanner')} disabled={isLoading} style={{ padding: '0.6rem 0.9rem', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--surface-color)', color: 'var(--text-primary)', cursor: isLoading ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <Copy size={16} /> {copiedLink === 'scanner' ? 'Tersalin' : 'Salin'}
            </button>
          </div>
        </div>

        <div style={{ backgroundColor: 'var(--bg-color)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
          <h3 style={{ marginTop: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wifi size={18} /> Cara membuka di HP
          </h3>
          <ol style={{ margin: 0, paddingLeft: '1.2rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <li>Pastikan HP berada di <strong>Wi-Fi yang sama</strong> dengan komputer POS.</li>
            <li>Untuk POS lengkap, scan QR pada bagian <strong>LINK UTAMA</strong>.</li>
            <li>Untuk scanner saja, buka atau salin link pada bagian <strong>LINK SCANNER BARCODE SAJA</strong>.</li>
            <li>Jika memakai Windows dan HP tidak terhubung, jalankan <strong>fix-firewall.bat</strong> sebagai Administrator. Di macOS, izinkan Node/Electron pada pengaturan Firewall.</li>
          </ol>
        </div>

        <div style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid var(--warning)', padding: '1rem', borderRadius: 'var(--radius-md)', marginTop: '1rem', color: 'var(--warning)', fontSize: '0.85rem' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.35rem' }}>
                <ShieldCheck size={18} style={{ flexShrink: 0 }} />
                <strong>Peringatan keamanan browser</strong>
              </div>
              Karena aplikasi berjalan di jaringan lokal, browser HP mungkin menampilkan "Your connection is not private".
              <br/><br/>
              Tekan <strong>Advanced</strong> -&gt; <strong>Proceed to 192.168... (unsafe)</strong>. Setelah itu kamera dapat digunakan.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
