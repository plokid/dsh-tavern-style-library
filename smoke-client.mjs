// 浏览器侧冒烟：确认模块加载、注册调用、接口接线正确。
// 不做组件渲染——假 React 跑不出真行为，渲染效果请在浏览器里看。
// 用法：node smoke-client.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
const fails = []

async function check(name, fn) {
  try { await fn(); pass += 1; console.log('  ok  ' + name) }
  catch (error) { fails.push({ name, error }); console.log('  FAIL ' + name + '\n       ' + (error?.message || error)) }
}

// ── 最小 React 替身：只要能加载模块、调用 createElement ──────────
const React = {
  createElement: (type, props, ...children) => ({
    type, props: props || {},
    children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false),
  }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  Fragment: 'div',
}

// ── 假宿主：记录注册调用 ─────────────────────────────────────
function makeUi(hosts) {
  const calls = { panel: [], status: [], group: [], composer: [] }
  return {
    apiVersion: 7,
    calls,
    callHost: async (name, args) => {
      const key = name.split('/').slice(1).join('/')
      const fn = hosts[key]
      if (!fn) throw new Error('没有 handle: ' + key)
      return fn(args || {})
    },
    registerPanel: definition => { calls.panel.push(definition); return () => {} },
    registerStatusSection: definition => { calls.status.push(definition); return () => {} },
    registerStartGroup: definition => { calls.group.push(definition); return () => {} },
    registerComposerAction: definition => { calls.composer.push(definition); return () => {} },
    openOverlay: () => {},
    watchTurnState: () => () => {},
  }
}

const library = {
  id: 'lib1', name: '冷峻武侠', tags: ['冷峻'],
  samples: [{ id: 's1', text: '样文内容', source: '书一', tags: ['冷峻'] }],
}
const hosts = {
  list: async () => ({ data: { version: 2, tags: ['冷峻'], libraries: [library] } }),
  'get-active': async () => ({ active: { libraryId: 'lib1' }, library, sample: library.samples[0], turn: 1 }),
  status: async () => ({ on: true, turn: 1, library: '冷峻武侠', quote: '样文内容', index: 1, total: 1 }),
  rotate: async () => ({ ok: true }),
  preview: async () => ({ text: 'x', library: '冷峻武侠', sampleIndex: 1, sampleTotal: 1, turn: 1 }),
  split: async () => ({ total: 0, chunks: [] }),
  'save-sample': async () => ({ data: {} }),
  'save-library': async () => ({ data: {}, id: 'lib1' }),
  'delete-library': async () => ({ data: {} }),
  'delete-sample': async () => ({ data: {} }),
  'add-tag': async () => ({ data: {} }),
  analyze: async () => ({ tags: [] }),
  'set-active': async () => ({ ok: true }),
  'card-distill': async () => ({ card: library.card }),
  'card-test': async () => ({ card: library.card, match: 82 }),
  'card-clear': async () => ({ data: {} }),
  'export-prompt': async () => ({ text: '# 写作风格 Prompt' }),
}

// ── 加载插件 ─────────────────────────────────────────────────
let factory = null
globalThis.window = { __ModuleLoader__: { load: definition => { factory = definition.factory } } }
const source = fs.readFileSync('./client.js', 'utf8')
// 组件都是模块内私有的，想真的渲染一次就得把它们捞出来：在工厂 return 之前
// 挂一个探针。只改运行时用的那份字符串，源码本身不动。
const patched = source.replace('return {\n      name: SELF,', 'globalThis.__probe = { Editor, StyleCardBlock, CardEditor, cardToForm, formToCard }\n    return {\n      name: SELF,')
assert.ok(patched !== source, '没找到工厂返回处，探针插不进去')
// eslint-disable-next-line no-new-func
new Function('window', 'React', patched)(globalThis.window, React)

await check('模块加载后拿到工厂函数', () => {
  assert.equal(typeof factory, 'function')
})

const plugin = factory(() => React)
await check('导出名与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'))
  assert.equal(plugin.name, pkg.name)
})

await check('声明注入 tavernUi', () => {
  assert.ok(plugin.inject.includes('tavernUi'))
})

const ui = makeUi(hosts)
plugin.apply({ tavernUi: ui })

await check('注册了侧栏面板', () => {
  assert.equal(ui.calls.panel.length, 1)
  assert.equal(ui.calls.panel[0].id, 'style-library')
  assert.equal(ui.calls.panel[0].title, '样文库')
})

await check('注册了状态分节，标题与定位贴着原版「下一轮文风联想」', () => {
  assert.equal(ui.calls.status.length, 1)
  assert.equal(ui.calls.status[0].id, 'style-library')
  assert.equal(ui.calls.status[0].title, '下一轮样文笔调')
  // title 不超过 20 字（宿主会校验）
  assert.ok(ui.calls.status[0].title.length <= 20)
})

await check('不再注册启动组，面板落在侧栏「插件」组里', () => {
  // plugin-api-ui.md：不声明 registerStartGroup 时，registerPanel 的面板在「插件」组。
  // 声明了反而会多出一层「样文库 / 样文库」。
  assert.equal(ui.calls.group.length, 0, '不该再调用 registerStartGroup')
})

await check('不再注册输入框「文风」按钮（按要求删掉）', () => {
  assert.equal(ui.calls.composer.length, 0, '不该再注册 composer action')
  assert.ok(!/registerComposerAction/.test(source), '源码里还留着 registerComposerAction')
})

await check('面板 render 能产出元素树而不抛错', () => {
  const tree = ui.calls.panel[0].render({ gameId: 'g1' })
  assert.ok(tree && typeof tree === 'object')
})

await check('状态分节 render 能产出元素树而不抛错', () => {
  const tree = ui.calls.status[0].render({ gameId: 'g1' })
  assert.ok(tree && typeof tree === 'object')
})

await check('状态分节自带打开侧栏页的入口（不依赖输入框按钮）', () => {
  // 状态分节里两处按钮都走 onOpen（apply 里注入），源码上断言接线存在
  assert.ok(/onOpen:\s*\(\)\s*=>\s*openPanel\(ui, gameId\)/.test(source),
    '状态分节没有拿到 openPanel')
  assert.ok(/onClick:\s*open\b/.test(source), '状态分节里没有用 open 的按钮')
  assert.ok(/去样文库|换库或固定某一段/.test(source), '缺少跳转样文库的文案')
})

await check('侧栏列表页带搜索框', () => {
  assert.ok(/type:\s*'search'/.test(source), '列表页没有搜索输入框')
  assert.ok(/placeholder:\s*'搜索库名/.test(source), '搜索框没有占位说明')
  assert.ok(/'aria-label':\s*'搜索样文库'/.test(source), '搜索框没有无障碍标签')
  assert.ok(/没有匹配/.test(source), '搜不到时没有提示')
})

await check('搜索覆盖样文正文，并把命中条目单独列出来', () => {
  // 命中判定要扫样文正文和出处，不只是库名。
  assert.ok(/hitText\(item\.text\)\s*\|\|\s*hitText\(item\.source\)/.test(source),
    '搜索没有覆盖样文正文与出处')
  // 命中的样文要按库分组存下来，供列表页单独渲染。
  assert.ok(/const sampleHits\s*=\s*\{\}/.test(source), '没有收集命中的样文条目')
  assert.ok(/Object\.keys\(sampleHits\)/.test(source), '命中的样文没有单独渲染')
  // 结果条目要带库名和段号，能定位到具体是哪一条。
  assert.ok(/第 '\s*\+\s*place\s*\+\s*' 段/.test(source), '命中的样文没有标出段号')
  // 命中的样文要能直接固定给本局，或跳到所在库。
  assert.ok(/本局固定用这段/.test(source), '命中的样文不能直接指定')
  assert.ok(/打开所在库/.test(source), '命中的样文不能跳到所在库')
  // 「固定」必须走 set-active 并带上 sampleId，否则只是选了库、没钉住那一条。
  assert.ok(/onClick: \(\) => pick\(library\.id, sample\.id\)/.test(source),
    '固定某条没有调用 pick(libraryId, sampleId)')
  assert.ok(/sampleId: sampleId \|\| ''/.test(source), 'pick 没有把 sampleId 传给宿主')
})

await check('侧栏能手动增删改笔调标签', () => {
  assert.ok(/view === 'tags'/.test(source), '没有标签管理页')
  assert.ok(/action:\s*'add'/.test(source), '不能添加标签')
  assert.ok(/action:\s*'remove'/.test(source), '不能删除标签')
  assert.ok(/action:\s*'rename'/.test(source), '不能改标签名')
  // 改名要提示同步了几处引用
  assert.ok(/同步更新了/.test(source), '改名后没有提示同步了几处引用')
  // 删除前要提醒仍被引用：现在走的是面板里的 ConfirmBar，不再用 window.confirm
  // （原生弹窗样式不可控，在宿主的 iframe 里还可能被拦掉，点了什么都不会发生）
  assert.ok(/setPendingDelete\(\{ kind: 'tag'/.test(source), '删除标签没有走二次确认')
  assert.ok(/会清掉它在这/.test(source), '确认里没说清会清掉哪些引用')
  assert.ok(!/window\.confirm/.test(source), '还在用 window.confirm 做确认')
})

await check('状态分节沿用原版「文风联想」的版式类名', () => {
  // 原版那一节用 dsh-tavern-style-head / -source / -retry / -reference
  assert.ok(/dsl-status-head/.test(source), '缺少标题行类名')
  assert.ok(/dsl-status-quote/.test(source), '缺少引文块类名')
  assert.ok(/is-expanded/.test(source), '引文不能展开')
  assert.ok(/dsl-status-link/.test(source), '缺少右侧小按钮类名')
})

await check('没有 registerStatusSection 时静默跳过，其余照常', () => {
  const partial = makeUi(hosts)
  delete partial.registerStatusSection
  const other = factory(() => React)
  other.apply({ tavernUi: partial }) // 不应抛错
  assert.equal(partial.calls.panel.length, 1)
})

await check('没有 watchTurnState 时也不影响加载', () => {
  const partial = makeUi(hosts)
  delete partial.watchTurnState
  const other = factory(() => React)
  other.apply({ tavernUi: partial })
  assert.equal(partial.calls.status.length, 1)
})

await check('接口版本过低时什么也不注册', () => {
  const partial = makeUi(hosts)
  partial.apiVersion = 1
  const other = factory(() => React)
  other.apply({ tavernUi: partial })
  assert.equal(partial.calls.panel.length, 0)
  assert.equal(partial.calls.status.length, 0)
})

await check('client 调用的每个 handle 宿主侧都存在', () => {
  const host = fs.readFileSync('./index.mjs', 'utf8')
  const used = [...new Set([...source.matchAll(/call\(ui, '([a-z-]+)'/g)].map(match => match[1]))]
  const missing = used.filter(name => !host.includes("'" + name + "'"))
  assert.deepEqual(missing, [], '宿主侧缺少：' + missing.join(', '))
})

// ── 侧栏化与样式 ─────────────────────────────────────────────

await check('声明注入 betterSidebar（打开侧栏页要用）', () => {
  assert.ok(plugin.inject.includes('tavernUi'))
  assert.ok(plugin.inject.includes('betterSidebar'))
})

await check('不再直接注册遮罩层做编辑（编辑在侧栏内切换）', () => {
  // 允许一处兜底提示，但不应再有编辑/选择的 openOverlay
  assert.ok(!/render:\s*\(\{\s*close\s*\}\)\s*=>\s*h\(Editor/.test(source), '编辑仍走弹层')
  assert.ok(!/render:\s*\(\{\s*close\s*\}\)\s*=>\s*h\(Picker/.test(source), '选择仍走弹层')
})

// 打开侧栏页现在只有「酒馆状态」分节里的链接用得到。
// 这些用例统一走状态分节 render 传下来的 onOpen，不再依赖输入框按钮。
function openViaStatus(harness, gameId) {
  const tree = harness.calls.status[0].render({ gameId })
  const onOpen = tree && tree.props && tree.props.onOpen
  assert.equal(typeof onOpen, 'function', '状态分节没拿到 onOpen')
  onOpen()
}

await check('状态分节跳转用 seed 对象调 openTab', () => {
  const opened = []
  const harness = makeUi(hosts)
  harness.openOverlay = () => { harness.overlaid = true }
  const sidebar = {
    openTab: (seed, scope) => opened.push({ seed, scope }),
    getTab: id => (id === 'tavern-plugin:dsh-tavern-style-library:style-library' ? { id } : undefined),
    isTabEnabled: () => true,
  }
  const other = factory(() => React)
  other.apply({ tavernUi: harness, betterSidebar: sidebar })
  openViaStatus(harness, 'g1')
  assert.equal(opened.length, 1, '应调用一次 openTab')
  assert.equal(typeof opened[0].seed, 'object', 'openTab 的第一个参数必须是对象')
  assert.equal(opened[0].seed.type, 'tavern-plugin:dsh-tavern-style-library:style-library',
    'seed.type 必须是注册时的 tab id')
  assert.equal(opened[0].scope.sessionId, 'g1')
  assert.ok(!harness.overlaid, '打开成功时不该再弹遮罩')
})

await check('不会再出现「点了没动静」：打开不了就给出可见提示', () => {
  const harness = makeUi(hosts)
  let overlaid = false
  harness.openOverlay = () => { overlaid = true }
  // 页没注册上（getTab 拿不到）→ 不能静默，要弹说明
  const sidebar = { openTab() {}, getTab: () => undefined, isTabEnabled: () => true }
  const other = factory(() => React)
  other.apply({ tavernUi: harness, betterSidebar: sidebar })
  openViaStatus(harness, 'g1')
  assert.ok(overlaid, '打开不了时应弹提示，而不是什么都不发生')
})

await check('打开的页被用户在侧栏设置里关掉时也给提示', () => {
  const harness = makeUi(hosts)
  let overlaid = false
  harness.openOverlay = () => { overlaid = true }
  const sidebar = { openTab() {}, getTab: id => ({ id }), isTabEnabled: () => false }
  const other = factory(() => React)
  other.apply({ tavernUi: harness, betterSidebar: sidebar })
  openViaStatus(harness, 'g1')
  assert.ok(overlaid, '页被禁用时应提示去哪打开，而不是静默')
})

// tabId 必须和宿主 registerPanel 生成的一致，否则 openTab 打不开那一页、点了没反应。
// 直接从宿主源码里抠格式，避免以后又凭记忆写错。
await check('tabId 与宿主 registerPanel 的格式完全一致', () => {
  const hostPath = '../dsh-tavern/tavern-plugin/src/client/features/plugin-extensions.js'
  if (!fs.existsSync(hostPath)) return 'skip' // 没装 Tavern 源码时不判
  const host = fs.readFileSync(hostPath, 'utf8')
  const built = /const tabId = "tavern-plugin:"\s*\+\s*owner\s*\+\s*"([^"]+)"\s*\+\s*input\.id/.exec(host)
  assert.ok(built, '没找到宿主生成 tabId 的那行代码')
  const expected = 'tavern-plugin:dsh-tavern-style-library' + built[1] + 'style-library'
  // 插件源码里是 'a' + SELF + 'b' 的拼法，逐段校验前缀/分隔符/后缀
  assert.ok(source.includes("'tavern-plugin:' + SELF + '" + built[1] + "style-library"),
    '插件的 tabId 拼法不是 ' + expected)
  assert.ok(!/'tavern-plugin:'\s*\+\s*SELF\s*\+\s*'\/style-library/.test(source), 'tabId 用了斜杠分隔')
})

await check('没有 betterSidebar 时退回提示遮罩，不抛错', () => {
  const harness = makeUi(hosts)
  let overlaid = false
  harness.openOverlay = () => { overlaid = true }
  const other = factory(() => React)
  other.apply({ tavernUi: harness })
  openViaStatus(harness, 'g1')
  assert.equal(overlaid, true, '应给出兜底提示')
})

await check('样式表被注入到 head', () => {
  const injected = []
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: node => injected.push(node) },
  }
  const other = factory(() => React)
  const harness = makeUi(hosts)
  other.apply({ tavernUi: harness })
  assert.equal(injected.length, 1, '应注入一段样式')
  assert.equal(injected[0].id, 'dsh-tavern-style-library-css')
  assert.ok(injected[0].textContent.includes('dsl-btn'), '样式内容应包含插件类名')
  // 用到的类名都要在这段 CSS 里定义过
  const defined = new Set([...injected[0].textContent.matchAll(/\.(dsl-[a-z-]+)/g)].map(m => m[1]))
  const usedClasses = new Set([...source.matchAll(/['" ](dsl-[a-z-]+)/g)].map(m => m[1]))
  const missing = [...usedClasses].filter(name => !defined.has(name))
  assert.deepEqual(missing, [], '样式里缺少这些类：' + missing.join(', '))
  delete globalThis.document
})

await check('复用 Tavern 自己的容器类名', () => {
  assert.ok(source.includes('dsh-tavern-settings-section'), '应使用 dsh-tavern-settings-section')
  assert.ok(source.includes('dsh-tavern-settings-group'), '应使用 dsh-tavern-settings-group')
})

await check('插件样式只用 Tavern 的 CSS 变量，不硬编码颜色', () => {
  const cssPart = source.slice(source.indexOf('const CSS ='), source.indexOf('function ensureStyles'))
  // 允许 #b7791f 这一处警告色，其余应走变量
  const hexColors = [...cssPart.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0])
  const allowed = ['#b7791f']
  const bad = hexColors.filter(color => !allowed.includes(color))
  assert.deepEqual(bad, [], '发现硬编码颜色：' + bad.join(', '))
})

await check('侧栏页占满高度，头部固定、内容区独立滚动', () => {
  const cssPart = source.slice(source.indexOf('const CSS ='), source.indexOf('function ensureStyles'))
  // 父容器是 betterSidebar 的 nativeTabHost（display:flex; flex-direction:column; height:100%）。
  // 只写 height:100% 不够：flex 子项默认 min-height:auto，内容一长就撑破父级，overflow-y 永远不触发。
  assert.ok(/\.dsl-page\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*flex-direction:\s*column/.test(cssPart),
    '.dsl-page 缺少 flex:1 + min-height:0 + 纵向排布')
  // 头部不参与滚动
  assert.ok(/\.dsl-page-head\s*\{[^}]*flex:\s*none/.test(cssPart), '.dsl-page-head 没有固定')
  // 内容区要 min-height:0 + overflow-y:auto，flex 子项默认 min-height:auto 会撑破容器
  assert.ok(/\.dsl-page-body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/.test(cssPart),
    '.dsl-page-body 没有独立滚动')
  // 内容块不许被压缩，否则高度不够时每一块都被挤扁，看起来还是「滚不动」
  assert.ok(/\.dsl-page-body\s*>\s*\*\s*\{[^}]*flex:\s*none/.test(cssPart),
    '.dsl-page-body 的子项会被 flex 压扁')
  // 四个页面都要走同一套骨架
  assert.ok((source.match(/className: 'dsl-page'/g) || []).length === 4,
    '不是四个页面都用 dsl-page 骨架')
})

await check('返回按钮在左上角，不是「关闭」', () => {
  // Tavern 自带页（Skill 库、预设库）的写法：头部第一个元素是「← 返回」。
  // 列表页是顶层，不需要返回；其余三个子页都要有。
  const heads = [...source.matchAll(/className: 'dsl-page-head'[\s\S]{0,300}/g)].map(m => m[0])
  assert.ok(heads.length >= 4, '页面头部数量不对：' + heads.length)
  const withBack = heads.filter(head => /← 返回/.test(head))
  assert.ok(withBack.length === 3, '应该有三个子页带「← 返回」，实际 ' + withBack.length)
  // 带返回的头里，第一个 Button 必须就是返回
  for (const head of withBack) {
    const first = head.match(/h\(Button,\s*\{[\s\S]{0,120}?\},\s*'([^']+)'\)/)
    assert.ok(first && first[1] === '← 返回', '左上角第一个按钮不是返回：' + (first && first[1]))
  }
  // 列表页头部是标题 + 操作，不该有「关闭」
  const listHead = heads.find(head => /样文库/.test(head) && !/← 返回/.test(head))
  assert.ok(listHead && !/关闭/.test(listHead), '列表页头部还留着「关闭」')
})

await check('预览只显示样文原文，不带「只借笔调」的规则说明', () => {
  // 规则说明是给模型的，不该出现在面板上——否则看起来像样文自带的文字。
  assert.ok(/result\.sampleText/.test(source), '预览没有用 sampleText（纯原文）')
  assert.ok(!/\+\s*'\n\n'\s*\+\s*result\.text/.test(source), '预览还在拼 result.text（含规则）')
  // 判断「本轮会不会注入」仍看 text，那个字段为空就代表没有可注入内容
  assert.ok(/if \(!result\.text\)/.test(source), '判断是否有内容的口径变了')
})

await check('页面留出边距，不贴容器边框', () => {
  const cssPart = source.slice(source.indexOf('const CSS ='), source.indexOf('function ensureStyles'))
  // Tavern 的 dsh-tavern-settings-section 本身没有 padding，贴边都是插件自己没补
  assert.ok(/\.dsl-page-body\s*\{[^}]*padding:/.test(cssPart), '内容区没有内边距')
  assert.ok(/\.dsl-page-head\s*\{[^}]*padding:/.test(cssPart), '头部没有内边距')
  // 侧栏页不该再借 settings-section 加自造的 maxWidth 和 padding。
  // 兜底遮罩（打不开侧栏时弹的那个）不是侧栏页，不在检查范围内。
  const panelPart = source.slice(source.indexOf('function Panel('), source.indexOf('function makeOpenPanel'))
  assert.ok(panelPart.length > 0, '没找到侧栏面板的实现')
  assert.ok(!/className: 'dsh-tavern-settings-section',\s*\n?\s*style: \{ maxWidth/.test(panelPart),
    '侧栏页还在用 settings-section + 自造 padding')
})

await check('点「编辑」就地展开在那一条里面，并把这条滚进视野', () => {
  // 之前是把内容填到页面最底下的「单条添加」表单，那块在视口外，
  // 用户点完看起来就是没反应。现在就地展开在那一条下面。
  assert.ok(/sample\.id === item\.id/.test(source), '没判断当前是否在编辑这一条')
  assert.ok(/'data-editing-sample':/.test(source), '缺少 data-editing-sample，滚动定位找不到目标')
  assert.ok(!/setSample\(item\);\s*\n\s*scrollTo|document\.querySelector\('\[data-sample\]'\)/.test(source),
    '还在把内容塞到别处')
  // 定位不用 scrollIntoView：它向外冒泡找可滚动祖先，实现在多层 flex 里会静默失效
  assert.ok(/box\.scrollTop = Math\.max\(0, target\)/.test(source), '没有直接写 scrollTop 做定位')
  // 末尾几条顶边对齐后会超出可滚范围，被夹住就露出半截，要有底边对齐的兜底
  assert.ok(/maxScroll/.test(source) && /offsetTop \+ nodeHeight - boxHeight/.test(source),
    '缺少靠近末尾时的底边对齐兜底')
})

await check('标签页不是一片留白：有概况卡片和完整清单', () => {
  // 之前只有两行 hint 加一个输入框，下面直接跟列表，整页看着是空的。
  const start = source.indexOf("if (view === 'tags')")
  assert.ok(start > 0, '没找到标签页')
  const part = source.slice(start, source.indexOf("// 列表页", start))
  // 顶部要是一张带标题和计数的卡片，不是裸 hint
  assert.ok(/标签池（' \+ pool\.length/.test(part), '顶部没有标签池概况标题')
  assert.ok(/个在用/.test(part), '没标出有几个标签在用')
  assert.ok(/全部标签/.test(part), '清单没有分组标题')
  // 每个标签要说清用了多少处，不只是「有没有被用到」
  assert.ok(/共 ' \+ count \+ ' 处/.test(part), '没有标出被引用的具体处数')
})

await check('删除库、删标签、删样文都走二次确认', () => {
  // 三处删除都必须先问一次，不能点了就删
  assert.ok(/setPendingDelete\(\{ kind: 'library'/.test(source), '删库没有二次确认')
  assert.ok(/setPendingDelete\(\{ kind: 'tag'/.test(source), '删标签没有二次确认')
  assert.ok(/askDelete\(item\)/.test(source), '删样文没有二次确认')
  // 确认条就地展开在被删的那一条里，并带 data 属性供滚动定位
  assert.ok(/function ConfirmBar/.test(source), '没有确认条组件')
  assert.ok(/'data-editing-confirm'/.test(source), '删样文的确认条没法滚进视野')
  assert.ok(!/window\.confirm|confirm\(/.test(source), '还在用浏览器原生弹窗做确认')
  // 确认按钮是实心红底，和普通「删除」区分开
  assert.ok(/is-danger-solid/.test(source), '确认按钮和普通删除按钮样式一样')
})

await check('风格卡：编辑页有提炼入口和注入方式开关', () => {
  // 组件本身在假 React 里跑不出交互，只校验接线与文案在，避免以后被删掉。
  assert.ok(/function StyleCardBlock/.test(source), '没有风格卡组件')
  assert.ok(/h\(StyleCardBlock/.test(source), '编辑页没有挂上风格卡区块')
  assert.ok(/'card-distill'/.test(source), '没有提炼入口')
  assert.ok(/'card-test'/.test(source), '没有试写入口')
  assert.ok(/'export-prompt'/.test(source), '没有导出 Prompt 入口')
  // 三种注入方式都要在
  for (const mode of ["'sample'", "'both'", "'card'"]) {
    assert.ok(source.includes(mode), '缺少注入方式 ' + mode)
  }
  // 九个维度都要有中文标签，漏一个就会在面板上少一行
  const labels = source.slice(source.indexOf('const DIMENSION_LABELS'), source.indexOf('function StyleCardBlock'))
  assert.equal((labels.match(/\['[a-z]+', '/g) || []).length, 9, '维度标签不是九个')
})

await check('风格卡：清除和重新提炼都走二次确认', () => {
  const part = source.slice(source.indexOf('function StyleCardBlock'), source.indexOf('// ── 样文库编辑'))
  assert.ok(/setConfirming\('clear'\)/.test(part), '清除没有二次确认')
  // 重新提炼会调一次模型并覆盖现有卡，也不该点一下就发生
  assert.ok(/setConfirming\('distill'\)/.test(part), '重新提炼没有二次确认')
  assert.ok(/h\(ConfirmBar/.test(part), '没有用确认条')
  assert.ok(/不可恢复/.test(part), '清除的确认里没说清后果')
  assert.ok(/上一版/.test(part), '提炼的确认里没说旧卡会留着')
})

await check('只用风格卡时不显示「换一段」', () => {
  // 没有摘录可换，按钮留着只会点了报错
  assert.ok(/info\.mode !== 'card'/.test(source), '没有按注入方式隐藏换一段')
  assert.ok(/info\.card/.test(source), '状态分节没有标出风格卡')
})

// 组件跑一遍真渲染：假 React 不做 diff，但元素树是真的建出来了，
// 字段名写错、访问 undefined、条件分支漏判都会在这里炸。
const { Editor, StyleCardBlock } = globalThis.__probe || {}
const sampleCard = {
  author: '某人', genre: '武侠', corpus: { articles: 12, chars: 18000 },
  summary: '句子短，少解释。',
  dimensions: { lexical: ['单音节动词多'], syntactic: ['平均 11 字'], imagery: ['视觉为主'] },
  genes: [{ name: '留白呼吸', text: '句与句之间留空' }],
  laws: ['每段至少一个可触的物件'],
  disallowed: ['不写内心独白'],
  aiBan: ['不由得'],
  mantra: '先看见，再说话。',
  formula: '场景式：定场 → 动作 → 收在一个物件上',
  match: 82,
}
const baseLibrary = { id: 'l1', name: '冷峻武侠', tags: ['冷峻'], note: '', samples: [], mode: 'sample', card: null }

await check('编辑页能渲染（无卡 / 有卡）', () => {
  assert.equal(typeof Editor, 'function', '没拿到 Editor')
  const bare = Editor({ gameId: 'g1', ui, tags: [], library: baseLibrary, onClose: () => {}, onChanged: () => {} })
  assert.ok(bare && typeof bare === 'object')
  const full = Editor({ gameId: 'g1', ui, tags: [], library: { ...baseLibrary, card: sampleCard }, onClose: () => {}, onChanged: () => {} })
  assert.ok(full && typeof full === 'object')
  // 卡片组件要被挂进编辑页，不然提炼入口就没了
  assert.ok(JSON.stringify(full, (key, value) => (typeof value === 'function' ? '[fn ' + value.name + ']' : value)).includes('[fn StyleCardBlock]'),
    '编辑页没挂上风格卡区块')
})

await check('风格卡区块渲染出九个维度的内容', () => {
  assert.equal(typeof StyleCardBlock, 'function', '没拿到 StyleCardBlock')
  const withCard = JSON.stringify(StyleCardBlock({ ui, gameId: 'g1', libraryId: 'l1', card: sampleCard, onChanged: () => {} }))
  for (const part of ['dsl-card', '写作基因', '铁律', '从不出现', 'AI 腔', '起笔口诀', '叙事公式', '自评 82%', '句子短，少解释']) {
    assert.ok(withCard.includes(part), '卡片里缺少：' + part)
  }
  // 三个有内容的维度都要渲染出来
  for (const label of ['词汇：', '句法：', '感官：']) assert.ok(withCard.includes(label), '缺少维度行 ' + label)
})

await check('没有卡时给出提炼入口而不是空白', () => {
  const empty = JSON.stringify(StyleCardBlock({ ui, gameId: 'g1', libraryId: 'l1', card: null, onChanged: () => {} }))
  assert.ok(empty.includes('AI 提炼风格卡'), '空卡时没有提炼按钮')
  assert.ok(empty.includes('粘贴一张卡'), '空卡时没有导入入口')
  assert.ok(empty.includes('9 个维度'), '没有说明卡是什么')
})

// 编辑表单是「卡 ↔ 一行一条的文本」，两头必须能对上，否则用户改完保存就把卡改坏了。
await check('卡转表单再转回来不丢内容', () => {
  const { cardToForm, formToCard } = globalThis.__probe || {}
  assert.equal(typeof cardToForm, 'function', '没拿到 cardToForm')
  assert.equal(typeof formToCard, 'function', '没拿到 formToCard')

  const form = cardToForm(sampleCard)
  assert.equal(form.dimensions.lexical, '单音节动词多')
  assert.equal(form.laws, '每段至少一个可触的物件')
  assert.equal(form.genes, '留白呼吸：句与句之间留空')
  assert.equal(form.aiBan, '不由得')

  const back = formToCard(form, sampleCard)
  assert.equal(back.summary, sampleCard.summary)
  assert.equal(back.mantra, sampleCard.mantra)
  assert.equal(back.formula, sampleCard.formula)
  assert.deepEqual(back.laws, sampleCard.laws)
  assert.deepEqual(back.disallowed, sampleCard.disallowed)
  assert.deepEqual(back.aiBan, sampleCard.aiBan)
  assert.deepEqual(back.genes, sampleCard.genes)
  assert.deepEqual(back.dimensions, sampleCard.dimensions)
  // 没在表单里出现的字段要原样带回去，否则一保存就把作者/语料冲掉
  assert.equal(back.author, sampleCard.author)
  assert.deepEqual(back.corpus, sampleCard.corpus)
})

await check('表单里清空的条目真的会被去掉', () => {
  const { cardToForm, formToCard } = globalThis.__probe
  const form = cardToForm(sampleCard)
  form.disallowed = ''
  form.dimensions.imagery = ''
  const back = formToCard(form, sampleCard)
  assert.deepEqual(back.disallowed, [], '清空的禁用清单要变空')
  assert.equal(back.dimensions.imagery, undefined, '清空的维度要从卡里去掉')
})

await check('编辑表单能渲染', () => {
  const { CardEditor } = globalThis.__probe || {}
  assert.equal(typeof CardEditor, 'function', '没拿到 CardEditor')
  const tree = JSON.stringify(CardEditor({ ui, libraryId: 'l1', card: sampleCard, onSaved: () => {}, onCancel: () => {} }))
  assert.ok(tree.includes('指纹小结'), '没有指纹小结输入')
  assert.ok(tree.includes('写作基因'), '没有写作基因输入')
  assert.ok(tree.includes('单音节动词多'), '没有把现有内容填进去')
})

console.log('\n结果：' + pass + ' 通过，' + fails.length + ' 失败\n')
if (fails.length) {
  for (const item of fails) console.log(item.name + '\n' + (item.error?.stack || item.error))
  process.exit(1)
}
