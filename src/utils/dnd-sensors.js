import { PointerSensor } from '@dnd-kit/core';

/**
 * 自定义 PointerSensor：忽略 input/textarea/contenteditable 上的 pointerdown，
 * 避免在输入框内选中文本时误触拖拽导致界面卡死。
 */
export class SmartPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown',
      handler: ({ nativeEvent: event }) => {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')
        ) {
          return false;
        }
        return true;
      },
    },
  ];
}
