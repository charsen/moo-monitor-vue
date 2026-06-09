import type { App, Plugin } from 'vue'
import { init, MooClient } from '../core/client'
import type { MooOptions } from '../core/types'

/**
 * Vue 3 插件:app.use(MooMonitor, options)。
 * 接管 app.config.errorHandler(Vue 渲染/生命周期/watcher 错误被 Vue 吞掉、不冒泡到
 * window.onerror,必须单独接),并保留宿主原有 handler;同时把 client 注入 provide / globalProperties。
 */
export const MooMonitor: Plugin = {
  install(app: App, options: MooOptions) {
    const client = init(options)
    const prev = app.config.errorHandler

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
