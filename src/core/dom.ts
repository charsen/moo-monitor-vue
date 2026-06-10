/**
 * 把用户操作的 DOM 目标解析成一段可读描述,用于行为轨迹(breadcrumbs)——
 * 例:`button#checkout "去结算"`、`a.nav-link "购物车"`、`input[name=email]`。
 *
 * 隐私边界:输入类控件(input/textarea/select/contenteditable)**绝不读取值或文本**,
 * 只用 name/placeholder/type 标识;普通元素的可见文本截断到 24 字符。
 */

const INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'])
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio'])

/** 点击的常是 button 里的 span/svg —— 向上找最近的交互元素(≤5 层),拿不到就用原目标。 */
export function interactiveTarget(el: Element | null): Element | null {
  let cur: Element | null = el
  for (let i = 0; cur && i < 5; i++) {
    if (INTERACTIVE.has(cur.tagName) || INTERACTIVE_ROLES.has(cur.getAttribute?.('role') || '')) return cur
    cur = cur.parentElement
  }
  return el
}

/** 是否可编辑目标(打字聚合判定用)。 */
export function isEditable(el: Element): boolean {
  return isInputLike(el)
}

function isInputLike(el: Element): boolean {
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  )
}

/** tag#id.前两个类 —— SVG 的 className 是 SVGAnimatedString(非 string)→ 跳过类名。 */
function selectorOf(el: Element): string {
  let sel = el.tagName.toLowerCase()
  if (el.id) sel += '#' + el.id
  if (typeof el.className === 'string' && el.className.trim()) {
    sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
  }
  return sel
}

/** 元素的人话提示:aria-label / title / name / placeholder / 可见文本(输入控件绝不取值)。 */
function hintOf(el: Element): string {
  const aria = el.getAttribute?.('aria-label') || el.getAttribute?.('title')
  if (aria) return ` "${aria.slice(0, 24)}"`
  if (isInputLike(el)) {
    const name = el.getAttribute?.('name')
    if (name) return `[name=${name.slice(0, 24)}]`
    const ph = el.getAttribute?.('placeholder')
    if (ph) return ` "${ph.slice(0, 24)}"`
    const type = el.getAttribute?.('type')
    return type ? `[type=${type}]` : ''
  }
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
  return text ? ` "${text.slice(0, 24)}"` : ''
}

/** 完整描述(先爬到交互元素再拼 选择器 + 提示),上限 120 字符。 */
export function describeElement(el: Element | null): string {
  const target = interactiveTarget(el)
  if (!target || !target.tagName) return '(unknown)'
  return (selectorOf(target) + hintOf(target)).slice(0, 120)
}
