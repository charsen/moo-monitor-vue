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

/**
 * tag#id.前两个类 —— SVG 的 className 是 SVGAnimatedString(非 string)→ 跳过类名;
 * id 同理防 named-getter 劫持:<form> 内有 <input name="id"> 时 form.id 是那个元素而非字符串。
 */
function selectorOf(el: Element): string {
  let sel = el.tagName.toLowerCase()
  if (typeof el.id === 'string' && el.id) sel += '#' + el.id
  if (typeof el.className === 'string' && el.className.trim()) {
    sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
  }
  return sel
}

/**
 * 取首个非空文本片段(BFS,访问预算 12 节点、每层只展开前 6 个子节点,跳过 script/style)。
 * 绝不读整棵子树的 textContent —— 点击 body 等大容器时那会把整页文本物化(CPU 尖刺 +
 * 任意页面内容入轨迹),这里最多拿到浅层一小段再截 24 字符。
 */
function firstText(el: Element): string {
  const queue: Node[] = [el]
  let budget = 12
  while (queue.length && budget-- > 0) {
    const n = queue.shift()!
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.nodeValue || '').trim()
      if (t) return t.replace(/\s+/g, ' ').slice(0, 24)
      continue
    }
    const tag = (n as Element).tagName
    if (tag === 'SCRIPT' || tag === 'STYLE') continue
    const kids = n.childNodes
    for (let i = 0; i < kids.length && i < 6; i++) queue.push(kids[i])
  }
  return ''
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
  const text = firstText(el)
  return text ? ` "${text}"` : ''
}

/** 完整描述(先爬到交互元素再拼 选择器 + 提示),上限 120 字符。 */
export function describeElement(el: Element | null): string {
  const target = interactiveTarget(el)
  if (!target || !target.tagName) return '(unknown)'
  return (selectorOf(target) + hintOf(target)).slice(0, 120)
}

type VueInstance = { type?: { name?: string; __name?: string }; parent?: VueInstance | null }

/**
 * 从 DOM 元素反查所属 Vue 组件名(轨迹「源码化」第一层):Vue 3 在宿主元素上挂
 * __vueParentComponent,沿实例链向上取第一个有名字的组件 —— 组件名是编译期注入的
 * 字符串字面量,生产压缩也保留。非 Vue 区域 / 函数式匿名组件返回 undefined。
 */
export function vueComponentName(el: Element | null): string | undefined {
  try {
    let cur: Element | null = el
    for (let i = 0; cur && i < 8; i++) {
      const inst = (cur as Element & { __vueParentComponent?: VueInstance }).__vueParentComponent
      if (inst) {
        let c: VueInstance | null | undefined = inst
        for (let j = 0; c && j < 12; j++) {
          const n = c.type?.name || c.type?.__name
          if (n) return String(n).slice(0, 40)
          c = c.parent
        }
        return undefined
      }
      cur = cur.parentElement
    }
  } catch {
    /* 反查失败不影响轨迹本体 */
  }
  return undefined
}
