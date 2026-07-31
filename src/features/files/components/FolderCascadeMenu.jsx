/**
 * FolderCascadeMenu.jsx — 文件夹多级级联浏览弹窗
 *
 * 文件流悬停文件夹时弹出第 1 层内容;菜单内部点击驱动:点击最深栏
 * 文件夹向右展开下一层(层数不限),点击父栏收回右侧层级;
 * 双击任意条目调用系统打开;Esc 或鼠标移出关闭。
 * 单击先高亮、结构动作延迟 500ms(对齐系统双击间隔),双击优先,
 * 避免快慢双击被误判成两次单击。
 *
 * 定位注意:anchorRect 必须来自 measureVisualRect(zoom 容器内
 * getBoundingClientRect 不可靠,见 src/utils/measureVisualRect.js)。
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Loader2 } from 'lucide-react';
import FileTypeIcon from './FileTypeIcon';

const api = window.desktopAPI;

const COL_W = 184;      // 每栏宽度
const COL_MAX_H = 320;  // 栏最大高度(超出滚动)

export default function FolderCascadeMenu({ anchorRect, rootPath, onOpen, onHoverChange, onRequestClose }) {
  // levels: [{ path, entries, loading, error }],levels[0] 为悬停文件夹的内容
  const [levels, setLevels] = useState([{ path: rootPath, entries: null, loading: true, error: null }]);
  const [selected, setSelected] = useState([]); // 每栏当前选中的条目名(高亮用)
  const cacheRef = useRef(new Map());

  const loadDir = useCallback(async (dirPath) => {
    if (cacheRef.current.has(dirPath)) return cacheRef.current.get(dirPath);
    const res = await api.listDir(dirPath);
    cacheRef.current.set(dirPath, res);
    return res;
  }, []);

  // 首层加载(rootPath 变化即重开)
  useEffect(() => {
    let cancelled = false;
    setLevels([{ path: rootPath, entries: null, loading: true, error: null }]);
    setSelected([]);
    loadDir(rootPath).then((res) => {
      if (cancelled) return;
      setLevels([{ path: rootPath, entries: res.entries || [], loading: false, error: res.error || null }]);
    });
    return () => { cancelled = true; };
  }, [rootPath, loadDir]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onRequestClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onRequestClose]);

  // 单击文件夹:截掉右侧栏,在其右展开新一层
  const handleClickFolder = async (levelIndex, entry) => {
    cancelExit(); // 有栏在退场时直接落定,避免层级索引错位
    setSelected((s) => { const n = s.slice(0, levelIndex); n[levelIndex] = entry.name; return n; });
    const base = levels.slice(0, levelIndex + 1);
    setLevels([...base, { path: entry.path, entries: null, loading: true, error: null }]);
    const res = await loadDir(entry.path);
    setLevels((cur) => {
      // 加载期间用户可能又点了别的栏,只有路径仍匹配才写入
      if (cur[levelIndex + 1]?.path !== entry.path) return cur;
      const copy = cur.slice();
      copy[levelIndex + 1] = { path: entry.path, entries: res.entries || [], loading: false, error: res.error || null };
      return copy;
    });
  };

  // ---- 点击展开/返回 ----
  // 菜单由悬停快捷方式弹出,但菜单内部全部点击驱动:
  //   - 点击最深栏的文件夹 = 展开下一级
  //   - 点击父栏中已展开的行 = 收回到本层;点击父栏其他文件夹 = 切换到该分支
  //   - 点击父栏的文件行 = 收起右侧层级;点击最深栏文件行 = 无操作
  // 退场动画:返回时不直接移除栏,先把尾部栏宽度/透明度收到 0,动画结束再真正移除
  const [exiting, setExiting] = useState(0); // 尾部正在退场的栏数
  const exitTimerRef = useRef(null);

  const cancelExit = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
      setExiting(0);
    }
  };

  const collapseAfter = (levelIndex) => {
    cancelExit();
    if (levels.length <= levelIndex + 1) return;
    setSelected((s) => s.slice(0, levelIndex));
    setExiting(levels.length - (levelIndex + 1));
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setLevels((cur) => cur.slice(0, levelIndex + 1));
      setExiting(0);
    }, 180);
  };

  // 单击延迟执行,给双击留出判定窗口:双击间隔内出现第二击(双击打开)
  // 就取消单击的跳层/收起动作,避免「双击不够快被当成两次单击」。
  // 点击立刻给选中高亮作即时反馈,结构动作延迟 500ms(对齐 Windows 默认双击间隔)。
  const clickTimerRef = useRef(null);
  useEffect(() => () => { if (clickTimerRef.current) clearTimeout(clickTimerRef.current); }, []);

  const handleRowClick = (levelIndex, entry) => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    // 即时反馈:先只更新高亮,不动层级
    setSelected((s) => { const n = s.slice(0, levelIndex); n[levelIndex] = entry.name; return n; });
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      const isDeepest = levelIndex === levels.length - 1;
      if (!entry.isDirectory) {
        if (!isDeepest) collapseAfter(levelIndex); // 父栏文件行:收起右侧层级
        return;
      }
      const isExpanded = levels[levelIndex + 1]?.path === entry.path;
      if (!isDeepest && isExpanded) {
        collapseAfter(levelIndex); // 点击父栏已展开的行:返回本层
        return;
      }
      handleClickFolder(levelIndex, entry); // 最深栏进入下一级 / 父栏切换分支
    }, 500);
  };

  const handleRowDoubleClick = (entry) => {
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
    onOpen(entry.path);
  };

  // ---- 定位:打开时锁定一次,之后不随层级增加重算(避免整窗跳动) ----
  // 浮窗从锚定文件夹的下方展开,不遮挡所选的文件夹;
  // 可视宽度恒定为两栏:水平优先锚点右侧,放不下翻左侧,再放不下贴窗口右缘;
  // 下方空间不足时压缩栏高(内容可滚动),实在放不下(<120px)才翻到锚点上方;
  // 更深的栏靠 wrapper 横向滚动,并自动滚到最新一栏
  const wrapperRef = useRef(null);
  const posRef = useRef(null);
  if (posRef.current === null) {
    const maxW = Math.min(COL_W * 2 + 4, window.innerWidth - 16);
    let l = anchorRect.left + anchorRect.width + 4;
    if (l + maxW > window.innerWidth - 8) {
      const flipped = anchorRect.left - 4 - maxW;
      l = flipped >= 8 ? flipped : Math.max(8, window.innerWidth - 8 - maxW);
    }
    const belowT = anchorRect.top + anchorRect.height + 4;
    const belowAvail = window.innerHeight - 8 - belowT;
    let t, colH;
    if (belowAvail >= 120) {
      t = belowT; // 默认在锚点下方,栏高按可用空间压缩
      colH = Math.min(COL_MAX_H, belowAvail - 4);
    } else {
      const aboveAvail = anchorRect.top - 12;
      t = Math.max(8, anchorRect.top - 4 - Math.min(COL_MAX_H, aboveAvail));
      colH = Math.min(COL_MAX_H, Math.max(120, aboveAvail));
    }
    posRef.current = { left: l, top: t, maxW, colH };
  }
  const { left, top, maxW, colH } = posRef.current;

  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const w = wrapperRef.current;
    // 退场动画期间不干预滚动:栏宽收缩会自然带动视口回移
    if (w && exiting === 0) w.scrollTo({ left: w.scrollWidth, behavior: 'smooth' });
    // 内容超出可视宽度时,左右边缘用渐隐遮罩代替硬切
    if (w) setScrollable(w.scrollWidth > w.clientWidth + 1);
  }, [levels.length, exiting]);

  // 必须 portal 到 body:FileNavigator 在 zoom 容器内,容器内 fixed 元素
  // 的 left/top 会被 zoom 再缩放一次,而 anchorRect 已是真实视口坐标
  const edgeFade = 'linear-gradient(to right, transparent 0, black 14px, black calc(100% - 14px), transparent 100%)';
  return createPortal(
    <div
      ref={wrapperRef}
      data-cascade-menu="true"
      className="fixed z-50 flex items-start"
      style={{
        left,
        top,
        maxWidth: maxW,
        overflowX: 'auto',
        ...(scrollable ? { WebkitMaskImage: edgeFade, maskImage: edgeFade } : {}),
      }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {levels.map((level, i) => {
        const isExiting = exiting > 0 && i >= levels.length - exiting;
        return (
        <div
          key={`${i}:${level.path}`}
          className="bg-fluent-surface-flyout border border-fluent-stroke-card rounded-fluent-lg shadow-fluent-flyout py-1 overflow-y-auto overflow-x-hidden"
          style={{
            width: isExiting ? 0 : COL_W,
            flexShrink: 0,
            maxHeight: colH,
            marginLeft: i === 0 ? 0 : isExiting ? 0 : 4,
            opacity: isExiting ? 0 : 1,
            overflow: isExiting ? 'hidden' : undefined,
            pointerEvents: isExiting ? 'none' : undefined,
            transition: 'width .18s ease, margin-left .18s ease, opacity .18s ease',
          }}
        >
          {level.loading ? (
            <div className="flex items-center justify-center py-4 text-fluent-text-tertiary">
              <Loader2 size={14} className="animate-spin" />
            </div>
          ) : level.error ? (
            <div className="px-3 py-2 text-[12px] text-fluent-text-tertiary">无法访问此文件夹</div>
          ) : level.entries.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-fluent-text-tertiary">空文件夹</div>
          ) : (
            level.entries.map((entry) => {
              const isActive = selected[i] === entry.name;
              return (
                <div
                  key={entry.name}
                  onClick={() => handleRowClick(i, entry)}
                  onDoubleClick={() => handleRowDoubleClick(entry)}
                  className={`flex items-center gap-2 h-7 px-2 select-none text-[13px] text-fluent-text-primary ${
                    entry.isDirectory ? 'cursor-pointer' : 'cursor-default'
                  } ${isActive ? 'bg-fluent-accent-light' : 'hover:bg-fluent-fill-hover'}`}
                  title={entry.name}
                >
                  <FileTypeIcon path={entry.name} size={14} />
                  <span className="truncate flex-1 min-w-0">{entry.name}</span>
                  {entry.isDirectory && (
                    <ChevronRight size={12} className="flex-shrink-0 text-fluent-text-tertiary" />
                  )}
                </div>
              );
            })
          )}
        </div>
        );
      })}
    </div>,
    document.body
  );
}
