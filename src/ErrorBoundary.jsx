import React from 'react';

/**
 * 兜底 ErrorBoundary
 *
 * 透明 + 无边框窗口在 React 渲染抛错时会"消失"——整个 tree 被 unmount,
 * 用户只能看到桌面背景。挂在根级捕获 render-time 错误,显示明确报错,
 * 避免再次出现"点设置就闪退"的诊断盲区。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] React 渲染抛错:', error);
    console.error('[ErrorBoundary] 组件栈:', info && info.componentStack);
    this.setState({ info });
  }

  handleReset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const message = this.state.error?.message || String(this.state.error);
    const stack = this.state.error?.stack || '';
    const compStack = this.state.info?.componentStack || '';

    return (
      <div
        style={{
          padding: 16,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 12,
          color: '#1a1a1a',
          background: '#fff',
          height: '100%',
          overflowY: 'auto',
        }}
      >
        <h2 style={{ margin: '0 0 8px', fontSize: 14, color: '#c00' }}>
          界面出错了
        </h2>
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={this.handleReset}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              border: '1px solid #ccc',
              background: '#f5f5f5',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            重试
          </button>
        </div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#fafafa',
            padding: 8,
            borderRadius: 4,
            border: '1px solid #eee',
            margin: 0,
            fontSize: 11,
          }}
        >
{message}
{stack ? `\n\n${stack}` : ''}
{compStack ? `\n\n组件栈:${compStack}` : ''}
        </pre>
      </div>
    );
  }
}
