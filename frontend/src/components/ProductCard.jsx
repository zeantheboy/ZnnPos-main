import { Plus, Package } from 'lucide-react';
import { formatNumber } from '../utils/numberFormat';

export default function ProductCard({ product, onClick }) {
  const currency = JSON.parse(localStorage.getItem('pos_settings') || '{}').currency || 'Rp';

  return (
    <div className="product-card" onClick={onClick}>
      <div className="product-image">
        {product.image ? (
          <img src={product.image} alt={product.name} style={{ width: '100%', height: '100%', objectFit: 'contain', padding: '1rem' }} />
        ) : (
          <Package size={48} color="var(--primary)" style={{ opacity: 0.5 }} />
        )}
        <div className="product-add-overlay">
          <Plus size={32} />
        </div>
      </div>
      <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <div className="product-title" style={{ marginTop: 0, lineHeight: '1.2' }}>{product.name}</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.2rem' }}>
          <div className="product-price">{currency}{formatNumber(product.price)}</div>
          <div style={{ 
            fontSize: '0.75rem', 
            fontWeight: '600',
            padding: '0.2rem 0.5rem',
            borderRadius: 'var(--radius-full)',
            backgroundColor: product.stock > 10 ? 'rgba(59, 130, 246, 0.1)' : 'rgba(244, 63, 94, 0.1)',
            color: product.stock > 10 ? 'var(--success)' : 'var(--danger)'
          }}>
            {formatNumber(product.stock || 0)} left
          </div>
        </div>
      </div>
    </div>
  );
}
