import type { ResolvedOptions } from './types'

/**
 * 运行时 release 自检:抽样调云端 /sourcemaps/check(复用浏览器上报 token,聚合只读),
 * 提前发现「代码已发、map 没传/传错」,仅经 onError 提示、绝不打扰用户。
 *
 * 在 install() 里【先于】httpCrumbs 调用:此刻本实例必未打补丁,同步取 window.fetch 并 bind(window)
 * 发请求 —— 不再需要跨模块拿 origFetch(与旧 `origFetch ?? window.fetch` 分支取到同一引用,零行为变化)。
 */
export function checkSourcemapRelease(opts: ResolvedOptions, onError?: (err: unknown) => void): void {
  const check = opts.releaseCheck
  if (!check || !opts.release || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  if (check.sampleRate <= 0 || Math.random() > check.sampleRate) return

  const url = opts.endpoint.replace(/\/+$/, '') + '/sourcemaps/check'
  const body = JSON.stringify({ token: opts.token, release: opts.release, app: check.app })
  const fetcher = window.fetch.bind(window)
  void fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    credentials: 'omit',
    mode: 'cors',
  })
    .then(async (res) => {
      const data = (await res.json().catch(() => null)) as
        | { vip?: boolean; health?: { artifact_count?: number; debug_id_coverage?: number | null; duplicate_debug_ids?: number; restorable_rate?: number | null } }
        | null
      if (!res.ok || !data?.health) {
        throw new Error(`release check failed: HTTP ${res.status}`)
      }
      const h = data.health
      if (data.vip && (h.artifact_count ?? 0) === 0) {
        onError?.(new Error(`moo-monitor-vue: release ${opts.release} has no sourcemap artifacts`))
      } else if ((h.duplicate_debug_ids ?? 0) > 0) {
        onError?.(new Error(`moo-monitor-vue: release ${opts.release} has duplicate sourcemap debug ids`))
      } else if (h.debug_id_coverage != null && h.debug_id_coverage < 1) {
        onError?.(new Error(`moo-monitor-vue: release ${opts.release} sourcemap debug id coverage is ${Math.round(h.debug_id_coverage * 100)}%`))
      }
    })
    .catch((e) => onError?.(e))
}
