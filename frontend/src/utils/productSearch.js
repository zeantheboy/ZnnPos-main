const normalizeSearchValue = (value) => String(value ?? '').trim().toLocaleLowerCase('id-ID');

export function filterAndSortProducts(products = [], query = '') {
  const normalizedQuery = normalizeSearchValue(query);

  return [...products]
    .filter((product) => {
      if (!normalizedQuery) return true;

      const productName = normalizeSearchValue(product?.name);
      const productBarcode = normalizeSearchValue(product?.barcode);

      return productName.includes(normalizedQuery) || productBarcode.includes(normalizedQuery);
    })
    .sort((a, b) => normalizeSearchValue(a?.name).localeCompare(normalizeSearchValue(b?.name), 'id', { sensitivity: 'base' }));
}
