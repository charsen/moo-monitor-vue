import { describe, it, expect } from 'vitest'
import { describeElement, interactiveTarget } from '../src/core/dom'

function el(html: string): Element {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.firstElementChild as Element
}

describe('describeElement(操作元素解析)', () => {
  it('按钮:tag#id.前两个类 + 可见文本', () => {
    const b = el('<button id="checkout" class="btn primary large">去结算</button>')
    expect(describeElement(b)).toBe('button#checkout.btn.primary "去结算"')
  })

  it('点中按钮里的 span/svg → 归到最近的交互祖先', () => {
    const b = el('<button id="pay"><span><i>立即支付</i></span></button>')
    const inner = b.querySelector('i')!
    expect(interactiveTarget(inner)).toBe(b)
    expect(describeElement(inner)).toBe('button#pay "立即支付"')
  })

  it('role=button 也算交互元素', () => {
    const d = el('<div role="button" class="card">卡片</div>')
    expect(describeElement(d.firstChild as never)).toContain('div.card')
  })

  it('输入框:绝不取值,用 name / placeholder / type 标识', () => {
    const input = el('<input name="email" value="secret@x.com">')
    const desc = describeElement(input)
    expect(desc).toBe('input[name=email]')
    expect(desc).not.toContain('secret') // 值绝不外泄

    expect(describeElement(el('<input placeholder="手机号">'))).toBe('input "手机号"')
    expect(describeElement(el('<input type="password" value="p@ss">'))).toBe('input[type=password]')
  })

  it('aria-label 优先于文本;超长截断', () => {
    expect(describeElement(el('<a aria-label="返回首页">🏠</a>'))).toBe('a "返回首页"')
    const long = el(`<button>${'长'.repeat(50)}</button>`)
    expect(describeElement(long).length).toBeLessThanOrEqual(120)
  })

  it('空目标兜底', () => {
    expect(describeElement(null)).toBe('(unknown)')
  })
})
