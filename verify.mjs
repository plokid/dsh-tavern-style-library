// 宿主侧验证：用假的 tavern / tools 服务跑真实代码路径。
// 验证切段规则、Agent 工具注册、工具行为、Skill 路径。
// 用法：node verify.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = await import('./index.mjs')

let pass = 0
const fails = []

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log('  ok  ' + name)
  } catch (error) {
    fails.push({ name, error })
    console.log('  FAIL ' + name + '\n       ' + (error?.message || error))
  }
}

// ── 假服务 ────────────────────────────────────────────────────
function makeEnv(initial) {
  let store = initial ? JSON.parse(JSON.stringify(initial)) : null
  const gameStore = new Map()
  const handlers = new Map()
  const registered = []
  const modeCalls = []
  const effects = []
  const sections = []
  let skillDir = ''

  const tavern = {
    apiVersion: 2,
    async readPluginData() { return store },
    async savePluginData({ data }) { store = JSON.parse(JSON.stringify(data)) },
    async readGameData({ gameId }) { return gameStore.get(gameId) || null },
    async saveGameData({ gameId, data }) { gameStore.set(gameId, data) },
    handle(name, fn) { handlers.set(name, fn) },
    turnSection(definition) { sections.push(definition) },
    toolModes(call) { modeCalls.push(call) },
    skillSource(call) { skillDir = call.dir; return () => {} },
    async runTask() { throw new Error('测试里不调模型') },
  }

  const tools = {
    register(definition) { registered.push(definition); return () => {} },
  }

  const ctx = {
    tavern,
    tools,
    effect(fn) { const out = fn(); effects.push(out); return () => {} },
    get(key) { return key === 'tools' ? tools : null },
  }

  return {
    ctx, tavern, tools,
    get store() { return store },
    gameStore, handlers, registered, modeCalls, sections,
    get skillDir() { return skillDir },
    call: (action, args) => {
      const fn = handlers.get('dsh-tavern-style-library/' + action)
      if (!fn) throw new Error('没有 handle: ' + action)
      return fn(args || {})
    },
  }
}

console.log('\n== 基本接线 ==')

const env = makeEnv(null)
plugin.apply(env.ctx)

await check('注册了 9 个 Agent 工具', () => {
  const names = env.registered.map(item => item.name).sort()
  assert.deepEqual(names, [
    'style_card_get', 'style_card_save',
    'style_library_list', 'style_library_pick', 'style_library_save', 'style_library_split',
    'style_sample_save', 'style_sample_save_many', 'style_tags_update',
  ])
})

await check('工具限定在卡片工作台', () => {
  assert.equal(env.modeCalls.length, 9)
  for (const call of env.modeCalls) assert.deepEqual(call.modes, ['card'])
})

await check('Skill 目录指向插件内 skills/', () => {
  const expected = fileURLToPath(new URL('./skills', import.meta.url))
  assert.equal(env.skillDir, expected)
})

await check('注册了 turnSection', () => {
  assert.equal(env.sections.length, 1)
  assert.equal(env.sections[0].name, 'style-library')
})

console.log('\n== 切段 ==')

// 造一个够长的段落：每个段落约 320 字，明显超过单段下限。
const longPara = tag => Array.from({ length: 16 }, (_, index) =>
  '第' + index + '句用来把' + tag + '这一段撑到足够长，句子本身也有正常的长度和停顿。').join('')

await check('按空行切段（每段都够长）', async () => {
  const text = [longPara('甲'), longPara('乙'), longPara('丙')].join('\n\n')
  const out = await env.call('split', { text, target: 300 })
  assert.ok(out.total >= 2, '应切成至少 2 段，实际 ' + out.total)
  for (const chunk of out.chunks) assert.ok(chunk.text.length > 0)
})

await check('没有空行时按单换行切', async () => {
  const text = [longPara('A'), longPara('B'), longPara('C')].join('\n')
  const out = await env.call('split', { text, target: 300 })
  assert.ok(out.total >= 2, '实际 ' + out.total)
})

await check('每段长度不超过上限', async () => {
  const text = [longPara('甲'), longPara('乙'), longPara('丙'), longPara('丁')].join('\n\n')
  const out = await env.call('split', { text, target: 300 })
  // 上限 = min(1600, 300*1.4) = 420
  for (const chunk of out.chunks) {
    assert.ok(chunk.chars <= 420, '单段不该超过 420，实际 ' + chunk.chars)
  }
})

await check('短文本不硬切（低于下限时整段保留）', async () => {
  const out = await env.call('split', { text: '很短的一段。\n\n也很短的一段。', target: 300 })
  assert.equal(out.total, 1)
})

await check('超长段落回退到句末标点', async () => {
  const sentence = '这是一句话，用来把段落撑得很长很长。'
  const text = sentence.repeat(40) // 约 760 字，无空行无换行
  const out = await env.call('split', { text, target: 300 })
  assert.ok(out.total >= 2, '应至少切 2 段，实际 ' + out.total)
  for (const chunk of out.chunks) {
    assert.ok(chunk.chars <= 1600, '单段不该超过上限，实际 ' + chunk.chars)
    assert.ok('。！？；…'.includes(chunk.text[chunk.text.length - 1]) || chunk.chars <= 420,
      '切断处应是句末（末段除外）')
  }
})

await check('空输入切出 0 段', async () => {
  const out = await env.call('split', { text: '   \n\n  ', target: 500 })
  assert.equal(out.total, 0)
})

await check('切段不丢字（拼接后长度接近原文）', async () => {
  const text = '甲句内容。乙句内容。\n\n丙句内容。丁句内容。'
  const out = await env.call('split', { text, target: 300 })
  const rebuilt = out.chunks.map(item => item.text).join('')
  assert.equal(rebuilt.replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

console.log('\n== Agent 工具行为 ==')

const agentEnv = makeEnv(null)
plugin.apply(agentEnv.ctx)
const tool = name => agentEnv.registered.find(item => item.name === name)

await check('list 在空库时给出提示', async () => {
  const out = await tool('style_library_list').execute({})
  assert.ok(out.text.includes('还没有样文库'))
  assert.ok(Array.isArray(out.tags) && out.tags.length > 10)
})

let libraryId = ''

await check('save 建库返回 id', async () => {
  const out = await tool('style_library_save').execute({ name: '冷峻武侠', tags: ['冷峻', '短句'], note: '测试' })
  libraryId = out.id
  assert.ok(libraryId)
  assert.equal(agentEnv.store.libraries.length, 1)
  assert.equal(agentEnv.store.libraries[0].name, '冷峻武侠')
})

await check('save 拒绝同名库', async () => {
  await assert.rejects(
    () => tool('style_library_save').execute({ name: '冷峻武侠' }),
    /已经有同名样文库/,
  )
})

await check('sample_save 按库名存进库', async () => {
  const out = await tool('style_sample_save').execute({
    library: '冷峻武侠',
    text: '刀光一闪，雪停了。他没有回头，只把刀收进鞘里，血顺着鞘口滴下来。',
    tags: ['冷峻', '短句'],
    source: '测试材料',
  })
  assert.equal(out.count, '1')
  assert.equal(agentEnv.store.libraries[0].samples.length, 1)
  assert.equal(agentEnv.store.libraries[0].samples[0].source, '测试材料')
})

await check('sample_save 按 id 也能定位', async () => {
  const out = await tool('style_sample_save').execute({
    library: libraryId, text: '第二段摘录，用来确认按 id 查找也能工作，内容再长一点点。', tags: ['冷峻'],
  })
  assert.equal(out.count, '2')
})

await check('sample_save 库不存在时报错', async () => {
  await assert.rejects(
    () => tool('style_sample_save').execute({ library: '不存在的库', text: '内容够长够长够长够长够长够长' }),
    /没有样文库/,
  )
})

await check('sample_save 拒绝超长样文', async () => {
  await assert.rejects(
    () => tool('style_sample_save').execute({ library: '冷峻武侠', text: '字'.repeat(2100) }),
    /最多 2000 字/,
  )
})

await check('sample_save 拒绝空样文', async () => {
  await assert.rejects(
    () => tool('style_sample_save').execute({ library: '冷峻武侠', text: '  ' }),
    /样文不能为空/,
  )
})

await check('list 能看到刚建的库和条数', async () => {
  const out = await tool('style_library_list').execute({})
  const found = out.libraries.find(item => item.id === libraryId)
  assert.ok(found)
  assert.equal(found.count, 2)
})

await check('pick 在没有对局时给出温和提示', async () => {
  const out = await tool('style_library_pick').execute({ library: '冷峻武侠' }, { agent: { session: {} } })
  assert.equal(out.ok, false)
  assert.ok(out.text.includes('不在对局'))
})

await check('pick 在有对局时写入选择', async () => {
  const out = await tool('style_library_pick').execute({ library: '冷峻武侠' }, { agent: { session: { id: 'g1' } } })
  assert.equal(out.ok, true)
  assert.equal(agentEnv.gameStore.get('g1').libraryId, libraryId)
})

await check('pick 空库名取消使用', async () => {
  const out = await tool('style_library_pick').execute({ library: '' }, { agent: { session: { id: 'g1' } } })
  assert.equal(out.ok, true)
  assert.equal(agentEnv.gameStore.get('g1').libraryId, '')
})

await check('sample_save 保留旧标签不做同义归并', async () => {
  const lib = agentEnv.store.libraries[0]
  assert.deepEqual(lib.samples[0].tags, ['冷峻', '短句'])
})

console.log('\n== 批量存（长材料别只摘一两段）==')

await check('split 工具能把长材料切开', async () => {
  const text = [longPara('甲'), longPara('乙'), longPara('丙'), longPara('丁')].join('\n\n')
  const out = await tool('style_library_split').execute({ text, target: 300 })
  assert.ok(out.total >= 2, '应切成多段，实际 ' + out.total)
  assert.equal(out.chunks.length, out.total)
  assert.ok(out.chunks[0].chars > 0)
  assert.ok(out.text.includes('切成'))
})

await check('split 工具拒绝空输入', async () => {
  await assert.rejects(() => tool('style_library_split').execute({ text: '   ' }), /空的/)
})

await check('save_many 一次存多条', async () => {
  const before = agentEnv.store.libraries[0].samples.length
  const out = await tool('style_sample_save_many').execute({
    library: '冷峻武侠',
    samples: [
      { text: '批量第一条：风从山口灌下来，吹得火把齐刷刷偏向一边。', tags: ['冷峻'] },
      { text: '批量第二条：他数着自己的呼吸，等第三声马蹄。', tags: ['留白', '短句'] },
      { text: '批量第三条：屋檐在滴水，一滴，两滴，停了。', tags: ['留白'] },
    ],
  })
  assert.equal(out.saved, 3)
  assert.equal(out.count, before + 3)
  assert.equal(agentEnv.store.libraries[0].samples.length, before + 3)
})

await check('save_many 只跳过坏条目，不整批失败', async () => {
  const before = agentEnv.store.libraries[0].samples.length
  const out = await tool('style_sample_save_many').execute({
    library: '冷峻武侠',
    samples: [
      { text: '正常的一条，应该存进去。', tags: ['冷峻'] },
      { text: '   ' },
      { text: '字'.repeat(2100) },
    ],
  })
  assert.equal(out.saved, 1)
  assert.equal(out.skipped.length, 2)
  assert.equal(agentEnv.store.libraries[0].samples.length, before + 1)
})

await check('save_many 全都不合格时明确报错', async () => {
  await assert.rejects(
    () => tool('style_sample_save_many').execute({ library: '冷峻武侠', samples: [{ text: '  ' }] }),
    /一条都没存进去/,
  )
})

await check('save_many 空数组报错', async () => {
  await assert.rejects(
    () => tool('style_sample_save_many').execute({ library: '冷峻武侠', samples: [] }),
    /至少要给一条/,
  )
})

await check('save_many 库不存在时报错', async () => {
  await assert.rejects(
    () => tool('style_sample_save_many').execute({ library: '不存在的库', samples: [{ text: '内容' }] }),
    /没有样文库/,
  )
})

// 真实场景：2 万字的文章按 1500 字左右一条，应该能一次存进十几条。
await check('2 万字材料能一次存进 15 条', async () => {
  const lib = await tool('style_library_save').execute({ name: '长文批量库', tags: ['冷峻'] })
  const body = '他站在崖边，风把衣角吹得贴在身上。远处的灯一盏一盏灭下去，像谁在数着什么。'.repeat(40)
  const samples = Array.from({ length: 15 }, (_, index) => ({
    text: '第' + (index + 1) + '段。' + body.slice(0, 1500),
    tags: ['冷峻'],
    source: '长文第' + (index + 1) + '节',
  }))
  // 总字数接近 2.1 万，和用户遇到的材料规模一致
  const totalChars = samples.reduce((sum, item) => sum + item.text.length, 0)
  assert.ok(totalChars > 20000, '测试材料应大于 2 万字，实际 ' + totalChars)
  const out = await tool('style_sample_save_many').execute({ library: lib.id, samples })
  assert.equal(out.saved, 15, '应全部存入，实际 ' + out.saved)
  assert.equal(out.count, 15)
  const stored = agentEnv.store.libraries.find(item => item.id === lib.id)
  assert.equal(stored.samples.length, 15)
})

console.log('\n== 标签池增删改 ==')

await check('tags_update add 追加标签', async () => {
  const out = await tool('style_tags_update').execute({ action: 'add', tags: ['测试甲', '测试乙'] })
  assert.ok(out.tags.includes('测试甲'))
  assert.ok(out.tags.includes('测试乙'))
  assert.equal(out.added, 2)
})

await check('tags_update 不重复添加已有标签', async () => {
  const out = await tool('style_tags_update').execute({ action: 'add', tags: ['测试甲'] })
  assert.equal(out.added, 0)
  assert.equal(out.tags.filter(tag => tag === '测试甲').length, 1)
})

await check('tags_update rename 同步改掉库和样文上的引用', async () => {
  // store 每次保存都会深拷贝，所以不能直接改对象引用，要走正常接口。
  const list = await agentEnv.call('list')
  const target = list.data.libraries.find(item => item.name === '冷峻武侠')
  const sampleId = target.samples[0].id
  await agentEnv.call('save-library', { library: { id: target.id, name: target.name, tags: ['测试甲', '冷峻'] } })
  await agentEnv.call('save-sample', { libraryId: target.id, sample: { id: sampleId, text: target.samples[0].text, tags: ['测试甲'] } })

  const out = await tool('style_tags_update').execute({ action: 'rename', tag: '测试甲', to: '测试丙' })
  assert.ok(out.tags.includes('测试丙'))
  assert.ok(!out.tags.includes('测试甲'))
  assert.ok(out.touched >= 2, '应同步改掉库和样文上的引用，实际 ' + out.touched)

  const after = (await agentEnv.call('list')).data.libraries.find(item => item.id === target.id)
  assert.deepEqual(after.tags, ['测试丙', '冷峻'])
  assert.deepEqual(after.samples[0].tags, ['测试丙'])
})

await check('tags_update rename 目标已存在时拒绝', async () => {
  await assert.rejects(
    () => tool('style_tags_update').execute({ action: 'rename', tag: '测试丙', to: '冷峻' }),
    /已经有/,
  )
})

await check('tags_update remove 连同引用一起清掉', async () => {
  const out = await tool('style_tags_update').execute({ action: 'remove', tag: '测试丙' })
  assert.ok(!out.tags.includes('测试丙'))
  const after = (await agentEnv.call('list')).data.libraries.find(item => item.name === '冷峻武侠')
  assert.ok(!after.tags.includes('测试丙'), '库上的引用也该清掉')
  assert.ok(!after.samples[0].tags.includes('测试丙'), '样文上的引用也该清掉')
})

await check('tags_update remove 不存在的标签报错', async () => {
  await assert.rejects(
    () => tool('style_tags_update').execute({ action: 'remove', tag: '根本没有这个标签' }),
    /没有/,
  )
})

// 默认标签曾经删不掉：normalize() 每次都从 DEFAULT_TAGS 起手再合并存储，
// 删了「冷峻」→ persist 里又加回来 → 读回来还在。上面几条只测了自定义标签，所以漏了。
await check('默认标签删掉之后不会自己回来', async () => {
  const before = (await agentEnv.call('list')).data.tags
  assert.ok(before.includes('冷峻'), '前提：池子里本来有默认标签「冷峻」')

  const out = await tool('style_tags_update').execute({ action: 'remove', tag: '冷峻' })
  assert.ok(!out.tags.includes('冷峻'), '返回值里就不该再有')
  // 关键是再读一遍存储——persist 会走 normalize，这才是以前复活的地方
  const after = (await agentEnv.call('list')).data.tags
  assert.ok(!after.includes('冷峻'), '存盘再读回来还在，说明 normalize 又把它补回去了')
  // 其余默认标签不受影响
  assert.ok(after.includes('克制'), '不该连别的默认标签一起删掉')
})

await check('把标签全删光后仍然是空的（空列表也要被尊重）', async () => {
  const all = (await agentEnv.call('list')).data.tags
  for (const tag of [...all]) await tool('style_tags_update').execute({ action: 'remove', tag })
  const after = (await agentEnv.call('list')).data.tags
  assert.deepEqual(after, [], '空数组要当成「用户全删了」，不能重新播种默认标签')
})

await check('tags_update set 保留仍在用的标签', async () => {
  const list = await agentEnv.call('list')
  const target = list.data.libraries.find(item => item.name === '冷峻武侠')
  await agentEnv.call('save-library', { library: { id: target.id, name: target.name, tags: ['仍在用的'] } })
  const out = await tool('style_tags_update').execute({ action: 'set', tags: ['新的甲', '新的乙'] })
  assert.ok(out.tags.includes('新的甲'))
  assert.ok(out.tags.includes('新的乙'))
  assert.ok(out.tags.includes('仍在用的'), 'set 不能把还在引用的标签冲掉')
})

await check('tags_update 未知操作报错', async () => {
  await assert.rejects(
    () => tool('style_tags_update').execute({ action: '乱来', tag: 'x' }),
    /不认识的操作/,
  )
})

// SKILL.md 里让 Agent 调的工具名必须真的注册过。
// 之前 SKILL 写了 style_library_split，工具却不存在，Agent 调它只会失败。
await check('只有一个 Skill，且目录名与 frontmatter 一致', () => {
  const dir = fileURLToPath(new URL('./skills', import.meta.url))
  const dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
  // 建库和提炼卡是同一个流程的两段，拆成两个 Skill 会让 Agent 和用户都要多判一次
  // 「现在该用哪个」。合并后只留一个，这条断言防止以后又被拆开。
  assert.equal(dirs.length, 1, '只应有一个 Skill，实际：' + dirs.map(item => item.name).join(', '))
  const file = path.join(dir, dirs[0].name, 'SKILL.md')
  assert.ok(fs.existsSync(file), '缺少 SKILL.md')
  const meta = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  assert.ok(meta, 'SKILL.md 缺少 frontmatter')
  const name = (meta[1].match(/^name:\s*(.+)$/m) || [])[1]
  assert.equal(String(name).trim(), dirs[0].name, 'frontmatter 的 name 必须和目录名一致')
})

await check('SKILL.md 提到的工具都真实存在', () => {
  const dir = fileURLToPath(new URL('./skills', import.meta.url))
  const skills = fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file))
  const registered = new Set(agentEnv.registered.map(item => item.name))
  const missing = []
  let mentioned = 0
  for (const file of skills) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/`(style_[a-z_]+)`/g)) {
      mentioned += 1
      if (!registered.has(match[1])) missing.push(match[1] + '（' + path.basename(path.dirname(file)) + '）')
    }
  }
  assert.ok(mentioned > 0, 'SKILL.md 里没提到任何工具？')
  assert.deepEqual([...new Set(missing)], [], 'SKILL 提到但没注册：' + missing.join(', '))
})

console.log('\n== 注入 ==')

await check('没选中时不注入', async () => {
  const text = await agentEnv.sections[0].text({ gameId: 'g2', input: '随便写点什么' })
  assert.equal(text, '')
})

await check('选中后按库注入', async () => {
  await agentEnv.call('set-active', { gameId: 'g2', libraryId })
  const text = await agentEnv.sections[0].text({ gameId: 'g2', input: '继续' })
  assert.ok(text.includes('【文风参考 · 冷峻武侠'))
  assert.ok(text.includes('只借它的笔调'))
  assert.ok(text.includes('不要照抄任何原句'))
})

await check('#文风 标记优先于本局选中', async () => {
  const other = await agentEnv.call('save-library', { library: { name: '温柔絮语', tags: ['温柔'] } })
  await agentEnv.call('save-sample', {
    libraryId: other.id,
    sample: { text: '窗外的雨下了一夜，她听着，慢慢就睡着了，梦里也是水声。', tags: ['温柔'] },
  })
  const text = await agentEnv.sections[0].text({ gameId: 'g2', input: '#文风 温柔絮语 开始吧' })
  assert.ok(text.includes('温柔絮语'), '应命中标记指定的库，实际：' + text.slice(0, 40))
})

await check('标记命中不到时退回本局选中', async () => {
  const text = await agentEnv.sections[0].text({ gameId: 'g2', input: '#文风 完全不存在的标签 开始' })
  assert.ok(text.includes('冷峻武侠'))
})

console.log('\n== 数据校验与上限 ==')

await check('保存时标签超过 12 个会被截断', async () => {
  const many = Array.from({ length: 20 }, (_, index) => '标' + index)
  const out = await agentEnv.call('save-library', { library: { name: '标签测试', tags: many } })
  const lib = out.data.libraries.find(item => item.name === '标签测试')
  assert.equal(lib.tags.length, 12)
})

await check('库名超长会截断', async () => {
  const out = await agentEnv.call('save-library', { library: { name: '很'.repeat(80) } })
  const lib = out.data.libraries.find(item => item.name.startsWith('很'))
  assert.equal(lib.name.length, 40)
})

await check('重新载入时保留结构', async () => {
  const reloaded = makeEnv(agentEnv.store)
  plugin.apply(reloaded.ctx)
  const list = await reloaded.call('list')
  assert.ok(list.data.libraries.length >= 2)
  assert.equal(list.data.version, 2)
})

await check('坏数据不会让插件崩', async () => {
  const broken = makeEnv({ libraries: [null, 3, { id: 'x' }, { name: '' }, { name: '好的' }], tags: 'not array' })
  plugin.apply(broken.ctx)
  const list = await broken.call('list')
  assert.equal(list.data.libraries.length, 1)
  assert.equal(list.data.libraries[0].name, '好的')
})

console.log('\n== 轮换与换一段 ==')

function makeRotateEnv() {
  let turn = 1
  const env = makeEnv(null)
  env.tavern.getTurnState = async () => ({ turn })
  env.setTurn = value => { turn = value }
  return env
}

const rotEnv = makeRotateEnv()
plugin.apply(rotEnv.ctx)

let rotLibId = ''

await check('建 4 段样的库', async () => {
  const lib = await rotEnv.call('save-library', { library: { name: '轮换库', tags: ['冷峻'] } })
  rotLibId = lib.id
  for (let index = 1; index <= 4; index += 1) {
    await rotEnv.call('save-sample', {
      libraryId: lib.id,
      sample: { text: '这是第' + index + '段样文，用来验证轮换。'.repeat(6), tags: ['冷峻'], source: '书' + index },
    })
  }
  const list = await rotEnv.call('list')
  assert.equal(list.data.libraries.find(item => item.id === rotLibId).samples.length, 4)
})

await check('第 1 轮从第 1 段开始', async () => {
  await rotEnv.call('set-active', { gameId: 'r1', libraryId: rotLibId })
  rotEnv.setTurn(1)
  const status = await rotEnv.call('status', { gameId: 'r1' })
  assert.equal(status.index, 1)
  assert.equal(status.total, 4)
})

await check('逐轮轮换，四轮走完一轮回到起点', async () => {
  const seen = []
  for (const turn of [1, 2, 3, 4, 5]) {
    rotEnv.setTurn(turn)
    const status = await rotEnv.call('status', { gameId: 'r1' })
    seen.push(status.index)
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 1], '实际：' + seen.join(','))
})

await check('同一轮重复读拿到同一段（重试不会跳）', async () => {
  rotEnv.setTurn(2)
  const first = await rotEnv.call('status', { gameId: 'r1' })
  const second = await rotEnv.call('status', { gameId: 'r1' })
  assert.equal(first.index, second.index)
})

await check('钉住某一条后不再轮换', async () => {
  const list = await rotEnv.call('list')
  const lib = list.data.libraries.find(item => item.id === rotLibId)
  const pinned = lib.samples[2]
  await rotEnv.call('set-active', { gameId: 'r2', libraryId: rotLibId, sampleId: pinned.id })
  for (const turn of [1, 2, 3]) {
    rotEnv.setTurn(turn)
    const status = await rotEnv.call('status', { gameId: 'r2' })
    assert.equal(status.index, 3, '第 ' + turn + ' 轮应仍是第 3 段，实际 ' + status.index)
  }
})

await check('rotate 跳到下一段', async () => {
  rotEnv.setTurn(1)
  await rotEnv.call('set-active', { gameId: 'r3', libraryId: rotLibId })
  const before = await rotEnv.call('status', { gameId: 'r3' })
  const out = await rotEnv.call('rotate', { gameId: 'r3' })
  assert.equal(out.ok, true)
  assert.notEqual(out.index, before.index, '换一段后应换到别的段')
})

// 真环境里 getTurnState 一直可用，turnOf 每次都用宿主轮次覆盖 rotationSeed。
// 所以位移必须存进对局数据，否则连按两次会一直在原地（这正是线上没反应的原因）。
await check('连按换一段，每次都真的变', async () => {
  rotEnv.setTurn(1)
  await rotEnv.call('set-active', { gameId: 'r6', libraryId: rotLibId })
  const seen = []
  for (let i = 0; i < 4; i++) {
    const out = await rotEnv.call('rotate', { gameId: 'r6' })
    assert.equal(out.ok, true, '第 ' + (i + 1) + ' 次换一段失败')
    seen.push(out.sampleId)
  }
  assert.equal(new Set(seen).size, 4, '四次换一段应经过四段不同样文，实际：' + seen.join(','))
})

await check('换完之后预览跟着变（不是只改了内部变量）', async () => {
  rotEnv.setTurn(1)
  await rotEnv.call('set-active', { gameId: 'r7', libraryId: rotLibId })
  const a = await rotEnv.call('preview', { gameId: 'r7', input: '' })
  await rotEnv.call('rotate', { gameId: 'r7' })
  const b = await rotEnv.call('preview', { gameId: 'r7', input: '' })
  assert.notEqual(a.sample, b.sample, '换一段后 preview 取到的应换了一条')
})

await check('同轮重读仍是换过的那一段（位移不会丢）', async () => {
  const again = await rotEnv.call('preview', { gameId: 'r7', input: '' })
  const second = await rotEnv.call('preview', { gameId: 'r7', input: '' })
  assert.equal(again.sample, second.sample, '同一轮读两次应一致')
})

await check('换库时位移归零，新库从第一段起', async () => {
  rotEnv.setTurn(1)
  const lib = await rotEnv.call('save-library', { library: { name: '另一个库', tags: [] } })
  for (const text of ['甲段样文内容，用来占位。', '乙段样文内容，用来占位。', '丙段样文内容，用来占位。']) {
    await rotEnv.call('save-sample', { libraryId: lib.id, sample: { text: text.repeat(4) } })
  }
  await rotEnv.call('set-active', { gameId: 'r8', libraryId: rotLibId })
  await rotEnv.call('rotate', { gameId: 'r8' })
  await rotEnv.call('rotate', { gameId: 'r8' })
  await rotEnv.call('set-active', { gameId: 'r8', libraryId: lib.id })
  const out = await rotEnv.call('preview', { gameId: 'r8', input: '' })
  assert.equal(out.sampleIndex, 1, '换库后应回到第 1 段，实际第 ' + out.sampleIndex + ' 段')
})

await check('没选库时换一段给出提示而不是抛错', async () => {
  const out = await rotEnv.call('rotate', { gameId: 'r9' })
  assert.equal(out.ok, false)
  assert.ok(out.text.includes('还没选'), '应提示先选库，实际：' + out.text)
})

await check('preview 单独给出纯原文，面板不显示规则说明', async () => {
  const lib = await rotEnv.call('save-library', { library: { name: '预览用库', tags: [] } })
  const text = '雪落在刀鞘上，没有声音。他把手从袖子里抽出来，指节发白。'
  await rotEnv.call('save-sample', { libraryId: lib.id, sample: { text } })
  await rotEnv.call('set-active', { gameId: 'r10', libraryId: lib.id })
  const out = await rotEnv.call('preview', { gameId: 'r10', input: '' })
  // 原文照原样给出，一个字不加
  assert.equal(out.sampleText, text, 'sampleText 应当就是原文本身')
  // 注入用的 text 仍要带规则说明——那是给模型的，不能跟着一起去掉
  assert.ok(out.text.includes(text), '注入文本里应有原文')
  assert.ok(out.text.includes('只借它的笔调'), '注入文本仍要带「只借笔调」的规则')
  assert.ok(out.text.includes('不要借它的情节'), '注入文本仍要带「不借情节」的规则')
  assert.ok(!out.sampleText.includes('只借它的笔调'), 'sampleText 里不该混进规则说明')
})

await check('单段库换一段时明确拒绝', async () => {
  const lib = await rotEnv.call('save-library', { library: { name: '单段库', tags: [] } })
  await rotEnv.call('save-sample', { libraryId: lib.id, sample: { text: '只有一段的样文内容，用来验证换不了的情况。'.repeat(2) } })
  await rotEnv.call('set-active', { gameId: 'r4', libraryId: lib.id })
  const out = await rotEnv.call('rotate', { gameId: 'r4' })
  assert.equal(out.ok, false)
  assert.ok(out.text.includes('只有一段'))
})

await check('unpin 回到轮换', async () => {
  const list = await rotEnv.call('list')
  const lib = list.data.libraries.find(item => item.id === rotLibId)
  await rotEnv.call('set-active', { gameId: 'r5', libraryId: rotLibId, sampleId: lib.samples[1].id })
  await rotEnv.call('unpin', { gameId: 'r5' })
  rotEnv.setTurn(1)
  const status = await rotEnv.call('status', { gameId: 'r5' })
  assert.equal(status.index, 1, '解开钉住后第 1 轮应回到第 1 段')
})

await check('没有 getTurnState 时仍会换（内部计数）', async () => {
  const env = makeEnv(null)
  plugin.apply(env.ctx) // 这个 env 没有 getTurnState
  const lib = await env.call('save-library', { library: { name: '退路库', tags: [] } })
  for (let index = 1; index <= 3; index += 1) {
    await env.call('save-sample', { libraryId: lib.id, sample: { text: '退路测试第' + index + '段，内容需要足够长一些。'.repeat(3) } })
  }
  await env.call('set-active', { gameId: 'x1', libraryId: lib.id })
  const seen = new Set()
  for (let index = 0; index < 3; index += 1) {
    const text = await env.sections[0].text({ gameId: 'x1', input: '' })
    // 用整段比较：三段的开头文字相同，只看前缀会误判为同一条。
    seen.add(text)
  }
  assert.ok(seen.size >= 2, '应该换过段，实际只看到 ' + seen.size + ' 种')
})

await check('状态分节在没选库时给出提示', async () => {
  const status = await rotEnv.call('status', { gameId: 'empty-game' })
  assert.equal(status.on, false)
  assert.ok(status.hint)
})

await check('状态分节标出 #文风 标记来源', async () => {
  rotEnv.setTurn(1)
  await rotEnv.call('set-active', { gameId: 'r6', libraryId: rotLibId })
  const status = await rotEnv.call('status', { gameId: 'r6', input: '#文风 轮换库 继续' })
  assert.equal(status.via, 'marker')
  assert.equal(status.markerTag, '轮换库')
})

console.log('\n== 子作用域兼容（Cordis 给的是 childContext）==')

await check('只有 ctx.get 时也能拿到 tavern 和 tools', async () => {
  const registered = []
  const tools = { register: definition => { registered.push(definition.name); return () => {} } }
  const tavern = {
    apiVersion: 2, handle() {}, turnSection() {}, toolModes() {}, readPluginData: async () => null,
    savePluginData: async () => {}, skillSource() { return () => {} },
  }
  const childCtx = {
    get: key => (key === 'tools' ? tools : key === 'tavern' ? tavern : undefined),
    effect: fn => fn(),
  }
  plugin.apply(childCtx, {})
  assert.equal(registered.length, 9, '应注册 9 个工具，实际 ' + registered.length)
})

console.log('\n== 风格卡（7+1 维度提炼）==')

const cardEnv = makeEnv(null)
plugin.apply(cardEnv.ctx)
const cardTool = name => cardEnv.registered.find(item => item.name === name)

// 一份「模型可能给出的」形状：维度键混中英、基因是字符串、还带了一堆多余字段。
const rawCard = {
  author: '沈从文',
  genre: '乡土小说',
  体裁: '短篇',
  summary: '句子短促，名词多动词少，情绪压在景物后面。',
  dimensions: {
    词汇: ['多用单音节动词，如「落」「沉」「贴」', '几乎没有形容词堆叠'],
    syntactic: ['平均句长 11 字，七成句子在 8 字以内', '破折号极少，几乎不用感叹号'],
    语气: ['通篇低音量，不解释，不抒情'],
    感官: ['视觉为主，听觉次之，几乎不写嗅觉'],
    对话: ['对白短，多为一句，提示语常省略'],
    胡说: ['这条不是维度，应该被丢掉'],
  },
  genes: ['留白呼吸：句子之间留空，情绪由停顿承担', '景物先行：先写景再写人，人不解释自己'],
  laws: ['每段至少一个具体可触的物件', '不写「他心里想」这类内心独白'],
  disallowed: ['不用「不由得」「心中五味杂陈」', '不写总结性收尾'],
  aiBan: ['不由得', '心中五味杂陈', '一丝不易察觉'],
  mantra: '先看见，再说话。',
  match: 82,
}

await check('card_save 收下形状不规整的卡', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '卡测试库' } })
  for (const text of [
    '雪落在刀鞘上，没有声音。他把手从袖子里抽出来，指节发白。',
    '屋檐在滴水，一滴，两滴，停了。远处的灯一盏一盏灭下去。',
  ]) await cardEnv.call('save-sample', { libraryId: lib.id, sample: { text } })
  const out = await cardTool('style_card_save').execute({ library: '卡测试库', card: rawCard })
  assert.equal(out.ok, true)
  const card = cardEnv.store.libraries.find(item => item.id === lib.id).card
  assert.ok(card, '卡没存上')
  // 中文维度键要落到英文键上，「胡说」这种不认识的键要丢掉
  assert.deepEqual(Object.keys(card.dimensions).sort(),
    ['dialogue', 'imagery', 'lexical', 'syntactic', 'tonal'])
  // 字符串基因按「名称：说明」拆开
  assert.equal(card.genes.length, 2)
  assert.equal(card.genes[0].name, '留白呼吸')
  assert.ok(card.genes[0].text.includes('情绪由停顿承担'))
  assert.equal(card.aiBan.length, 3)
  assert.equal(card.match, 82)
  assert.ok(out.text.includes('风格卡已存进'))
})

await check('card_save 拒收空卡', async () => {
  await assert.rejects(
    () => cardTool('style_card_save').execute({ library: '卡测试库', card: { author: '某人' } }),
    /风格卡是空的/,
  )
})

// summary 只是把维度观察换个说法，单独存在的话注入出去只有一行标题。
await check('只有指纹小结的卡不算卡', async () => {
  await assert.rejects(
    () => cardTool('style_card_save').execute({ library: '卡测试库', card: { summary: '句子短，少解释。' } }),
    /风格卡是空的/,
  )
})

// 字段上限（9 维 × 5 条 × 140 字 + 铁律 + 禁用 + AI 腔）写满会到 30 KB 左右，
// 字节上限 24 KB 是兜底。造一张真的写满的卡来测这条兜底。
function maxedCard(serialStart = 0) {
  let serial = serialStart
  const next = () => { serial += 1; return serial }
  // 序号要放**前面**：每条会被截到上限字数，序号在结尾的话五条会截成一模一样，
  // 先去重就只剩一条，这张卡根本撑不到测试想测的大小。
  const line = chars => next() + '字'.repeat(chars)
  return {
    dimensions: Object.fromEntries(['lexical', 'syntactic', 'tonal', 'discourse', 'rhetoric', 'emotion', 'perspective', 'imagery', 'dialogue']
      .map(key => [key, Array.from({ length: 5 }, () => line(140))])),
    genes: Array.from({ length: 5 }, () => ({ name: '基' + next(), text: line(140) })),
    laws: Array.from({ length: 10 }, () => line(120)),
    disallowed: Array.from({ length: 10 }, () => line(120)),
    aiBan: Array.from({ length: 20 }, () => line(24)),
    summary: line(300),
  }
}

await check('card_save 拒收写满也放不下的卡', async () => {
  await assert.rejects(
    () => cardTool('style_card_save').execute({ library: '卡测试库', card: maxedCard() }),
    /风格卡太长/,
  )
})

// 试写只回给面板看，不落盘。存进去的话，「改卡 → 再试」会越试越挤，
// 最后在花掉一次模型调用之后才报「卡太长」。
await check('试写不写进卡（卡不会被越试越大）', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '试写库' } })
  await cardEnv.call('save-sample', { libraryId: lib.id, sample: { text: '一条普通摘录，内容足够长一点点就行。' } })
  await cardEnv.call('card-save', { libraryId: lib.id, card: rawCard })
  const sizeOf = () => Buffer.byteLength(JSON.stringify(
    cardEnv.store.libraries.find(item => item.id === lib.id).card,
  ))
  const before = sizeOf()

  cardEnv.tavern.runTask = async () => ({ text: '【试写】\n雪停了。\n【自评】\n综合匹配度：77%' })
  const out = await cardEnv.call('card-test', { gameId: 'c-big', libraryId: lib.id })
  assert.ok(out.text.includes('雪停了'), '试写内容要照常返回')
  assert.equal(out.match, 77)
  assert.equal(sizeOf(), before, '卡不该因为试写变大')
  assert.equal(out.card.tested, undefined, '卡里不该再留试写正文')
})

await check('card_get 读回卡和注入方式', async () => {
  const out = await cardTool('style_card_get').execute({ library: '卡测试库' })
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'sample')
  assert.ok(out.card)
  assert.ok(out.text.includes('词汇'), '提要里应有维度行')
})

await check('card_get 在没有卡时给出提示', async () => {
  await cardEnv.call('save-library', { library: { name: '还没提炼的库' } })
  const out = await cardTool('style_card_get').execute({ library: '还没提炼的库' })
  assert.equal(out.ok, false)
  // 输出 schema 声明 card 是 object，这里给空对象而不是 null
  assert.deepEqual(out.card, {})
  assert.ok(out.text.includes('还没有风格卡'))
})

await check('list 标出哪些库有风格卡', async () => {
  const out = await cardTool('style_library_list').execute({})
  const found = out.libraries.find(item => item.name === '卡测试库')
  assert.equal(found.hasCard, true)
  assert.equal(found.cardMatch, 82)
  assert.ok(out.text.includes('有风格卡'))
})

console.log('\n== 注入：摘录、风格卡、两者 ==')

const cardLibId = cardEnv.store.libraries.find(item => item.name === '卡测试库').id

await check('默认仍然只注入摘录（老行为不变）', async () => {
  await cardEnv.call('set-active', { gameId: 'c1', libraryId: cardLibId })
  const text = await cardEnv.sections[0].text({ gameId: 'c1', input: '继续' })
  assert.ok(text.includes('【文风参考 · 卡测试库'))
  assert.ok(text.includes('参考原文：'))
  assert.ok(!text.includes('风格卡'), '没设模式时不该自己把卡塞进来')
})

await check('mode=both 时卡在前、原文在后', async () => {
  await cardEnv.call('save-library', { library: { id: cardLibId, name: '卡测试库', mode: 'both' } })
  await cardEnv.call('set-active', { gameId: 'c2', libraryId: cardLibId })
  const text = await cardEnv.sections[0].text({ gameId: 'c2', input: '继续' })
  assert.ok(text.includes('■ 风格卡'), '应有风格卡段')
  assert.ok(text.includes('写作基因：'), '应有写作基因')
  assert.ok(text.includes('AI 腔'), '应有 AI 腔黑名单')
  assert.ok(text.includes('参考原文：'), 'both 模式仍要带原文')
  assert.ok(text.indexOf('■ 风格卡') < text.indexOf('参考原文：'), '卡应排在原文前面')
  assert.ok(text.includes('只借它的笔调'))
})

await check('mode=card 时只给卡，不给原文', async () => {
  await cardEnv.call('save-library', { library: { id: cardLibId, name: '卡测试库', mode: 'card' } })
  await cardEnv.call('set-active', { gameId: 'c3', libraryId: cardLibId })
  const text = await cardEnv.sections[0].text({ gameId: 'c3', input: '继续' })
  assert.ok(text.includes('■ 风格卡'))
  assert.ok(!text.includes('参考原文：'), 'card 模式不该再塞原文')
})

await check('注入总长不超过上限', async () => {
  const text = await cardEnv.sections[0].text({ gameId: 'c4', input: '继续' })
  assert.ok(text.length <= 7800, '实际 ' + text.length)
})

// summary 和维度条目说的是同一件事。每轮都重复一遍，等于把预算花两次——
// 注入里只留维度/基因/铁律/禁用，summary 留给面板和导出的 Prompt。
await check('注入里不带指纹小结，导出的 Prompt 里有', async () => {
  await cardEnv.call('set-active', { gameId: 'c2', libraryId: cardLibId })
  const text = await cardEnv.sections[0].text({ gameId: 'c2', input: '继续' })
  assert.ok(text.includes('词汇：'), '前提：注入里应该有维度行')
  assert.ok(!text.includes('句子短促，名词多动词少'), '指纹小结又被塞进注入了')
  const out = await cardEnv.call('export-prompt', { libraryId: cardLibId })
  assert.ok(out.text.includes('句子短促，名词多动词少'), '导出的 Prompt 里应该有指纹小结')
})

await check('status 在只用卡时用卡提要顶替引文', async () => {
  await cardEnv.call('set-active', { gameId: 'c5', libraryId: cardLibId })
  const status = await cardEnv.call('status', { gameId: 'c5' })
  assert.equal(status.on, true)
  assert.equal(status.card, true)
  assert.ok(status.quote.length > 0, '没有摘录可显示时也要有内容可看')
  assert.ok(!status.quote.includes('参考原文'))
})

await check('card 模式下「换一段」给出解释而不是静默', async () => {
  const out = await cardEnv.call('rotate', { gameId: 'c5' })
  assert.equal(out.ok, false)
  assert.ok(out.text.includes('只用风格卡'))
})

await check('清掉卡之后模式回到只用摘录', async () => {
  await cardEnv.call('card-clear', { libraryId: cardLibId })
  const lib = cardEnv.store.libraries.find(item => item.id === cardLibId)
  assert.equal(lib.card, null)
  assert.equal(lib.mode, 'sample')
  await cardEnv.call('set-active', { gameId: 'c6', libraryId: cardLibId })
  const text = await cardEnv.sections[0].text({ gameId: 'c6', input: '' })
  assert.ok(text.includes('参考原文：'))
  assert.ok(!text.includes('■ 风格卡'))
})

await check('只用风格卡、一条摘录都没有的库也能用', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '纯卡库', mode: 'card' } })
  await cardEnv.call('card-save', { libraryId: lib.id, card: rawCard })
  await cardEnv.call('set-active', { gameId: 'c7', libraryId: lib.id })
  const text = await cardEnv.sections[0].text({ gameId: 'c7', input: '' })
  assert.ok(text.includes('■ 风格卡'), '没有摘录时应该只靠卡也能注入')
  const status = await cardEnv.call('status', { gameId: 'c7' })
  assert.equal(status.on, true)
})

// 摘录被删光但卡还在：'both' 这一档应该退化成只注入卡，而不是整段消失。
// 之前 resolveFor 拿 cardOnly（只认 mode==='card'）判可用性，这里会静默什么都不注入。
await check('「摘录＋卡」的库把摘录删光后，仍然注入卡', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '掉档库', mode: 'both' } })
  await cardEnv.call('save-sample', {
    libraryId: lib.id,
    sample: { text: '这条摘录待会儿会被删掉，先用来确认它确实进过注入。' },
  })
  await cardEnv.call('card-save', { libraryId: lib.id, card: rawCard })
  await cardEnv.call('set-active', { gameId: 'c9x', libraryId: lib.id })

  const before = await cardEnv.sections[0].text({ gameId: 'c9x', input: '' })
  assert.ok(before.includes('参考原文：'), '前提：应该有摘录')

  const sampleId = cardEnv.store.libraries.find(item => item.id === lib.id).samples[0].id
  await cardEnv.call('delete-sample', { libraryId: lib.id, sampleId })

  const after = await cardEnv.sections[0].text({ gameId: 'c9x', input: '' })
  assert.ok(after.includes('■ 风格卡'), '摘录没了，卡应该还在')
  assert.ok(!after.includes('参考原文：'), '没有摘录了就不该再有原文段')
})

await check('pick 在「没摘录 + 只用摘录」时给出可操作的提示', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '空摘录有卡库', mode: 'sample' } })
  await cardEnv.call('card-save', { libraryId: lib.id, card: rawCard })
  await assert.rejects(
    () => cardTool('style_library_pick').execute({ library: '空摘录有卡库' }, { agent: { session: { id: 'g1' } } }),
    /改成「摘录＋风格卡」/,
  )
})

console.log('\n== 让模型提炼 / 盲测 / 导出 ==')
await check('card-distill 调模型、并按库里真实语料回填 corpus', async () => {
  cardEnv.tavern.runTask = async () => ({ text: '```json\n' + JSON.stringify(rawCard) + '\n```' })
  const lib = cardEnv.store.libraries.find(item => item.name === '卡测试库')
  const out = await cardEnv.call('card-distill', { gameId: 'c8', libraryId: lib.id })
  assert.ok(out.card, '应解析出卡')
  assert.equal(out.card.corpus.articles, 2, '篇数应取库里的摘录条数')
  assert.ok(out.card.corpus.chars > 0)
  assert.equal(out.card.author, '沈从文')
})

await check('card-distill 在模型给不出 JSON 时明确报错', async () => {
  cardEnv.tavern.runTask = async () => ({ text: '好的，我来分析一下这段文字的风格。' })
  await assert.rejects(
    () => cardEnv.call('card-distill', { gameId: 'c8', libraryId: cardLibId }),
    /模型没有给出可用的风格卡/,
  )
})

await check('card-distill 没有样文时先报错', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '空材料库' } })
  await assert.rejects(
    () => cardEnv.call('card-distill', { gameId: 'c8', libraryId: lib.id }),
    /还没有样文/,
  )
})

await check('card-test 解析自评匹配度并存进卡', async () => {
  cardEnv.tavern.runTask = async () => ({
    text: '【试写】\n雪停了。他数着自己的呼吸。\n【自评】\n词汇 ★★★★☆ 句法 ★★★★★\n综合匹配度：87%',
  })
  const out = await cardEnv.call('card-test', { gameId: 'c9', libraryId: cardLibId })
  assert.equal(out.match, 87)
  assert.ok(out.text.includes('雪停了'))
  assert.ok(!out.text.includes('【自评】'), '自评段落不该混进试写正文')
  const lib = cardEnv.store.libraries.find(item => item.id === cardLibId)
  assert.equal(lib.card.match, 87, '匹配度应存进卡里')
})

await check('export-prompt 拼出可直接用的风格 Prompt', async () => {
  const out = await cardEnv.call('export-prompt', { libraryId: cardLibId })
  assert.ok(out.text.startsWith('# 写作风格 Prompt'))
  for (const part of ['## 身份', '## 铁律', '## 风格参考卡', '## 写作基因', '## 禁用清单', '## AI 腔黑名单']) {
    assert.ok(out.text.includes(part), '缺少 ' + part)
  }
  assert.ok(out.text.includes('先看见，再说话'), '口诀应写进身份段')
})

await check('export-prompt 在没有卡时明确拒绝', async () => {
  const lib = await cardEnv.call('save-library', { library: { name: '无卡导出库' } })
  await assert.rejects(() => cardEnv.call('export-prompt', { libraryId: lib.id }), /还没有风格卡/)
})

await check('卡能穿过来回存读（重新载入后仍在）', async () => {
  const reloaded = makeEnv(cardEnv.store)
  plugin.apply(reloaded.ctx)
  const list = await reloaded.call('list')
  const found = list.data.libraries.find(item => item.id === cardLibId)
  assert.ok(found.card, '重新载入后卡应还在')
  assert.ok(Object.keys(found.card.dimensions).length >= 5)
})

console.log('\n结果：' + pass + ' 通过，' + fails.length + ' 失败\n')
if (fails.length) {
  for (const item of fails) console.log(item.name + '\n' + (item.error?.stack || item.error))
  process.exit(1)
}
