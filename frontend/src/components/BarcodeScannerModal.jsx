import { useEffect, useRef } from 'react';
import { Camera, X } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import toast from 'react-hot-toast';

export default function BarcodeScannerModal({ onClose, onScan, title = 'Scan Barcode', description = 'Arahkan kamera belakang ke kode batang produk.' }) {
  const hasScannedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onCloseRef.current = onClose;
    onScanRef.current = onScan;
  }, [onClose, onScan]);

  useEffect(() => {
    const scanner = new Html5Qrcode('barcode-scanner-reader');
    let disposed = false;

    const start = async () => {
      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 280, height: 150 } },
          async (decodedText) => {
            if (disposed || hasScannedRef.current) return;
            hasScannedRef.current = true;
            if (scanner.isScanning) {
              await scanner.stop();
            }
            onCloseRef.current();
            onScanRef.current(decodedText);
          },
          () => {}
        );
      } catch (error) {
        if (disposed) return;
        console.error('Camera scanner error:', error);
        toast.error('Kamera tidak dapat dibuka. Pastikan izin kamera diberikan.');
        onCloseRef.current();
      }
    };

    start();
    return () => {
      disposed = true;
      if (scanner.isScanning) {
        scanner.stop().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: '480px' }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Camera size={24} /> {title}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)' }} aria-label="Tutup scanner">
            <X size={24} />
          </button>
        </div>
        <div id="barcode-scanner-reader" style={{ width: '100%' }} />
        <p style={{ margin: '1rem 0 0', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
          {description}
        </p>
      </div>
    </div>
  );
}
