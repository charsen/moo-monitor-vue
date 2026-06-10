import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// 库模式:framework-agnostic core(入口 index)+ 薄 Vue 适配层(入口 vue),分别产 esm + cjs。
// vue 作 external(绝不打进包,避免双实例);类型用 vite-plugin-dts 按源结构生成。
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        vue: 'src/vue/index.ts',
        vite: 'src/vite/index.ts', // 构建期 sourcemap 上传插件(Node 侧)
      },
      formats: ['es', 'cjs'],
      fileName: (format, name) => `${name}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // vite 入口跑在 Node(构建期):node:* 内置模块与 vite 本身都不打进包。
      external: ['vue', 'vite', /^node:/],
      // exports:'named' —— vue 适配层同时有命名导出 + default(插件对象);消除混用警告,
      // cjs 使用方以 require('.../vue').default 取插件,named API 直接解构。
      output: { globals: { vue: 'Vue' }, exports: 'named' },
    },
    sourcemap: true,
    minify: false,
    target: 'es2020',
  },
  plugins: [dts({ rollupTypes: false, include: ['src'] })],
})
