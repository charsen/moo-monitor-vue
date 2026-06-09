import type { App, Plugin } from 'vue'
import { init, MooClient } from '../core/client'
import type { MooOptions } from '../core/types'

/** 插件选项 = 核心选项 + 可选的 Vue Router(用于捕获懒加载 chunk 失败)。 */
export type VuePluginOptions = MooOptions & {
  /** 传入 Vue Router 实例,接 router.onError 捕获「Loading chunk failed / 动态 import 失败」—— 发版后旧 chunk 404 常见,这类不进 window.onerror / errorHandler。 */
  router?: { onError: (handler: (err: unknown) => void) => void }
}

/**
 * Vue 3 插件:app.use(MooMonitor, options)。
 * 接管 app.config.errorHandler(Vue 渲染/生命周期/watcher 错误被 Vue 吞掉、不冒泡到
 * window.onerror,必须单独接),并保留宿主原有 handler;同时把 client 注入 provide / globalProperties。
 * SSR(无 window):仍 init 让命令式 API 可用,但不接管 errorHandler / 路由 —— 服务端错误应交给后端监控。
 */
export const MooMonitor: Plugin = {
  install(app: App, options: VuePluginOptions) {
    const client = init(options)
    if (typeof window === 'undefined') return // SSR:不接管浏览器侧捕获

    const prev = app.config.errorHandler

    // Vue Router 懒加载 chunk 失败不进 errorHandler / window.onerror,单独接 router.onError。
    options.router?.onError((err: unknown) => {
      client.captureException(err, { handled: false, severity: 'error', extra: { source: 'router' } })
    })

    app.config.errorHandler = (err: unknown, instance: unknown, info: string) => {
      // 组件名:选项式取 $options.name;<script setup> SFC 取编译注入的 type.__name(回退 type.name)。
      const inst = instance as {
        $options?: { name?: string }
        $?: { type?: { name?: string; __name?: string } }
      } | null
      const name = inst?.$options?.name || inst?.$?.type?.__name || inst?.$?.type?.name
      client.captureException(err, { handled: false, severity: 'error', extra: { vueInfo: info, component: name } })
      if (typeof prev === 'function') {
        prev(err, instance as never, info)
      } else if (typeof console !== 'undefined') {
        console.error(err)
      }
    }

    app.provide('mooMonitor', client)
    app.config.globalProperties.$moo = client
  },
}

export default MooMonitor

declare module 'vue' {
  interface ComponentCustomProperties {
    $moo: MooClient
  }
}
