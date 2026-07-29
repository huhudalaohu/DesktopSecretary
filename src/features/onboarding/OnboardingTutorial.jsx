/**
 * OnboardingTutorial.jsx — 新手教程(聚光灯引导)
 *
 * 交互约定:
 *   - 每一步都可以通过 X / 「跳过教程」 / ESC 直接关闭,不打断用户
 *   - 通过 data-tour 选择器锚定界面元素,聚光灯高亮 + 箭头气泡讲解
 *   - 锚点不存在(模块被隐藏)时退化为居中气泡
 *   - 关闭时写 onboardingDone,之后只能从左下角「教程」按钮手动打开
 *
 * 步骤维护:改界面布局后,检查 STEPS 里的 selector 是否还对得上。
 */

import React, { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { X, Camera, LayoutGrid, Clock, Pin, Settings, MousePointer2, HandMetal, FolderOpen } from 'lucide-react';
import { measureVisualRect } from '../../utils/measureVisualRect';

const api = window.desktopAPI;

const PAD = 6;           // 高亮框相对目标的扩张
const TOOLTIP_W = 264;   // 气泡宽度
const TOOLTIP_H = 150;   // 气泡估算高度(用于上下位置决策)

// measureVisualRect 已抽到 src/utils/measureVisualRect.js(级联弹窗共用)

const STEPS = [
  {
    selector: null,
    icon: HandMetal,
    title: '欢迎使用 Desktop Secretary',
    desc: '花 30 秒了解一下主要功能。任何一步都可以直接关闭本教程,之后随时能从左下角「教程」按钮重新打开。',
  },
  {
    selector: '[data-tour="screenshot-btn"]',
    icon: Camera,
    title: '截图加待办',
    desc: '点这个相机按钮(或按快捷键)截图,AI 会自动识别图中内容生成待办。也可以在左边输入框手动输入后点 + 号。',
  },
  {
    selector: '[data-tour="workspace-tabs"]',
    icon: LayoutGrid,
    title: '工作区标签',
    desc: '点击切换项目;双击重命名;拖拽调整顺序;右键可复制/删除。把标签直接拖到某条待办上,就能把待办绑定到该项目。',
  },
  {
    selector: '[data-tour="todo-item"]',
    icon: MousePointer2,
    title: '待办绑定项目',
    desc: '拖拽上面的工作区标签到一条待办上松开,待办就归入该项目;未完成事项会自动置顶,按添加顺序排列。',
  },
  {
    selector: '[data-tour="timeline"]',
    icon: Clock,
    title: '时间轴',
    desc: '每个圆点代表一条带提醒的待办,颜色对应提醒级别。双击圆点可以直接跳转定位到那条待办。',
  },
  {
    selector: '[data-tour="file-nav"]',
    icon: FolderOpen,
    title: '文件导航',
    desc: '从资源管理器把文件夹拖进来添加快捷方式,双击直接打开。鼠标悬停文件夹会弹出内容预览:点击文件夹进入下一层,点击左边一栏返回上一层,双击条目直接打开。标题旁的小开关可以关掉这个功能。',
  },
  {
    selector: '[data-tour="titlebar-btns"]',
    icon: Pin,
    title: '置顶与关闭',
    desc: '图钉按钮把窗口固定在最前;× 关闭窗口(后台继续运行,随时从托盘唤出)。',
  },
  {
    selector: '[data-tour="settings-btn"]',
    icon: Settings,
    title: '设置',
    desc: '快捷键、AI 模型、账号登录与云端同步、积分充值、数据备份都在这里。教程到此结束,开始用吧!',
  },
];

export default function OnboardingTutorial({ onClose }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null); // 当前锚点的 getBoundingClientRect

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // 关闭并持久化(任何路径关闭都走这里)
  const finish = useCallback(() => {
    try { api?.storeSet?.('onboardingDone', true); } catch {}
    onClose?.();
  }, [onClose]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finish]);

  // 锚点定位(步骤切换 / 窗口缩放 / 内容滚动时重算)
  useLayoutEffect(() => {
    const compute = () => {
      if (!current.selector) { setRect(null); return; }
      const el = document.querySelector(current.selector);
      setRect(el ? measureVisualRect(el) : null);
    };
    compute();
    window.addEventListener('resize', compute);
    // 捕获阶段监听滚动:待办列表/标签栏滚动时高亮框跟着走
    document.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      document.removeEventListener('scroll', compute, true);
    };
  }, [current]);

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  // 高亮框(带 PAD 扩张)
  const hl = rect && {
    left: Math.max(rect.left - PAD, 0),
    top: Math.max(rect.top - PAD, 0),
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };

  // 气泡位置:优先放目标下方,空间不够放上方;横向居中并夹紧在窗口内
  let tipStyle = {};
  let arrow = null; // 'up' | 'down'(箭头指向目标)
  let arrowLeft = null; // 箭头在气泡内的横向位置(对准目标中心)
  if (hl) {
    const below = hl.top + hl.height + 10 + TOOLTIP_H < winH;
    const centerX = hl.left + hl.width / 2;
    const left = Math.min(Math.max(centerX - TOOLTIP_W / 2, 8), Math.max(winW - TOOLTIP_W - 8, 8));
    tipStyle = below
      ? { left, top: hl.top + hl.height + 12 }
      : { left, top: Math.max(hl.top - TOOLTIP_H - 12, 8) };
    arrow = below ? 'up' : 'down';
    // 气泡被夹紧后箭头不能死守 50%,要对准目标中心
    arrowLeft = Math.min(Math.max(centerX - left, 14), TOOLTIP_W - 14);
  }

  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-[9999]">
      {/* 遮罩:有锚点时挖空,无锚点时全屏 */}
      {hl ? (
        <>
          <div className="absolute bg-black/45" style={{ left: 0, top: 0, width: winW, height: hl.top }} />
          <div className="absolute bg-black/45" style={{ left: 0, top: hl.top, width: hl.left, height: hl.height }} />
          <div className="absolute bg-black/45" style={{ left: hl.left + hl.width, top: hl.top, width: Math.max(winW - hl.left - hl.width, 0), height: hl.height }} />
          <div className="absolute bg-black/45" style={{ left: 0, top: hl.top + hl.height, width: winW, height: Math.max(winH - hl.top - hl.height, 0) }} />
          {/* 高亮描边 + 呼吸动画 */}
          <div
            className="absolute rounded-fluent-lg border-2 border-fluent-accent animate-pulse pointer-events-none"
            style={{ left: hl.left, top: hl.top, width: hl.width, height: hl.height, boxShadow: '0 0 0 4px rgba(0,120,215,0.25)' }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/45" />
      )}

      {/* 气泡卡片 */}
      <div
        className="absolute bg-fluent-surface-flyout rounded-fluent-lg shadow-fluent-flyout border border-fluent-stroke-card"
        style={hl ? { ...tipStyle, width: TOOLTIP_W } : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: TOOLTIP_W }}
      >
        {/* 箭头(旋转 45° 的方块,指向目标) */}
        {hl && (
          <div
            className="absolute w-2.5 h-2.5 bg-fluent-surface-flyout border-fluent-stroke-card rotate-45"
            style={arrow === 'up'
              ? { top: -6, left: arrowLeft, marginLeft: -5, borderLeftWidth: 1, borderTopWidth: 1 }
              : { bottom: -6, left: arrowLeft, marginLeft: -5, borderRightWidth: 1, borderBottomWidth: 1 }}
          />
        )}

        {/* 头部:图标 + 标题 + 步骤 + 关闭 */}
        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
          <Icon size={13} className="text-fluent-accent flex-shrink-0" />
          <span className="text-[12px] font-semibold text-fluent-text-primary flex-1 truncate">{current.title}</span>
          <span className="text-[10px] text-fluent-text-tertiary tabular-nums">{step + 1}/{STEPS.length}</span>
          <button onClick={finish} className="icon-btn" title="关闭教程 (Esc)">
            <X size={12} />
          </button>
        </div>

        {/* 正文 */}
        <div className="px-3 pb-2 text-[11px] leading-relaxed text-fluent-text-secondary">
          {current.desc}
        </div>

        {/* 进度点 + 按钮 */}
        <div className="flex items-center justify-between px-3 pb-2.5">
          <div className="flex items-center gap-1">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${i === step ? 'bg-fluent-accent' : 'bg-fluent-stroke-control'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={finish}
              className="text-[10px] px-2 py-1 rounded-fluent text-fluent-text-tertiary hover:text-fluent-text-secondary hover:bg-fluent-fill-hover transition-colors"
            >
              跳过教程
            </button>
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="text-[10px] px-2 py-1 rounded-fluent text-fluent-text-secondary hover:bg-fluent-fill-hover transition-colors"
              >
                上一步
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setStep((s) => s + 1))}
              className="btn-accent text-[10px] px-2.5 py-1"
            >
              {isLast ? '完成' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
