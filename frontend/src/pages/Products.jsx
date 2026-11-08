import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { ClipboardCheck, History, Lock, Minus, PackagePlus, Pencil, Plus, Printer, Trash2, X } from 'lucide-react';
import { io } from 'socket.io-client';
import api from '../api';
import BarcodeScannerModal from '../components/BarcodeScannerModal';
import { filterAndSortProducts } from '../utils/productSearch';
import { formatNumber } from '../utils/numberFormat';
import { getScannerChannel } from '../utils/scannerSession';
import { useAuth } from '../auth/useAuth';

function Products({ searchQuery = '', productScanRequest = null, onProductScanHandled }) {
  const { user } = useAuth();
  const canManageProducts = user?.role === 'super_admin' || user?.role === 'admin';
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [stock, setStock] = useState('');
  const [barcode, setBarcode] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [stockProduct, setStockProduct] = useState(null);
  const [stockAction, setStockAction] = useState('add');
  const [stockAmount, setStockAmount] = useState('1');
  const [stockReason, setStockReason] = useState('');
  const [stockSaving, setStockSaving] = useState(false);
  const [opnameProduct, setOpnameProduct] = useState(null);
  const [opnameStock, setOpnameStock] = useState('');
  const [opnameReason, setOpnameReason] = useState('');
  const [opnameSaving, setOpnameSaving] = useState(false);
  const [historyProduct, setHistoryProduct] = useState(null);
  const [stockMovements, setStockMovements] = useState([]);
  const [historyPagination, setHistoryPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteProduct, setDeleteProduct] = useState(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [productStatus, setProductStatus] = useState('active');
  const [restoreProduct, setRestoreProduct] = useState(null);
  const [restoreSaving, setRestoreSaving] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', barcode: '', price: '', cost_price: '', supplier_id: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [showBarcodePrintDialog, setShowBarcodePrintDialog] = useState(false);
  const [barcodePrintSearch, setBarcodePrintSearch] = useState('');
  const [selectedBarcodeProducts, setSelectedBarcodeProducts] = useState([]);
  const [barcodePrintQuantities, setBarcodePrintQuantities] = useState({});
  
  const visibleProducts = filterAndSortProducts(products, searchQuery);
  const barcodePrintProducts = products.filter((product) => String(product.barcode || '').trim());
  const filteredBarcodePrintProducts = barcodePrintProducts.filter((product) => {
    const query = barcodePrintSearch.trim().toLocaleLowerCase('id-ID');
    if (!query) return true;
    return `${product.name || ''} ${product.barcode || ''}`.toLocaleLowerCase('id-ID').includes(query);
  });

  const fetchProducts = useCallback(async (status = productStatus) => {
    try {
      const res = await api.get(`/products?status=${status === 'archived' ? 'archived' : 'active'}`);
      setProducts([...res.data].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id', { sensitivity: 'base' })));
    } catch {
      toast.error('Gagal memuat daftar produk');
    }
  }, [productStatus]);

  const fetchSuppliers = useCallback(async () => {
    try {
      const response = await api.get('/suppliers', { params: { page: 1, page_size: 100 } });
      setSuppliers(response.data?.items || []);
    } catch {
      setSuppliers([]);
    }
  }, []);

  useEffect(() => {
    fetchProducts(productStatus);
    fetchSuppliers();
  }, [fetchProducts, fetchSuppliers, productStatus]);

  useEffect(() => {
    const socketUrl = window.location.protocol === 'https:'
      ? window.location.origin
      : `http://${window.location.hostname || 'localhost'}:3001`;
    const socket = io(socketUrl, {
      auth: {
        role: 'pos',
        channel: getScannerChannel(),
        storeId: user?.storeId,
        sessionToken: sessionStorage.getItem('znnpos_auth_token')
      }
    });
    socket.on('database_changed', ({ table }) => {
      if (table === 'products') fetchProducts();
    });
    return () => socket.disconnect();
  }, [fetchProducts, user?.storeId]);

  useEffect(() => {
    if (!productScanRequest?.barcode) return;
    if (!canManageProducts) {
      toast.error('Role Kasir tidak dapat menambahkan produk baru');
      onProductScanHandled?.();
      return;
    }

    setProductStatus('active');
    setShowAddForm(true);
    setBarcode(productScanRequest.barcode);
    stopScanner();
    onProductScanHandled?.();
  }, [productScanRequest, onProductScanHandled, canManageProducts]);

  const startScanner = () => {
    setIsScanning(true);
  };

  const stopScanner = () => {
    setIsScanning(false);
  };

  const handleProductBarcodeScan = (decodedText) => {
    setBarcode(decodedText);
    setIsScanning(false);
    toast.success('Barcode berhasil terbaca!');
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    if (!name || !price || !stock) {
      toast.error('Mohon isi Nama, Harga, dan Stok!');
      return;
    }

    try {
      const newProduct = {
        name,
        price: parseFloat(price),
        cost_price: parseFloat(costPrice || 0),
        stock: parseInt(stock),
        barcode: barcode || null
      };

      await api.post('/products', newProduct);
      toast.success('Sukses menambahkan ' + name + '!');
      
      setName('');
      setPrice('');
      setCostPrice('');
      setStock('');
      setBarcode('');
      setShowAddForm(false);
      stopScanner();
      fetchProducts();
    } catch {
      toast.error('Gagal menambahkan produk baru');
    }
  };

  const openStockEditor = (product) => {
    setStockProduct(product);
    setStockAction('add');
    setStockAmount('1');
    setStockReason('');
  };

  const closeStockEditor = () => {
    if (stockSaving) return;
    setStockProduct(null);
  };

  const handleStockUpdate = async (event) => {
    event.preventDefault();
    if (!stockProduct || !stockAmount) {
      toast.error('Masukkan jumlah stok');
      return;
    }
    setStockSaving(true);
    try {
      const response = await api.patch(`/products/${stockProduct.id}/stock`, {
        action: stockAction,
        amount: Number(stockAmount),
        reason: stockReason
      });
      setProducts((current) => current.map((product) => product.id === stockProduct.id ? { ...product, stock: response.data.stock } : product));
      toast.success(`Stok ${stockProduct.name} sekarang ${formatNumber(response.data.stock)}`);
      setStockProduct(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal mengubah stok');
    } finally {
      setStockSaving(false);
    }
  };

  const openStockOpname = (product) => {
    setOpnameProduct(product);
    setOpnameStock(String(product.stock ?? 0));
    setOpnameReason('');
  };

  const closeStockOpname = () => {
    if (opnameSaving) return;
    setOpnameProduct(null);
  };

  const handleStockOpname = async (event) => {
    event.preventDefault();
    if (!opnameProduct || opnameStock === '') {
      toast.error('Masukkan jumlah stok fisik');
      return;
    }
    setOpnameSaving(true);
    try {
      const response = await api.patch(`/products/${opnameProduct.id}/stock-opname`, {
        counted_stock: Number(opnameStock),
        reason: opnameReason
      });
      setProducts((current) => current.map((product) => product.id === opnameProduct.id ? { ...product, stock: response.data.stock } : product));
      toast.success(`Stok opname ${opnameProduct.name} tersimpan: ${formatNumber(response.data.stock)}`);
      setOpnameProduct(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menyimpan stok opname');
    } finally {
      setOpnameSaving(false);
    }
  };

  const openStockHistory = async (product, page = 1) => {
    setHistoryProduct(product);
    setHistoryLoading(true);
    try {
      const response = await api.get(`/products/${product.id}/stock-movements`, { params: { page, page_size: 20 } });
      setStockMovements(response.data.items || []);
      setHistoryPagination(response.data.pagination || { page, pageSize: 20, total: 0, totalPages: 0 });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memuat riwayat stok');
    } finally {
      setHistoryLoading(false);
    }
  };

  const closeStockHistory = () => {
    if (!historyLoading) setHistoryProduct(null);
  };

  const movementLabel = (type) => ({
    initial: 'Stok awal',
    sale: 'Penjualan',
    stock_add: 'Tambah stok',
    stock_subtract: 'Kurangi stok',
    stock_set: 'Atur total stok',
    return: 'Retur',
    opname: 'Stok opname',
    adjustment: 'Penyesuaian'
  }[type] || type);

  const openDeleteConfirm = (product) => {
    setDeleteProduct(product);
  };

  const openEditProduct = (product) => {
    setEditProduct(product);
    setEditForm({ name: product.name || '', barcode: product.barcode || '', price: product.price ?? '', cost_price: product.cost_price ?? 0, supplier_id: product.supplier_id ?? '' });
  };

  const handleEditProduct = async (event) => {
    event.preventDefault();
    if (!editProduct || !editForm.name || !editForm.barcode) {
      toast.error('Lengkapi data produk');
      return;
    }
    setEditSaving(true);
    try {
      const response = await api.patch(`/products/${editProduct.id}`, {
        ...editForm,
        price: Number(editForm.price),
        cost_price: Number(editForm.cost_price || 0),
        supplier_id: editForm.supplier_id ? Number(editForm.supplier_id) : null
      });
      setProducts((current) => [...current.map((product) => product.id === editProduct.id ? { ...product, ...response.data.product } : product)].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id', { sensitivity: 'base' })));
      toast.success(`${editForm.name} berhasil diperbarui`);
      setEditProduct(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memperbarui produk');
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteProduct = async (event) => {
    event.preventDefault();
    if (!deleteProduct) {
      toast.error('Produk belum dipilih');
      return;
    }
    setDeleteSaving(true);
    try {
      const response = await api.delete(productStatus === 'archived' ? `/products/${deleteProduct.id}/permanent` : `/products/${deleteProduct.id}`);
      setProducts((current) => current.filter((product) => product.id !== deleteProduct.id));
      toast.success(response.data.archived ? `${deleteProduct.name} dipindahkan ke arsip` : `${deleteProduct.name} berhasil dihapus`);
      setDeleteProduct(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal menghapus produk');
    } finally {
      setDeleteSaving(false);
    }
  };

  const handleRestoreProduct = async (event) => {
    event.preventDefault();
    if (!restoreProduct) {
      toast.error('Produk belum dipilih');
      return;
    }
    setRestoreSaving(true);
    try {
      await api.post(`/products/${restoreProduct.id}/restore`);
      setProducts((current) => current.filter((product) => product.id !== restoreProduct.id));
      toast.success(`${restoreProduct.name} dipulihkan ke daftar aktif`);
      setRestoreProduct(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Gagal memulihkan produk');
    } finally {
      setRestoreSaving(false);
    }
  };

  const openBarcodePrintDialog = () => {
    setBarcodePrintSearch('');
    setSelectedBarcodeProducts([]);
    setBarcodePrintQuantities({});
    setShowBarcodePrintDialog(true);
  };

  const toggleBarcodeProduct = (productId) => {
    const normalizedId = String(productId);
    setSelectedBarcodeProducts((current) => current.includes(normalizedId)
      ? current.filter((id) => id !== normalizedId)
      : [...current, normalizedId]);
  };

  const toggleVisibleBarcodeProducts = () => {
    const visibleIds = filteredBarcodePrintProducts.map((product) => String(product.id));
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedBarcodeProducts.includes(id));
    setSelectedBarcodeProducts((current) => allSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]);
  };

  const updateBarcodePrintQuantity = (productId, quantity) => {
    setBarcodePrintQuantities((current) => ({ ...current, [String(productId)]: quantity }));
  };

  const handlePrintSelectedBarcodes = () => {
    const productsToPrint = barcodePrintProducts.filter((product) => selectedBarcodeProducts.includes(String(product.id)));
    if (productsToPrint.length === 0) {
      toast.error('Pilih minimal satu produk untuk dicetak');
      return;
    }

    const invalidProduct = productsToPrint.find((product) => {
      const rawQuantity = barcodePrintQuantities[String(product.id)] ?? '1';
      const quantity = Number(rawQuantity);
      return rawQuantity === '' || !Number.isInteger(quantity) || quantity < 1 || quantity > 100;
    });
    if (invalidProduct) {
      toast.error(`Jumlah barcode ${invalidProduct.name} harus 1 sampai 100`);
      return;
    }

    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
    let savedSettings = {};
    try {
      savedSettings = JSON.parse(localStorage.getItem('pos_settings') || '{}');
    } catch {
      savedSettings = {};
    }
    const storeName = user?.storeName || (/^znnpos$/i.test(savedSettings.storeName || '') ? 'Toko Utama' : savedSettings.storeName || 'Toko Utama');

    const labels = productsToPrint.flatMap((product) => {
      const quantity = Number(barcodePrintQuantities[String(product.id)] ?? '1');
      const barcodeValue = escapeHtml(product.barcode);
      const barcodeTextForFont = `*${barcodeValue}*`;
      const productName = escapeHtml(product.name || 'Produk');
      return Array.from({ length: quantity }, () => `
        <div class="label-box">
          <div class="product-name">${productName}</div>
          <div class="barcode-lines">${barcodeTextForFont}</div>
          <div class="barcode-text">${barcodeValue}</div>
        </div>
      `);
    }).join('');

    const htmlContent = `<!DOCTYPE html>
      <html><head><title>Cetak Barcode</title>
      <link href="https://fonts.googleapis.com/css2?family=Libre+Barcode+39&display=swap" rel="stylesheet">
      <style>
        @page { size: A4 portrait; margin: 8mm; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: Arial, sans-serif; color: #000; }
        .print-header { text-align: center; margin-bottom: 5mm; }
        .print-header strong { display: block; font-size: 15px; }
        .print-header span { display: block; margin-top: 1mm; font-size: 12px; font-weight: 700; }
        .label-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 4mm;
          align-items: start;
        }
        .label-box {
          width: 100%;
          height: 30mm;
          border: 1px solid #000;
          padding: 3mm 2mm;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          break-inside: avoid;
        }
        .product-name {
          max-width: 100%;
          margin-bottom: 1mm;
          overflow: hidden;
          font-size: 9px;
          font-weight: 700;
          text-align: center;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .barcode-lines {
          font-family: "Libre Barcode 39", monospace;
          font-size: 34px;
          line-height: 0.9;
          white-space: nowrap;
        }
        .barcode-text {
          margin-top: 1mm;
          font-size: 10px;
          letter-spacing: 1px;
        }
        @media print { .label-box { border-color: #000; } }
      </style></head>
      <body><div class="print-header"><strong>ZnnCashier</strong><span>${escapeHtml(storeName)}</span></div><div class="label-grid">${labels}</div>
      <script>
        window.onload = async function() {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          window.print();
        };
      </script></body></html>`;

    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      toast.error('Izinkan pop-up browser untuk mencetak barcode');
      return;
    }
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    setShowBarcodePrintDialog(false);
  };

  return (
    <div style={{ padding: '1rem', paddingBottom: '80px', color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.35rem', margin: 0 }}>Manajemen Produk</h2>
        {canManageProducts && (
          <button
            onClick={() => { setShowAddForm(!showAddForm); stopScanner(); }}
            style={{ alignSelf: 'flex-start', backgroundColor: '#3b82f6', color: '#fff', border: 'none', padding: '12px 16px', borderRadius: '8px', fontWeight: 'bold', fontSize: '14px' }}
          >
            {showAddForm ? 'Tutup Form' : '+ Tambah Produk'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
        <button type="button" onClick={() => { setProductStatus('active'); fetchProducts('active'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: productStatus === 'active' ? '#3b82f6' : 'var(--surface-opaque, #1a1a1a)', color: productStatus === 'active' ? '#fff' : 'var(--text-primary)', fontWeight: 'bold' }}>
          Aktif
        </button>
        <button type="button" onClick={() => { setProductStatus('archived'); fetchProducts('archived'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: productStatus === 'archived' ? '#64748b' : 'var(--surface-opaque, #1a1a1a)', color: productStatus === 'archived' ? '#fff' : 'var(--text-primary)', fontWeight: 'bold' }}>
          Diarsipkan
        </button>
        {productStatus === 'active' && barcodePrintProducts.length > 0 && (
          <button
            type="button"
            onClick={openBarcodePrintDialog}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'var(--primary-hover)', color: '#fff', border: 'none', padding: '10px 8px', borderRadius: '8px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
          >
            <Printer size={17} /> Cetak Barcode
          </button>
        )}
      </div>

      {showAddForm && (
        <div className="modal-overlay" onClick={() => { stopScanner(); setShowAddForm(false); }}>
          <form className="modal-content product-add-modal" onSubmit={handleAddProduct} onClick={(event) => event.stopPropagation()}>
            <div className="product-add-header">
              <div>
                <h2 className="modal-title" style={{ marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '8px' }}><PackagePlus size={22} color="var(--primary)" /> Tambah Produk</h2>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Isi data barang sebelum disimpan ke katalog toko.</p>
              </div>
              <button type="button" onClick={() => { stopScanner(); setShowAddForm(false); }} aria-label="Tutup penambahan produk" style={{ background: 'transparent', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px' }}><X size={21} /></button>
            </div>

            <div className="product-form-grid">
              <label className="input-label product-form-full">Nama Barang *<input className="modal-input" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Contoh: Kopi Susu" required autoFocus /></label>
              <label className="input-label">Harga Jual *<input className="modal-input" type="number" min="0" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="Contoh: 5.000" required /></label>
              <label className="input-label">Harga Modal<input className="modal-input" type="number" min="0" step="0.01" value={costPrice} onChange={e => setCostPrice(e.target.value)} placeholder="Contoh: 3.500" />{price && <small style={{ display: 'block', color: 'var(--primary)', marginTop: '5px', fontWeight: 500 }}>Untung kotor: Rp {formatNumber(Math.max(Number(price) - Number(costPrice || 0), 0))}</small>}</label>
              <label className="input-label">Jumlah Stok *<input className="modal-input" type="number" min="0" step="1" value={stock} onChange={e => setStock(e.target.value)} placeholder="Contoh: 50" required /></label>
              <label className="input-label product-form-full">Barcode (opsional)<span style={{ display: 'flex', gap: '8px' }}><input className="modal-input" type="text" value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Ketik manual atau scan" /><button type="button" onClick={isScanning ? stopScanner : startScanner} style={{ flex: '0 0 auto', backgroundColor: isScanning ? '#f43f5e' : '#3b82f6', color: '#fff', border: 'none', padding: '0 14px', borderRadius: 'var(--radius-md)', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}>{isScanning ? '🛑 Stop' : '📷 Scan'}</button></span></label>
            </div>

            <div className="product-add-footer">
              <button type="button" className="btn" onClick={() => { stopScanner(); setShowAddForm(false); }}>Batal</button>
              <button type="submit" className="btn btn-success" style={{ flex: 1 }}>Simpan Produk</button>
            </div>
          </form>
        </div>
      )}

      {showBarcodePrintDialog && (
        <div className="modal-overlay" onClick={() => setShowBarcodePrintDialog(false)}>
          <div className="modal-content" style={{ maxWidth: '680px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}><Printer size={21} /> Cetak Barcode</h2>
                <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Cari dan pilih satu atau beberapa produk untuk dicetak sekaligus.</p>
              </div>
              <button type="button" onClick={() => setShowBarcodePrintDialog(false)} style={{ color: 'var(--text-secondary)' }}><X size={22} /></button>
            </div>

            <input
              type="search"
              value={barcodePrintSearch}
              onChange={(event) => setBarcodePrintSearch(event.target.value)}
              placeholder="Cari nama produk atau barcode..."
              autoFocus
              style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'var(--surface-color)', color: 'var(--text-primary)', fontSize: '15px', marginBottom: '0.75rem' }}
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{formatNumber(selectedBarcodeProducts.length)} produk dipilih</span>
              <button type="button" onClick={toggleVisibleBarcodeProducts} style={{ border: 'none', background: 'transparent', color: '#60a5fa', cursor: 'pointer', fontWeight: '700' }}>
                {filteredBarcodePrintProducts.length > 0 && filteredBarcodePrintProducts.every((product) => selectedBarcodeProducts.includes(String(product.id))) ? 'Batalkan Semua' : 'Pilih Semua'}
              </button>
            </div>

            <div style={{ maxHeight: '42vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.45rem', padding: '0.25rem' }}>
              {filteredBarcodePrintProducts.length === 0 ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Produk dengan barcode tidak ditemukan.</div>
              ) : filteredBarcodePrintProducts.map((product) => {
                const productId = String(product.id);
                const selected = selectedBarcodeProducts.includes(productId);
                return (
                  <label key={product.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', border: `1px solid ${selected ? '#3b82f6' : 'var(--border-color)'}`, borderRadius: '8px', background: selected ? 'rgba(59, 130, 246, 0.12)' : 'var(--surface-color)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected} onChange={() => toggleBarcodeProduct(product.id)} style={{ width: '18px', height: '18px', accentColor: '#3b82f6' }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{product.name}</strong>
                      <small style={{ color: 'var(--text-secondary)' }}>Barcode: {product.barcode}</small>
                    </span>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      value={barcodePrintQuantities[productId] ?? '1'}
                      onChange={(event) => updateBarcodePrintQuantity(product.id, event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Jumlah cetak ${product.name}`}
                      title="Jumlah cetak produk ini"
                      style={{ width: '72px', padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--surface-opaque)', color: 'var(--text-primary)', fontWeight: '700', textAlign: 'center' }}
                    />
                  </label>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '1rem' }}>
              <button type="button" onClick={() => setShowBarcodePrintDialog(false)} className="btn" style={{ flex: 1 }}>Batal</button>
              <button type="button" onClick={handlePrintSelectedBarcodes} className="btn btn-primary" style={{ flex: 1 }} disabled={selectedBarcodeProducts.length === 0}>
                <Printer size={17} /> Cetak {formatNumber(selectedBarcodeProducts.length)} Produk
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h3 style={{ fontSize: '14px', color: '#888', margin: '0 0 0.5rem 0' }}>{productStatus === 'active' ? 'Produk Aktif' : 'Produk Diarsipkan'} ({visibleProducts.length} Barang)</h3>
        {visibleProducts.map(p => (
          <div key={p.id} style={{ padding: '12px', background: 'var(--surface-opaque, #1a1a1a)', borderRadius: '8px', border: '1px solid #292929', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            
            {/* BAGIAN ATAS: INFO PRODUK */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{p.name}</div>
                <div style={{ fontSize: '12px', color: '#888' }}>Barcode: {p.barcode || '-'}</div>
                {p.supplier_name && <div style={{ fontSize: '11px', color: '#888' }}>Supplier: {p.supplier_name}</div>}
                <div style={{ fontSize: '11px', color: '#888' }}>Modal: Rp {formatNumber(p.cost_price || 0)} · Untung: Rp {formatNumber(Math.max(Number(p.price) - Number(p.cost_price || 0), 0))}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 'bold', color: '#3b82f6', fontSize: '14px' }}>Rp {formatNumber(p.price)}</div>
                <div style={{ fontSize: '11px', color: p.stock < 5 ? '#f43f5e' : 'var(--primary)' }}>Stok: {formatNumber(p.stock)}</div>
              </div>
            </div>

            {/* AKSI PRODUK */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {productStatus === 'active' ? <>
                {canManageProducts && <>
                  <button onClick={() => openStockEditor(p)} style={{ flex: 1, backgroundColor: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.35)', padding: '8px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}><Lock size={15} /> Ubah Stok</button>
                  <button onClick={() => openStockOpname(p)} style={{ flex: 1, backgroundColor: 'rgba(59, 130, 246, 0.12)', color: 'var(--primary)', border: '1px solid rgba(59, 130, 246, 0.35)', padding: '8px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}><ClipboardCheck size={15} /> Opname</button>
                  <button onClick={() => openEditProduct(p)} aria-label={`Edit produk ${p.name}`} title="Edit produk" style={{ width: '42px', flexShrink: 0, backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.35)', padding: '8px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Pencil size={17} /></button>
                  <button onClick={() => openDeleteConfirm(p)} aria-label={`Hapus produk ${p.name}`} title="Hapus produk" style={{ width: '42px', flexShrink: 0, backgroundColor: 'rgba(244, 63, 94, 0.1)', color: '#f43f5e', border: '1px solid rgba(244, 63, 94, 0.35)', padding: '8px', borderRadius: '6px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={18} /></button>
                </>}
                <button onClick={() => openStockHistory(p)} style={{ flex: 1, backgroundColor: 'rgba(148, 163, 184, 0.12)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', padding: '8px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}><History size={15} /> Riwayat</button>
              </> : canManageProducts && <>
                <button onClick={() => setRestoreProduct(p)} style={{ flex: 1, background: 'var(--primary)', color: '#fff', border: 'none', padding: '9px', borderRadius: '6px', fontWeight: 'bold' }}>Pulihkan</button>
                <button onClick={() => openDeleteConfirm(p)} style={{ flex: 1, background: '#f43f5e', color: '#fff', border: 'none', padding: '9px', borderRadius: '6px', fontWeight: 'bold' }}>Hapus Permanen</button>
                <button onClick={() => openStockHistory(p)} style={{ flex: 1, backgroundColor: 'rgba(148, 163, 184, 0.12)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', padding: '8px', borderRadius: '6px', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}><History size={15} /> Riwayat</button>
              </>}
            </div>
          </div>
        ))}
        {visibleProducts.length === 0 && (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: '#888', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
            Produk tidak ditemukan.
          </div>
        )}
      </div>

      {stockProduct && (
        <div className="modal-overlay" onClick={closeStockEditor}>
          <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}><Lock size={20} /> Ubah Stok</h2>
              <button type="button" onClick={closeStockEditor} style={{ color: 'var(--text-secondary)' }}><X size={22} /></button>
            </div>
            <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)' }}>{stockProduct.name} · Stok saat ini: <strong>{formatNumber(stockProduct.stock)}</strong></p>
            <form onSubmit={handleStockUpdate} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                <button type="button" onClick={() => setStockAction('add')} style={{ padding: '10px 4px', borderRadius: '6px', background: stockAction === 'add' ? 'var(--primary)' : '#263238', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px' }}><Plus size={15} /> Tambah</button>
                <button type="button" onClick={() => setStockAction('subtract')} style={{ padding: '10px 4px', borderRadius: '6px', background: stockAction === 'subtract' ? '#f43f5e' : '#263238', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px' }}><Minus size={15} /> Kurangi</button>
                <button type="button" onClick={() => setStockAction('set')} style={{ padding: '10px 4px', borderRadius: '6px', background: stockAction === 'set' ? '#3b82f6' : '#263238', color: '#fff' }}>Atur Total</button>
              </div>
              <label className="input-label">Jumlah stok<input className="modal-input" type="number" min="0" step="1" value={stockAmount} onChange={(event) => setStockAmount(event.target.value)} /></label>
              <label className="input-label">Alasan perubahan (opsional)<textarea className="modal-input" rows="3" value={stockReason} onChange={(event) => setStockReason(event.target.value)} placeholder="Contoh: stok masuk dari supplier" maxLength={500} /></label>
              <button type="submit" disabled={stockSaving} className="btn btn-primary" style={{ width: '100%' }}>{stockSaving ? 'Menyimpan...' : 'Simpan Perubahan Stok'}</button>
            </form>
          </div>
        </div>
      )}

      {opnameProduct && (
        <div className="modal-overlay" onClick={closeStockOpname}>
          <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}><ClipboardCheck size={20} /> Stok Opname</h2>
              <button type="button" onClick={closeStockOpname} style={{ color: 'var(--text-secondary)' }}><X size={22} /></button>
            </div>
            <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)' }}>{opnameProduct.name} · Stok sistem: <strong>{formatNumber(opnameProduct.stock)}</strong></p>
            <form onSubmit={handleStockOpname} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <label className="input-label">Jumlah stok fisik<input className="modal-input" type="number" min="0" step="1" value={opnameStock} onChange={(event) => setOpnameStock(event.target.value)} autoFocus /></label>
              <label className="input-label">Keterangan (opsional)<textarea className="modal-input" rows="3" value={opnameReason} onChange={(event) => setOpnameReason(event.target.value)} placeholder="Contoh: hasil hitung gudang" maxLength={500} /></label>
                <div style={{ padding: '0.7rem', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                Selisih akan dihitung otomatis dan dicatat sebagai riwayat stok opname.
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={closeStockOpname} className="btn" style={{ flex: 1 }} disabled={opnameSaving}>Batal</button>
                <button type="submit" disabled={opnameSaving} className="btn btn-primary" style={{ flex: 1 }}>{opnameSaving ? 'Menyimpan...' : 'Simpan Opname'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {historyProduct && (
        <div className="modal-overlay" onClick={closeStockHistory}>
          <div className="modal-content" style={{ maxWidth: '680px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}><History size={20} /> Riwayat Stok</h2>
              <button type="button" onClick={closeStockHistory} style={{ color: 'var(--text-secondary)' }}><X size={22} /></button>
            </div>
            <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)' }}>{historyProduct.name} · Total catatan: {formatNumber(historyPagination.total)}</p>
            {historyLoading ? <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Memuat riwayat...</div> : stockMovements.length === 0 ? <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Belum ada riwayat stok.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                      <th style={{ padding: '0.6rem 0.4rem' }}>Waktu</th>
                      <th style={{ padding: '0.6rem 0.4rem' }}>Aktivitas</th>
                      <th style={{ padding: '0.6rem 0.4rem', textAlign: 'right' }}>Perubahan</th>
                      <th style={{ padding: '0.6rem 0.4rem', textAlign: 'right' }}>Stok</th>
                      <th style={{ padding: '0.6rem 0.4rem' }}>Pengguna</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockMovements.map((movement) => (
                      <tr key={movement.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={{ padding: '0.6rem 0.4rem', whiteSpace: 'nowrap' }}>{new Date(movement.created_at).toLocaleString('id-ID')}</td>
                        <td style={{ padding: '0.6rem 0.4rem' }}><div>{movementLabel(movement.movement_type)}</div><small style={{ color: 'var(--text-secondary)' }}>{movement.reason || '-'}</small></td>
                        <td style={{ padding: '0.6rem 0.4rem', textAlign: 'right', color: Number(movement.quantity_change) >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>{Number(movement.quantity_change) > 0 ? '+' : ''}{formatNumber(movement.quantity_change)}</td>
                        <td style={{ padding: '0.6rem 0.4rem', textAlign: 'right' }}>{formatNumber(movement.stock_before)} → {formatNumber(movement.stock_after)}</td>
                        <td style={{ padding: '0.6rem 0.4rem' }}>{movement.username || 'Sistem'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {historyPagination.totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', gap: '0.75rem' }}>
                <button type="button" className="btn" disabled={historyLoading || historyPagination.page <= 1} onClick={() => openStockHistory(historyProduct, historyPagination.page - 1)}>Sebelumnya</button>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Halaman {formatNumber(historyPagination.page)} / {formatNumber(historyPagination.totalPages)}</span>
                <button type="button" className="btn" disabled={historyLoading || historyPagination.page >= historyPagination.totalPages} onClick={() => openStockHistory(historyProduct, historyPagination.page + 1)}>Berikutnya</button>
              </div>
            )}
          </div>
        </div>
      )}

      {editProduct && (
        <div className="modal-overlay" onClick={() => !editSaving && setEditProduct(null)}>
          <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(event) => event.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: '8px' }}><Pencil size={20} /> Edit Produk</h2>
              <button type="button" onClick={() => setEditProduct(null)} style={{ color: 'var(--text-secondary)' }}><X size={22} /></button>
            </div>
            <form onSubmit={handleEditProduct} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <label className="input-label">Nama Produk<input className="modal-input" value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} required autoFocus /></label>
              <label className="input-label">Barcode<input className="modal-input" value={editForm.barcode} onChange={(event) => setEditForm({ ...editForm, barcode: event.target.value })} required /></label>
              <label className="input-label">Harga Jual<input className="modal-input" type="number" min="0" value={editForm.price} onChange={(event) => setEditForm({ ...editForm, price: event.target.value })} required /></label>
              <label className="input-label">Harga Modal<input className="modal-input" type="number" min="0" value={editForm.cost_price} onChange={(event) => setEditForm({ ...editForm, cost_price: event.target.value })} /></label>
              <label className="input-label">Supplier<select className="modal-input" value={editForm.supplier_id} onChange={(event) => setEditForm({ ...editForm, supplier_id: event.target.value })}><option value="">Tanpa supplier</option>{suppliers.filter((supplier) => Number(supplier.active) === 1).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={() => setEditProduct(null)} className="btn" style={{ flex: 1 }} disabled={editSaving}>Batal</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={editSaving}>{editSaving ? 'Menyimpan...' : 'Simpan Perubahan'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteProduct && (
        <div className="modal-overlay" onClick={() => !deleteSaving && setDeleteProduct(null)}>
          <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(event) => event.stopPropagation()}>
            <h2 style={{ marginTop: 0, color: '#f43f5e', display: 'flex', alignItems: 'center', gap: '8px' }}><Trash2 size={21} /> Hapus Produk</h2>
            <p style={{ color: 'var(--text-secondary)' }}>{productStatus === 'archived' ? <>Produk <strong>{deleteProduct.name}</strong> akan dihapus permanen dan tidak dapat dipulihkan.</> : <>Jika produk memiliki riwayat transaksi, produk akan otomatis dipindahkan ke arsip.</>}</p>
            <form onSubmit={handleDeleteProduct} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={() => setDeleteProduct(null)} className="btn" style={{ flex: 1 }} disabled={deleteSaving}>Batal</button>
                <button type="submit" className="btn" style={{ flex: 1, background: '#f43f5e', color: '#fff' }} disabled={deleteSaving}>{deleteSaving ? 'Memproses...' : productStatus === 'archived' ? 'Hapus Permanen' : 'Hapus'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {restoreProduct && (
        <div className="modal-overlay" onClick={() => !restoreSaving && setRestoreProduct(null)}>
          <div className="modal-content" style={{ maxWidth: '420px' }} onClick={(event) => event.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Pulihkan Produk</h2>
            <p style={{ color: 'var(--text-secondary)' }}>Pulihkan <strong>{restoreProduct.name}</strong> ke daftar aktif?</p>
            <form onSubmit={handleRestoreProduct} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={() => setRestoreProduct(null)} className="btn" style={{ flex: 1 }} disabled={restoreSaving}>Batal</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={restoreSaving}>{restoreSaving ? 'Memulihkan...' : 'Pulihkan'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isScanning && (
        <BarcodeScannerModal
          title="Scan Barcode Produk"
          description="Arahkan kamera belakang ke kode batang produk untuk mengisi barcode."
          onClose={stopScanner}
          onScan={handleProductBarcodeScan}
        />
      )}
    </div>
  );
}

export default Products;
