/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // ===== Fluent Design (Win11 浅色) 设计令牌 =====
        // 语义化命名即扩展点：后续接深色模式时只需替换此表（或改为 CSS 变量）
        fluent: {
          text: {
            primary: '#1B1B1B',
            secondary: '#616161',
            tertiary: '#9E9E9E',
            'on-accent': '#FFFFFF',
          },
          stroke: {
            card: 'rgba(0, 0, 0, 0.06)',
            control: 'rgba(0, 0, 0, 0.08)',
            divider: 'rgba(0, 0, 0, 0.06)',
            strong: 'rgba(0, 0, 0, 0.14)',
          },
          fill: {
            hover: 'rgba(0, 0, 0, 0.0373)',
            pressed: 'rgba(0, 0, 0, 0.0241)',
            subtle: 'rgba(255, 255, 255, 0.5)',
          },
          surface: {
            // Mica 材质上的 Layer on Acrylic 质感
            card: 'rgba(255, 255, 255, 0.7)',
            solid: '#FFFFFF',
            flyout: '#F9F9F9',
          },
          accent: {
            DEFAULT: '#0078D4',
            hover: '#106EBE',
            pressed: '#005A9E',
            light: '#EFF6FC',
            border: '#C7E0F4',
          },
          danger: '#C42B1C',
          success: '#107C10',
          warning: '#F7630C',
        },
      },
      borderRadius: {
        fluent: '4px', // 控件 / 输入框 / 按钮
        'fluent-lg': '8px', // 卡片 / 面板 / 弹窗
      },
      boxShadow: {
        'fluent-card': '0 2px 4px rgba(0, 0, 0, 0.04)',
        'fluent-flyout': '0 8px 16px rgba(0, 0, 0, 0.14)',
      },
      fontFamily: {
        // 全局正文+标题统一霞鹜文楷,西文/数字回退 Segoe UI 系
        fluent: [
          "'LXGW WenKai Lite'",
          "'Segoe UI Variable Text'",
          "'Segoe UI'",
          "'Noto Sans SC'",
          "'Microsoft YaHei'",
          'system-ui',
          'sans-serif',
        ],
        // 展示标题层:霞鹜文楷(大标题/模块标题用,正文勿用)
        display: [
          "'LXGW WenKai Lite'",
          "'Segoe UI Variable Text'",
          "'Noto Sans SC'",
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
