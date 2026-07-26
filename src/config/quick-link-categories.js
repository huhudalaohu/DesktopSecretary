export const QUICK_LINK_CATEGORIES_STORE_KEY = 'quickLinkCategories';
export const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';

export const DEFAULT_QUICK_LINK_CATEGORIES = Object.freeze([
  { id: 'work', name: '工作' },
  { id: 'tools', name: '工具' },
  { id: UNCATEGORIZED_CATEGORY_ID, name: '未分类', locked: true },
]);

export function normalizeQuickLinkCategories(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_QUICK_LINK_CATEGORIES.map((category) => ({ ...category }));
  }

  const seen = new Set();
  const categories = [];
  for (const category of value) {
    if (!category || typeof category !== 'object') continue;
    const id = typeof category.id === 'string' ? category.id.trim() : '';
    const name = typeof category.name === 'string' ? category.name.trim().slice(0, 12) : '';
    if (!id || !name || id === UNCATEGORIZED_CATEGORY_ID || seen.has(id)) continue;
    seen.add(id);
    categories.push({ id, name });
  }

  categories.push({ id: UNCATEGORIZED_CATEGORY_ID, name: '未分类', locked: true });
  return categories;
}
