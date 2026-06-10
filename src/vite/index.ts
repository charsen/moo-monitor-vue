/**
 * moo-monitor-vue/vite —— 构建期 sourcemap 上传插件(Node 侧,与浏览器 SDK 无共享代码)。
 *
 * 用法(vite.config.ts):
 *   import { mooSourcemapUpload } from 'moo-monitor-vue/vite'
 *   plugins: [vue(), mooSourcemapUpload({ endpoint, token: process.env.MOO_SOURCEMAP_TOKEN!, release })]
 */
export { mooSourcemapUpload } from './plugin'
export type { SourcemapUploadOptions } from './plugin'
