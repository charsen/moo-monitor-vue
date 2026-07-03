/**
 * moo-monitor-vue/vite —— 构建期 sourcemap 上传插件(Node 侧,与浏览器 SDK 无共享代码)。
 *
 * 用法(vite.config.ts):
 *   import { mooSourcemapUpload, resolveMooRelease } from 'moo-monitor-vue/vite'
 *   const release = await resolveMooRelease()
 *   plugins: [vue(), mooSourcemapUpload({ endpoint, token: process.env.MOO_SOURCEMAP_TOKEN!, release })]
 */
export { mooSourcemapUpload, resolveMooRelease } from './plugin'
export type { MooReleaseOptions, SourcemapUploadOptions } from './plugin'
