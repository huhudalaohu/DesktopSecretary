import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_QUICK_LINK_CATEGORIES,
  QUICK_LINK_CATEGORIES_STORE_KEY,
  UNCATEGORIZED_CATEGORY_ID,
  normalizeQuickLinkCategories,
} from '../../../config/quick-link-categories';

const api = window.desktopAPI;

export default function QuickLinkCategorySettings() {
  const [categories, setCategories] = useState(DEFAULT_QUICK_LINK_CATEGORIES);
  const [newCategoryName, setNewCategoryName] = useState('');

  useEffect(() => {
    api.storeGet(QUICK_LINK_CATEGORIES_STORE_KEY, DEFAULT_QUICK_LINK_CATEGORIES).then((saved) => {
      setCategories(normalizeQuickLinkCategories(saved));
    });
  }, []);

  const saveCategories = async (next) => {
    const normalized = normalizeQuickLinkCategories(next);
    setCategories(normalized);
    await api.storeSet(QUICK_LINK_CATEGORIES_STORE_KEY, normalized);
    window.dispatchEvent(new CustomEvent('quick-link-categories-updated', { detail: normalized }));
  };

  const renameCategory = (id, name) => {
    setCategories((previous) => previous.map((category) => (
      category.id === id ? { ...category, name } : category
    )));
  };

  const finishRename = (id) => {
    const category = categories.find((item) => item.id === id);
    const name = category?.name?.trim();
    if (!name) {
      setCategories((previous) => previous.map((item) => (
        item.id === id ? { ...item, name: '未命名分类' } : item
      )));
      saveCategories(categories.map((item) => (
        item.id === id ? { ...item, name: '未命名分类' } : item
      )));
      return;
    }
    saveCategories(categories);
  };

  const addCategory = async (event) => {
    event.preventDefault();
    const name = newCategoryName.trim().slice(0, 12);
    if (!name || categories.some((category) => category.name === name)) return;

    const next = [
      ...categories.filter((category) => category.id !== UNCATEGORIZED_CATEGORY_ID),
      { id: `category-${Date.now()}`, name },
      ...categories.filter((category) => category.id === UNCATEGORIZED_CATEGORY_ID),
    ];
    setNewCategoryName('');
    await saveCategories(next);
  };

  const moveCategory = async (id, direction) => {
    const editable = categories.filter((category) => category.id !== UNCATEGORIZED_CATEGORY_ID);
    const index = editable.findIndex((category) => category.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= editable.length) return;

    const reordered = [...editable];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    await saveCategories([...reordered, ...categories.filter((category) => category.id === UNCATEGORIZED_CATEGORY_ID)]);
  };

  const deleteCategory = async (id) => {
    if (id === UNCATEGORIZED_CATEGORY_ID) return;
    const next = categories.filter((category) => category.id !== id);
    await saveCategories(next);

    const workspaces = await api.storeGet('workspaces', []);
    await Promise.all(workspaces.map(async (workspace) => {
      const storeKey = `quickLinks:${workspace.id}`;
      const groups = await api.storeGet(storeKey, {});
      const removed = groups?.[id];
      if (!removed) return;

      const uncategorized = groups[UNCATEGORIZED_CATEGORY_ID] || {
        expanded: true,
        links: [],
      };
      const { [id]: _removed, ...remaining } = groups;
      await api.storeSet(storeKey, {
        ...remaining,
        [UNCATEGORIZED_CATEGORY_ID]: {
          ...uncategorized,
          links: [...(uncategorized.links || []), ...(removed.links || [])],
        },
      });
    }));
  };

  const editableCategories = categories.filter((category) => category.id !== UNCATEGORIZED_CATEGORY_ID);

  return (
    <section className="card p-2.5 space-y-2">
      <h3 className="text-[10px] font-semibold text-fluent-text-secondary uppercase tracking-wider">链接流分类</h3>
      <div className="space-y-1">
        {editableCategories.map((category, index) => (
          <div key={category.id} className="flex items-center gap-1">
            <input
              value={category.name}
              maxLength={12}
              onChange={(event) => renameCategory(category.id, event.target.value)}
              onBlur={() => finishRename(category.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className="input min-w-0 flex-1 text-[10px]"
            />
            <button
              type="button"
              onClick={() => moveCategory(category.id, -1)}
              disabled={index === 0}
              title="上移分类"
              className="icon-btn disabled:opacity-30"
            >
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => moveCategory(category.id, 1)}
              disabled={index === editableCategories.length - 1}
              title="下移分类"
              className="icon-btn disabled:opacity-30"
            >
              <ArrowDown size={12} />
            </button>
            <button
              type="button"
              onClick={() => deleteCategory(category.id)}
              title="删除分类"
              className="icon-btn hover:text-fluent-danger"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1">
          <span className="flex-1 px-2 py-1 text-[10px] rounded-fluent bg-fluent-fill-hover border border-fluent-stroke-card text-fluent-text-tertiary">未分类</span>
        </div>
      </div>
      <form onSubmit={addCategory} className="flex gap-1 pt-1 border-t border-fluent-stroke-divider">
        <input
          value={newCategoryName}
          maxLength={12}
          onChange={(event) => setNewCategoryName(event.target.value)}
          placeholder="新分类"
          className="input min-w-0 flex-1 text-[10px]"
        />
        <button
          type="submit"
          title="添加分类"
          className="icon-btn hover:bg-fluent-accent-light hover:text-fluent-accent"
        >
          <Plus size={12} />
        </button>
      </form>
    </section>
  );
}
