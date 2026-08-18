// tsdown.config.ts —— 构建配置（host 入口 + client 入口 + assets 拷贝）
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client/index.ts',
  },
  format: 'esm',
  // 输出 .js 扩展名（匹配 package.json 的 main/exports 字段）
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: true,
  clean: true,
  // 复制 relay.html 到 lib/assets/
  copy: [
    { from: 'assets/relay.html', to: 'lib/assets/' },
  ],
  // 确保输出到 lib/
  outDir: 'lib',
});
