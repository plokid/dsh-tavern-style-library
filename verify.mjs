// 宿主侧验证：用假的 tavern / tools 服务跑真实代码路径。
// 验证切段规则、Agent 工具注册、工具行为、Skill 路径。
// 用法：node verify.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
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

await check('注册了 7 个 Agent 工具', () => {
  const names = env.registered.map(item => item.name).sort()
  assert.deepEqual(names, [
    'style_library_list', 'style_library_pick', 'style_library_save', 'style_library_split',
    'style_sample_save', 'style_sample_save_many', 'style_tags_update',
  ])
})

await check('工具限定在卡片工作台', () => {
  assert.equal(env.modeCalls.length, 7)
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
await check('SKILL.md 提到的工具都真实存在', () => {
  const skill = fs.readFileSync('./skills/create-style-library/SKILL.md', 'utf8')
  const mentioned = new Set([...skill.matchAll(/`(style_[a-z_]+)`/g)].map(match => match[1]))
  assert.ok(mentioned.size > 0, 'SKILL.md 里没提到任何工具？')
  const registered = new Set(agentEnv.registered.map(item => item.name))
  const missing = [...mentioned].filter(name => !registered.has(name))
  assert.deepEqual(missing, [], 'SKILL 提到但没注册：' + missing.join(', '))
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
  assert.equal(registered.length, 7, '应注册 7 个工具，实际 ' + registered.length)
})

console.log('\n结果：' + pass + ' 通过，' + fails.length + ' 失败\n')
if (fails.length) {
  for (const item of fails) console.log(item.name + '\n' + (item.error?.stack || item.error))
  process.exit(1)
}
