import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Toaster, toast } from 'react-hot-toast';
import { BarChart3, Package, ShoppingCart, Store, UsersRound } from 'lucide-react';
import api from './api';
import Sidebar from './components/Sidebar';
import Navbar from './components/Navbar';
import Cart from './components/Cart';
import ProductCard from './components/ProductCard';
import Products from './pages/Products';
import Dashboard from './pages/Dashboard';
import Contacts from './pages/Contacts';
import Settings from './pages/Settings';
import LoginPage from './pages/LoginPage';
import Users from './pages/Users';
import Stores from './pages/Stores';
import { AuthProvider } from './auth/AuthContext';
import { useAuth } from './auth/useAuth';
import { filterAndSortProducts } from './utils/productSearch';
import { formatNumber } from './utils/numberFormat';
import { getScannerChannel } from './utils/scannerSession';
import './App.css';

// Navigasi bawah HP mengikuti hak akses akun yang sedang login.
function MobileBottomNav() {
  const location = useLocation();
  const { user } = useAuth();
  return (
    <nav className="mobile-bottom-nav">
      <Link to="/" className={`nav-item ${location.pathname === '/' ? 'active' : ''}`}>
        <ShoppingCart className="nav-icon" size={20} />
        <span>Kasir</span>
      </Link>
      <Link to="/products" className={`nav-item ${location.pathname === '/products' ? 'active' : ''}`}>
        <Package className="nav-icon" size={20} />
        <span>Produk</span>
      </Link>
      {user?.role !== 'cashier' && (
        <Link to="/dashboard" className={`nav-item ${location.pathname === '/dashboard' ? 'active' : ''}`}>
          <BarChart3 className="nav-icon" size={20} />
          <span>Analisis</span>
        </Link>
      )}
      {user?.role === 'super_admin' && (
        <Link to="/stores" className={`nav-item ${location.pathname === '/stores' ? 'active' : ''}`}>
          <Store className="nav-icon" size={20} />
          <span>Toko</span>
        </Link>
      )}
      {user?.role === 'super_admin' && (
        <Link to="/users" className={`nav-item ${location.pathname === '/users' ? 'active' : ''}`}>
          <UsersRound className="nav-icon" size={20} />
          <span>Pengguna</span>
        </Link>
      )}
    </nav>
  );
}

function AppContent() {
  const { user } = useAuth();
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  const [cartItems, setCartItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [productScanRequest, setProductScanRequest] = useState(null);
  const [showMobileCart, setShowMobileCart] = useState(false);
  const [currentShift, setCurrentShift] = useState(null);
  const [heldTransactionCount, setHeldTransactionCount] = useState(0);
  const [heldTransactionsOpenRequest, setHeldTransactionsOpenRequest] = useState(0);
  const location = useLocation();

  const refreshHeldTransactionCount = useCallback(async () => {
    try {
      const response = await api.get('/held-transactions');
      setHeldTransactionCount(Array.isArray(response.data) ? response.data.length : 0);
    } catch {
      setHeldTransactionCount(0);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    api.get('/held-transactions')
      .then((response) => {
        if (mounted) setHeldTransactionCount(Array.isArray(response.data) ? response.data.length : 0);
      })
      .catch(() => {
        if (mounted) setHeldTransactionCount(0);
      });
    return () => { mounted = false; };
  }, []);

  const openHeldTransactions = () => {
    if (window.innerWidth <= 768) setShowMobileCart(true);
    setHeldTransactionsOpenRequest((request) => request + 1);
  };

  const fetchProducts = useCallback(async () => {
    try {
      const res = await api.get('/products');
      setProducts(res.data);
    } catch {
      toast.error('Failed to load products from database');
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { fetchProducts(); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchProducts]);

  const addToCart = useCallback((product) => {
    setCartItems(prev => {
      const existing = prev.find(item => item.id === product.id);
      if (existing) {
        return prev.map(item => item.id === product.id ? { ...item, qty: item.qty + 1 } : item);
      }
      return [...prev, { ...product, qty: 1 }];
    });
    toast.success(`${product.name} dimasukkan ke keranjang`);
  }, []);

  // Fungsi untuk menambah item custom
  const handleAddFlexibleCustomItem = useCallback(() => {
    // Meminta nama item
    const itemName = prompt('Masukkan nama item/jasa:', 'Item Lainnya');
    if (itemName === null) return; // Jika dibatalkan

    // Meminta harga
    const itemPrice = prompt('Masukkan nominal harga:', '5000');
    if (itemPrice === null) return; // Jika dibatalkan

    // Validasi harga
    const price = parseFloat(itemPrice);
    if (isNaN(price) || price <= 0) {
      toast.error('Harga harus berupa angka dan lebih besar dari 0');
      return;
    }

    // Membuat objek produk kustom
    const customProduct = {
      id: `custom-${Date.now()}`,
      name: itemName,
      price: price,
      isCustom: true
    };

    // Menambahkan ke keranjang
    addToCart(customProduct);
  }, [addToCart]);

  const handleProductBarcodeScan = useCallback(async (barcode) => {
    const normalizedBarcode = String(barcode || '').trim();
    if (!normalizedBarcode) return;

    try {
      await api.get(`/products/${normalizedBarcode}`);
      setSearchQuery(normalizedBarcode);
      toast.success('Produk ditemukan dan ditampilkan');
    } catch (err) {
      if (err.response && err.response.status === 404) {
        setSearchQuery('');
        setProductScanRequest({ barcode: normalizedBarcode, requestId: Date.now() });
        toast(`Barcode baru ${normalizedBarcode}. Form tambah produk dibuka.`, { icon: '➕' });
      } else {
        toast.error('Gagal memeriksa barcode produk');
      }
    }
  }, []);

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
    socket.on('pos_barcode', async (data) => {
      const scannedBarcode = String(data?.barcode || '').trim();
      if (!scannedBarcode) return;

      if (location.pathname === '/products') {
        await handleProductBarcodeScan(scannedBarcode);
        return;
      }

      try {
        const res = await api.get(`/products/${scannedBarcode}`);
        addToCart(res.data);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          setSearchQuery(scannedBarcode);
          toast(`Produk dengan barcode ${scannedBarcode} tidak ditemukan`, { icon: '🔍' });
        } else {
          console.error('Error fetching product data:', err);
          toast.error('Error reading barcode');
        }
      }
    });
    socket.on('database_changed', ({ table }) => {
      if (table === 'products') fetchProducts();
    });
    return () => socket.disconnect();
  }, [addToCart, fetchProducts, handleProductBarcodeScan, location.pathname, user?.storeId]);

  const handleManualBarcode = async (barcode) => {
    const normalizedBarcode = String(barcode || '').trim();
    if (!normalizedBarcode) return;

    try {
      const res = await api.get(`/products/${normalizedBarcode}`);
      addToCart(res.data);
      setSearchQuery('');
    } catch (err) {
      if (err.response && err.response.status === 404) {
        setSearchQuery(normalizedBarcode);
        toast(`Produk dengan barcode ${normalizedBarcode} tidak ditemukan`, { icon: '🔍' });
      } else {
        toast.error('Error finding product');
      }
    }
  };

  const clearProductScanRequest = useCallback(() => {
    setProductScanRequest(null);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const filteredProducts = filterAndSortProducts(products, searchQuery);
  const handleNavbarSearch = location.pathname === '/products'
    ? (query) => setSearchQuery(query)
    : handleManualBarcode;
  const handleNavbarBarcodeScanned = location.pathname === '/products'
    ? handleProductBarcodeScan
    : handleManualBarcode;

  const totalItems = cartItems.reduce((acc, item) => acc + item.qty, 0);

  return (
    <div className="app-container">
      <Toaster position="top-right" toastOptions={{
        style: {
          background: 'var(--surface-opaque)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)'
        }
      }} />
      <Sidebar />
      <div className="main-content mobile-content-padding">
        <Navbar theme={theme} toggleTheme={toggleTheme} searchQuery={searchQuery} setSearchQuery={setSearchQuery} onSearchEnter={handleNavbarSearch} onBarcodeScanned={handleNavbarBarcodeScanned} currentShift={currentShift} onShiftChange={setCurrentShift} cartHasItems={cartItems.length > 0} />
        <div className="content-area">
          <Routes>
            <Route path="/" element={
              <>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '1rem', overflow: 'hidden' }}>
                  
                  
                  <div className="pos-grid" style={{ overflowY: 'auto', paddingRight: '0.5rem', paddingBottom: '100px' }}>
  
  {/* Kartu Khusus Item Lainnya (Posisi Paling Pertama) */}
  <div 
    onClick={handleAddFlexibleCustomItem}
    className="product-card custom-item-card"
    style={{
      cursor: 'pointer',
      border: '2px dashed var(--primary-color, #3b82f6)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justify: 'center',
      borderRadius: '12px',
      padding: '1rem',
      background: 'rgba(59, 130, 246, 0.05)',
      transition: 'all 0.2s ease',
      minHeight: '140px'
    }}
  >
    <div style={{ fontSize: '36px', marginBottom: '8px' }}>➕</div>
    <div style={{ fontWeight: 'bold', fontSize: '14px', textAlign: 'center', color: 'var(--text-primary)' }}>
      Item Lainnya
    </div>
    <div style={{ fontSize: '11px', color: '#3b82f6', marginTop: '4px', fontWeight: '500' }}>
      (Custom / Nominal)
    </div>
  </div>

  {/* Daftar Produk Asli dari Database */}
  {filteredProducts.map(p => (
    <ProductCard key={p.id} product={p} onClick={() => addToCart(p)} />
  ))}
  
  {filteredProducts.length === 0 && (
    <div style={{ padding: '2rem', color: 'var(--text-secondary)', gridColumn: '1 / -1', textAlign: 'center' }}>
      No products found.
    </div>
  )}
</div>
                </div>
                
                <div className="desktop-cart-wrapper">
                  <Cart
                    items={cartItems}
                    setItems={setCartItems}
                    currentShift={currentShift}
                    heldTransactionsOpenRequest={heldTransactionsOpenRequest}
                    onHeldTransactionsChanged={refreshHeldTransactionCount}
                  />
                </div>

                {showMobileCart && (
                  <div className="mobile-cart-popup-overlay" onClick={() => setShowMobileCart(false)}>
                    <div className="mobile-cart-popup-content" onClick={e => e.stopPropagation()}>
                      <Cart
                        items={cartItems}
                        setItems={setCartItems}
                        currentShift={currentShift}
                        heldTransactionsOpenRequest={heldTransactionsOpenRequest}
                        onHeldTransactionsChanged={refreshHeldTransactionCount}
                        isMobilePopup
                        onClose={() => setShowMobileCart(false)}
                      />
                    </div>
                  </div>
                )}

                {totalItems > 0 && location.pathname === '/' && (
                  <div className="mobile-floating-checkout-bar" onClick={() => setShowMobileCart(true)}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '11px', color: '#cbd5e1' }}>Total Belanja ({formatNumber(totalItems)} Item)</span>
                      <span style={{ fontSize: '15px', fontWeight: 'bold', color: '#fff' }}>
                        Rp {formatNumber(cartItems.reduce((acc, item) => acc + (item.price * item.qty), 0))}
                      </span>
                    </div>
                    <button className="mobile-view-cart-btn">
                      Lihat Keranjang & Bayar ➔
                    </button>
                  </div>
                )}

              </>
            } />
            <Route path="/products" element={<Products searchQuery={searchQuery} productScanRequest={productScanRequest} onProductScanHandled={clearProductScanRequest} />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/users" element={<Users />} />
            <Route path="/stores" element={<Stores />} />
          </Routes>
        </div>
      </div>

      {heldTransactionCount > 0 && location.pathname === '/' && (
        <button
          type="button"
          className="pending-transactions-fab"
          onClick={openHeldTransactions}
          aria-label={`Buka ${formatNumber(heldTransactionCount)} transaksi tertunda`}
          title="Transaksi tertunda"
        >
          <ShoppingCart size={22} strokeWidth={2.4} />
          <span className="pending-transactions-label">Tertunda</span>
          <span className="pending-transactions-badge">{formatNumber(heldTransactionCount)}</span>
        </button>
      )}

      <MobileBottomNav />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AuthenticatedApp />
      </Router>
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const { user, authMode, loading } = useAuth();

  if (loading || authMode === 'loading') {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>Memeriksa sesi...</div>;
  }
  if (!user) return <LoginPage mode={authMode} />;
  return <AppContent />;
}

export default App;
