import { ShoppingCart, Package, BarChart3, Settings, UserCog, LogOut, UsersRound } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

export default function Sidebar() {
  const { user, logout } = useAuth();
  const roleLabel = user?.role === 'super_admin' ? 'Super Admin' : user?.role === 'admin' ? 'Admin Toko' : 'Kasir';

  return (
    <div className="sidebar">
      <div style={{ color: 'var(--primary)', padding: '10px' }}>
        <ShoppingCart size={32} />
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
        <NavLink to="/" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
          <ShoppingCart size={24} />
          <span>Kasir</span>
        </NavLink>
        <NavLink to="/products" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
          <Package size={24} />
          <span>Produk</span>
        </NavLink>
        <NavLink to="/contacts" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
          <UsersRound size={24} />
          <span>Kontak</span>
        </NavLink>
        {user?.role !== 'cashier' && (
          <NavLink to="/dashboard" className={({isActive}) => isActive ? "nav-item active" : "nav-item"}>
            <BarChart3 size={24} />
            <span>Analisis</span>
          </NavLink>
        )}
      </div>

      <div style={{ marginTop: 'auto', marginBottom: '1rem', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {user?.role === 'super_admin' && (
            <NavLink to="/stores" className={({isActive}) => isActive ? "nav-item active" : "nav-item"} style={{ width: '80%' }}>
              <span>Toko</span>
            </NavLink>
        )}
        {user?.role === 'super_admin' && (
          <>
            <NavLink to="/users" className={({isActive}) => isActive ? "nav-item active" : "nav-item"} style={{ width: '80%' }}>
              <UserCog size={24} />
              <span>Pengguna</span>
            </NavLink>
            <NavLink to="/settings" className={({isActive}) => isActive ? "nav-item active" : "nav-item"} style={{ width: '80%' }}>
              <Settings size={24} />
              <span>Pengaturan</span>
            </NavLink>
          </>
        )}
        <div style={{ width: '80%', marginTop: '0.5rem', padding: '0.65rem 0.4rem', borderTop: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontSize: '0.72rem', textAlign: 'center' }}>
          <div style={{ fontWeight: '700', color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.storeName || 'Toko Utama'}</div>
          <div style={{ marginBottom: '0.35rem' }}>Kode: {user?.storeCode || 'utama'}</div>
          <div style={{ fontWeight: '700', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.username}</div>
          <div>{roleLabel}</div>
          <button type="button" onClick={logout} style={{ width: '100%', marginTop: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.45rem', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <LogOut size={15} /> Keluar
          </button>
        </div>
      </div>
    </div>
  );
}
