import { describeElement, isEditable, vueComponentName } from '../dom'
import type { InstrumentCtx, Uninstall } from './types'

/** 元素描述 + 所属 Vue 组件名(轨迹「源码化」第一层:`button.ant-btn "登录" · LoginForm`)。 */
function describeWithComponent(t: Element | null): string {
  const comp = vueComponentName(t)
  return describeElement(t) + (comp ? ` · ${comp}` : '')
}

/**
 * 点击 / 键盘轨迹 —— 二者共享打字聚合态 lastInputEl(click 会重置它),必须同居一个模块。
 * 点击:document 级捕获,解析「用户操作的元素」(就近交互祖先 + 可读选择器 + aria/文本提示;
 * 见 dom.ts,输入控件绝不取值)。不存 DOM 引用。
 * 键盘:只记两类、绝不记输入内容 —— ① Enter/Escape(提交、取消的关键节点);
 * ② 可编辑元素上的「开始输入」(同一元素的连续打字聚合成一条,只记目标不记值)。
 */
export function installDomCrumbs(ctx: InstrumentCtx): Uninstall {
  // 打字聚合:同一元素的连续输入只记一条「输入 →」crumb(换元素 / 按 Enter/Escape 后重新计)。
  let lastInputEl: Element | null = null

  // 整体 try/catch:轨迹手柄抛错会冒到 window.onerror 被 SDK 自己捕获成「宿主错误」(自噪音)。
  const onClick = (e: Event) => {
    try {
      const t = e.target as Element | null
      if (!t || !t.tagName) return
      lastInputEl = null // 点了别处,下一段输入重新记
      ctx.crumb({ category: 'click', message: describeWithComponent(t) })
    } catch (err) {
      ctx.onError(err)
    }
  }
  window.addEventListener('click', onClick, true)

  const onKeydown = (e: Event) => {
    try {
      const ke = e as KeyboardEvent
      // 扩展/测试工具会用普通 Event 派发 keydown(无 .key)→ 兜成空串,绝不抛。
      const key = typeof ke.key === 'string' ? ke.key : ''
      const t = ke.target as Element | null
      if (key === 'Enter' || key === 'Escape') {
        lastInputEl = null
        ctx.crumb({ category: 'key', message: `${key} → ${describeWithComponent(t)}` })
        return
      }
      if (ke.ctrlKey || ke.metaKey || ke.altKey) return // 快捷键不算输入
      if (key.length === 1 && t && t.tagName && isEditable(t)) {
        if (lastInputEl === t) return
        lastInputEl = t
        ctx.crumb({ category: 'input', message: `输入 → ${describeWithComponent(t)}` })
      }
    } catch (err) {
      ctx.onError(err)
    }
  }
  window.addEventListener('keydown', onKeydown, true)

  return () => {
    window.removeEventListener('click', onClick, true)
    window.removeEventListener('keydown', onKeydown, true)
    lastInputEl = null // 释放 DOM 引用(微前端卸载后不滞留已脱离的节点)
  }
}
