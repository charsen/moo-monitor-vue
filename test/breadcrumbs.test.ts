import { describe, it, expect } from 'vitest'
import { BreadcrumbBuffer } from '../src/core/breadcrumbs'

// 源自第八轮审查回归(BreadcrumbBuffer message 钳制)。
describe('④ breadcrumb message 钳制', () => {
  it('超长 message(data: URL 等)截到 300', () => {
    const buf = new BreadcrumbBuffer(5)
    buf.add({ category: 'fetch', message: 'GET data:image/png;base64,' + 'A'.repeat(50000) + ' 200' })
    expect(buf.all()[0].message!.length).toBeLessThanOrEqual(301)
  })
})
