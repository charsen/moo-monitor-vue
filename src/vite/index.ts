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
// 直传契约(供手动上传脚本与其它 CI 工具复用):cloud 签票据 + 直传七牛 + confirm。
export {
  computeBuildId,
  sha256Hex,
  uploadSourcemapFile,
  QINIU_UPLOAD_HOSTS,
  SourcemapUploadError,
} from './directUpload'
export type {
  DirectUploadTarget,
  SourcemapHealth,
  SourcemapSourceMode,
  SourcemapUploadMeta,
  SourcemapUploadResult,
} from './directUpload'
