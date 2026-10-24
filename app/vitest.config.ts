import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 定时事件转换依赖本机时区；固定为新加坡，保证结果可复现
    env: { TZ: 'Asia/Singapore' },
  },
});
