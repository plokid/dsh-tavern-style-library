// dsh-tavern-style-library — 宿主侧
//
// 自建参考样文库：把小说摘录按笔调标签归档；游玩时把选中的样文通过 turnSection
// 注入本轮正文请求，让正文借它的笔调。
//
// 只用 Tavern 公开插件接口（docs/plugin-api*.md）。不改 Tavern 源码，不读 Tavern 数据文件。
//
// 建库两条路，和「创建 Skill」一致：
//   1. 面板手工贴（小量、单条）
//   2. 卡片工作台里让 Agent 做：Agent 已能从上下文读到你在「剧本与素材库」引用的材料，
//      由它负责切段和打标签，再调用本插件的 style_sample_save 存进来。
//      插件不自己读素材库——那是 Tavern 的内部目录，接口没开放。
//
// 数据：savePluginData → plugin-data/dsh-tavern-style-library.json（全局，跨局共享）
// 本局选中：saveGameData → 每局一份 { libraryId, sampleId }
// 注入：tavern.turnSection（每轮算一次，不破坏提示词缓存）

import { fileURLToPath } from 'node:url'

export const name = 'dsh-tavern-style-library'
export const inject = ['tavern', 'tools']

const API_MIN = 2
const VERSION = 2
const MAX_LIBRARY_NAME = 40
const MAX_TAG_LENGTH = 16
const MAX_TAGS_PER_ITEM = 12
const MAX_TAGS_POOL = 200
const MAX_SAMPLE_CHARS = 2000
const MIN_SAMPLE_CHARS = 40
const MAX_SAMPLES_PER_LIBRARY = 40
const MAX_LIBRARIES = 60
const MAX_SECTION_CHARS = 7800
const DATA_BUDGET = 250 * 1024

// 默认标签偏笔调，题材标签由用户自己加。
export const DEFAULT_TAGS = [
  '冷峻', '克制', '炽热', '反讽', '温柔', '疏离',
  '短句', '长句', '绵长', '留白', '白描', '细描',
  '口语', '文白', '书面', '絮语',
  '第一人称', '第三人称限知', '全知',
  '对白为主', '叙述为主',
]

// 正文里写 #文风 冷峻 —— 本轮临时指定笔调，优先级高于本局选中。
const MARKER = /#文风\s*[:：]?\s*([^\s#，,。;；!！?？、]+)/u

const str = value => (typeof value === 'string' ? value : '')

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function cleanTagList(value, max) {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const item of list) {
    const tag = str(item).trim().replace(/\s+/g, '').slice(0, MAX_TAG_LENGTH)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= max) break
  }
  return out
}

// 单个库或单条样文上的标签：最多 12 个。
function cleanTags(value) {
  return cleanTagList(value, MAX_TAGS_PER_ITEM)
}

function cleanSamples(value) {
  const list = Array.isArray(value) ? value : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const text = str(item.text).trim()
    if (!text) continue
    out.push({
      id: str(item.id).slice(0, 64) || newId(),
      text: text.slice(0, MAX_SAMPLE_CHARS),
      source: str(item.source).trim().slice(0, 120),
      tags: cleanTags(item.tags),
    })
    if (out.length >= MAX_SAMPLES_PER_LIBRARY) break
  }
  return out
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  // 默认标签只在**第一次使用**（还没有任何数据）时播种一次。
  //
  // 之前是无条件从 DEFAULT_TAGS 起手再合并存储里的，后果是默认标签永远删不掉：
  // 删掉「冷峻」→ persist 里 normalize 又把它加回来 → 存盘 → 读回来它还在。
  // 用户看到的就是「点了确认删除，标签没少」。
  // 判据用 Array.isArray(src.tags)：只要存过一份带 tags 的数组（哪怕是空的），
  // 就以它为准；空数组代表「用户把默认标签全删了」，要尊重。
  const seeded = Array.isArray(src.tags)
  const tags = seeded ? [] : [...DEFAULT_TAGS]
  for (const tag of cleanTagList(src.tags, MAX_TAGS_POOL)) if (!tags.includes(tag)) tags.push(tag)

  const libraries = []
  const seen = new Set()
  for (const item of Array.isArray(src.libraries) ? src.libraries : []) {
    if (!item || typeof item !== 'object') continue
    const libraryName = str(item.name).trim().slice(0, MAX_LIBRARY_NAME)
    if (!libraryName) continue
    const id = str(item.id).slice(0, 64) || newId()
    if (seen.has(id)) continue
    seen.add(id)
    libraries.push({
      id,
      name: libraryName,
      tags: cleanTags(item.tags),
      note: str(item.note).trim().slice(0, 200),
      samples: cleanSamples(item.samples),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
    })
    if (libraries.length >= MAX_LIBRARIES) break
  }
  return { version: VERSION, tags, libraries }
}

// wantedSampleId 是对局数据里钉住的那一条；seed 让同一库在不同轮次换用不同样文。
// extra 是手动「换一段」累计的位移，会随对局数据存下来，所以换了之后下一轮起真的变了。
// 钉住一条（用户在面板里点过某条）时永远用它，不参与轮换。
function sampleFor(library, wantedSampleId, seed, extra = 0) {
  if (!library || library.samples.length === 0) return null
  if (wantedSampleId) {
    const wanted = library.samples.find(item => item.id === wantedSampleId)
    if (wanted) return wanted
  }
  // 和库标签有交集的优先，在交集里轮换；交集为空就整个库轮换。
  // 用 seed-1 让第 1 轮从第一条开始，再加上手动换过的位移。
  const shared = library.samples.filter(item => item.tags.some(tag => library.tags.includes(tag)))
  const pool = shared.length ? shared : library.samples
  const base = Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) - 1 : 0
  const shift = Number.isFinite(Number(extra)) ? Math.trunc(Number(extra)) : 0
  const offset = ((base + shift) % pool.length + pool.length) % pool.length
  return pool[offset]
}

/** 手动位移之后，这一条在这个库的候选池里排第几（1 起）。 */
function indexInPool(library, sample) {
  if (!library || !sample) return { index: 0, total: 0 }
  const shared = library.samples.filter(item => item.tags.some(tag => library.tags.includes(tag)))
  const pool = shared.length ? shared : library.samples
  return { index: pool.findIndex(item => item.id === sample.id) + 1, total: pool.length }
}

function resolveByTag(data, tag, seed, extra = 0) {
  const exact = data.libraries.find(item => item.name === tag)
  if (exact) return { library: exact, sample: sampleFor(exact, '', seed, extra) }
  const byLibraryTag = data.libraries.find(item => item.tags.includes(tag))
  if (byLibraryTag) return { library: byLibraryTag, sample: sampleFor(byLibraryTag, '', seed, extra) }
  for (const library of data.libraries) {
    const hit = library.samples.find(item => item.tags.includes(tag))
    if (hit) return { library, sample: hit }
  }
  return {}
}

function sectionText(library, sample) {
  const head = '【文风参考 · ' + library.name + (sample.tags.length ? ' · ' + sample.tags.join('／') : '') + '】'
  const rule = '下面这段是参考原文，只借它的笔调：句子的长短与节奏、留白的位置、用词的质感和克制程度。'
    + '\n不要借它的情节、人物、名字，不要照抄任何原句，也不要在正文里提到它或它的出处。'
  const body = '参考原文：\n' + sample.text
  const text = [head, rule, body].join('\n')
  return text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS) : text
}

function parseTags(text) {
  const raw = str(text)
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  let list = null
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(raw.slice(start, end + 1))
      if (Array.isArray(value)) list = value
    } catch { list = null }
  }
  if (!list) {
    const quoted = raw.match(/[「『"“]([^」』"”]{1,12})[」』"”]/gu)
    if (quoted) list = quoted.map(item => item.replace(/[「『"“」』"”]/gu, ''))
  }
  if (!list) list = raw.split(/[,，、\n]/u)
  const out = []
  for (const item of list) {
    const tag = str(item).trim().replace(/^[-*\d.、\s]+/u, '').replace(/\s+/g, '').slice(0, MAX_TAG_LENGTH)
    if (!tag) continue
    if (out.includes(tag)) continue
    out.push(tag)
    if (out.length >= 5) break
  }
  return out
}

// ── 切片：给 Agent 用的一版，按空行/段落分组，标点回退 ──────────────
// 和 Tavern 自己的剧本切片同思路（domain/script-chunks.js），但不依赖它：
// 插件不能 import Tavern 内部模块。
function splitParagraphs(text, target) {
  const source = str(text).replace(/\r\n?/gu, '\n').trim()
  if (!source) return []
  const size = Math.min(1200, Math.max(300, Number(target) || 500))
  const minSize = Math.max(200, Math.round(size * 0.7))
  const maxSize = Math.min(1600, Math.round(size * 1.4))

  // 先按空行切段；没有空行就按单换行。
  let blocks = source.split(/\n{2,}/u).map(item => item.trim()).filter(Boolean)
  if (blocks.length <= 1) blocks = source.split(/\n/u).map(item => item.trim()).filter(Boolean)

  const out = []
  let buffer = ''
  const flush = () => {
    const value = buffer.trim()
    if (value) out.push(value)
    buffer = ''
  }

  for (const block of blocks) {
    if (block.length > maxSize) {
      flush()
      // 超长段落回退到句末标点，保留标点本身。
      let rest = block
      while (rest.length > maxSize) {
        let cut = -1
        for (let index = maxSize; index >= minSize; index -= 1) {
          if ('。！？；…!?;'.includes(rest[index - 1])) { cut = index; break }
        }
        if (cut <= 0) cut = maxSize
        out.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      if (rest) buffer = rest
      continue
    }
    const joined = buffer ? buffer + '\n\n' + block : block
    // 攒到下限就先交出去，别把短段一路并成一大块；超过上限的前一段留在缓冲里。
    if (joined.length >= minSize && joined.length <= maxSize) {
      out.push(joined)
      buffer = ''
      continue
    }
    if (joined.length > maxSize) {
      if (buffer.length >= minSize) {
        out.push(buffer)
        buffer = block
      } else {
        buffer = joined
      }
      continue
    }
    buffer = joined
  }
  flush()
  return out
}

export function apply(ctx, config = {}) {
  // Cordis 给插件的是子作用域，服务既可能挂在 ctx 上，也可能要用 ctx.get 取。
  const resolve = key => (ctx && ctx[key]) || (typeof ctx?.get === 'function' ? ctx.get(key) : null)
  const tavern = resolve('tavern')
  if (!tavern || !(tavern.apiVersion >= API_MIN)) {
    console.warn('[style-library] Tavern 插件接口版本过低，需要 ' + API_MIN + '，本插件不加载')
    return
  }

  let cached = null
  const selections = new Map()
  // 拿不到轮次时的退路：每注入一次记一次数，保证仍会换。
  const rotationSeed = new Map()

  async function load(force = false) {
    if (cached && !force) return cached
    const raw = await tavern.readPluginData().catch(() => null)
    cached = normalize(raw)
    return cached
  }

  async function persist(next) {
    const data = normalize(next)
    const bytes = Buffer.byteLength(JSON.stringify(data))
    if (bytes > DATA_BUDGET) {
      throw new Error('样文库接近 256 KB 上限（当前 ' + Math.round(bytes / 1024) + ' KB）：请删掉一些样文，或缩短单条样文。')
    }
    await tavern.savePluginData({ data })
    cached = data
    return data
  }

  async function selectionFor(gameId) {
    if (!gameId) return { libraryId: '', sampleId: '', shift: 0 }
    if (selections.has(gameId)) return selections.get(gameId)
    let value = { libraryId: '', sampleId: '', shift: 0 }
    try {
      const raw = await tavern.readGameData({ gameId })
      const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object' ? raw.data : raw
      if (data && typeof data === 'object') {
        value = {
          libraryId: str(data.libraryId),
          sampleId: str(data.sampleId),
          shift: Number.isFinite(Number(data.shift)) ? Math.trunc(Number(data.shift)) : 0,
        }
      }
    } catch { /* 没有本局数据就是没选 */ }
    selections.set(gameId, value)
    return value
  }

  async function writeSelection(gameId, libraryId, sampleId, shift = 0) {
    const value = {
      libraryId: str(libraryId),
      sampleId: str(sampleId),
      shift: Number.isFinite(Number(shift)) ? Math.trunc(Number(shift)) : 0,
    }
    await tavern.saveGameData({ gameId, data: value })
    selections.set(gameId, value)
    return value
  }

  /** 本轮实际要注入什么：正文里的 #文风 标记优先，否则用本局选中。 */
  /** 这一轮用第几号样文：按轮次轮换，同一轮重试拿到同一段。 */
  function seedFor(gameId, turn) {
    if (Number.isFinite(Number(turn))) return Number(turn)
    return rotationSeed.get(str(gameId)) || 0
  }

  async function resolveFor(gameId, input, turn) {
    const data = await load()
    if (data.libraries.length === 0) return null
    const seed = seedFor(gameId, turn)
    const active = await selectionFor(gameId)
    const marker = MARKER.exec(str(input))
    if (marker) {
      const hit = resolveByTag(data, marker[1], seed, active.shift)
      if (hit.library && hit.sample) return { library: hit.library, sample: hit.sample, via: 'marker' }
    }
    const library = data.libraries.find(item => item.id === active.libraryId)
    if (!library) return null
    const sample = sampleFor(library, active.sampleId, seed, active.shift)
    return sample ? { library, sample, via: 'active' } : null
  }

  // ── 存储操作：面板和 Agent 工具共用 ──────────────────────────────
  function cloneLibraries(data) {
    return data.libraries.map(item => ({
      ...item,
      tags: [...item.tags],
      samples: item.samples.map(sample => ({ ...sample, tags: [...sample.tags] })),
    }))
  }

  async function upsertLibrary(input) {
    const source = input && typeof input === 'object' ? input : {}
    const name = str(source.name).trim().slice(0, MAX_LIBRARY_NAME)
    if (!name) throw new Error('样文库名称不能为空')
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const existing = next.libraries.find(item => item.id === str(source.id))
    let id
    if (existing) {
      existing.name = name
      existing.tags = cleanTags(source.tags)
      existing.note = str(source.note).trim().slice(0, 200)
      existing.updatedAt = Date.now()
      id = existing.id
    } else {
      const sameName = next.libraries.find(item => item.name === name)
      if (sameName) throw new Error('已经有同名样文库「' + name + '」')
      if (next.libraries.length >= MAX_LIBRARIES) throw new Error('样文库数量已达上限 ' + MAX_LIBRARIES)
      id = newId()
      next.libraries.push({
        id,
        name,
        tags: cleanTags(source.tags),
        note: str(source.note).trim().slice(0, 200),
        samples: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    const saved = await persist(next)
    return { data: saved, id }
  }

  async function upsertSample(libraryId, sample) {
    const source = sample && typeof sample === 'object' ? sample : {}
    const text = str(source.text).trim()
    if (!text) throw new Error('样文不能为空')
    if (text.length > MAX_SAMPLE_CHARS) {
      throw new Error('单条样文最多 ' + MAX_SAMPLE_CHARS + ' 字，当前 ' + text.length + ' 字')
    }
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const library = next.libraries.find(item => item.id === str(libraryId))
    if (!library) throw new Error('没有这个样文库')
    const payload = {
      text,
      source: str(source.source).trim().slice(0, 120),
      tags: cleanTags(source.tags),
    }
    const existing = library.samples.find(item => item.id === str(source.id))
    let sampleId
    if (existing) {
      Object.assign(existing, payload)
      sampleId = existing.id
    } else {
      if (library.samples.length >= MAX_SAMPLES_PER_LIBRARY) {
        throw new Error('单个样文库最多 ' + MAX_SAMPLES_PER_LIBRARY + ' 条样文')
      }
      sampleId = newId()
      library.samples.push({ id: sampleId, ...payload })
    }
    library.updatedAt = Date.now()
    const saved = await persist(next)
    return { data: saved, id: sampleId }
  }

  // 批量存：一次 load、一次 persist，避免调十几次工具就写十几次盘。
  // 单条不合格（空、超长、库满）只跳过它，不让整批失败。
  async function upsertSamples(libraryId, samples) {
    const list = (Array.isArray(samples) ? samples : []).filter(item => item && typeof item === 'object')
    if (list.length === 0) throw new Error('至少要给一条样文')
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const library = next.libraries.find(item => item.id === str(libraryId))
    if (!library) throw new Error('没有这个样文库')
    const ids = []
    const skipped = []
    for (let index = 0; index < list.length; index += 1) {
      const source = list[index]
      const text = str(source.text).trim()
      if (!text) { skipped.push({ index, reason: '空样文' }); continue }
      if (text.length > MAX_SAMPLE_CHARS) {
        skipped.push({ index, reason: '超过 ' + MAX_SAMPLE_CHARS + ' 字（' + text.length + ' 字）' })
        continue
      }
      const existing = str(source.id)
        ? library.samples.find(item => item.id === str(source.id))
        : null
      if (!existing && library.samples.length >= MAX_SAMPLES_PER_LIBRARY) {
        skipped.push({ index, reason: '库已满 ' + MAX_SAMPLES_PER_LIBRARY + ' 条' })
        continue
      }
      const payload = {
        text,
        source: str(source.source).trim().slice(0, 120),
        tags: cleanTags(source.tags),
      }
      if (existing) {
        Object.assign(existing, payload)
        ids.push(existing.id)
      } else {
        const id = newId()
        library.samples.push({ id, ...payload })
        ids.push(id)
      }
    }
    if (ids.length === 0) {
      const reason = skipped[0] && skipped[0].reason ? skipped[0].reason : '没有可存的样文'
      throw new Error('一条都没存进去：' + reason)
    }
    library.updatedAt = Date.now()
    const saved = await persist(next)
    return { data: saved, ids, skipped, count: library.samples.length }
  }

  async function removeSamples(libraryId, sampleIds) {
    const wanted = new Set((Array.isArray(sampleIds) ? sampleIds : []).map(item => str(item)))
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const library = next.libraries.find(item => item.id === str(libraryId))
    if (!library) throw new Error('没有这个样文库')
    const before = library.samples.length
    library.samples = library.samples.filter(item => !wanted.has(item.id))
    const removed = before - library.samples.length
    if (removed === 0) throw new Error('没有匹配的样文')
    library.updatedAt = Date.now()
    return { data: await persist(next), removed }
  }

  function libraryBrief(library) {
    return {
      id: library.id,
      name: library.name,
      tags: library.tags,
      note: library.note,
      count: library.samples.length,
    }
  }

  // ── 标签池：增、删、改名 ─────────────────────────────────────────
  // 改名要连同所有库和样文里的引用一起改，否则标签池和实际用着的标签会对不上。
  // 删掉一个仍被引用的标签也一样：要么连着引用一起删，要么拒绝，这里选择一起删
  // （用户明确要删，留在样文上只会变成孤儿标签）。
  const cleanOne = value => str(value).trim().replace(/\s+/g, '').slice(0, MAX_TAG_LENGTH)

  async function updateTags(input) {
    const source = input && typeof input === 'object' ? input : {}
    const action = str(source.action) || 'add'
    const data = await load()
    const next = { ...data, tags: [...data.tags], libraries: cloneLibraries(data) }
    const has = tag => next.tags.includes(tag)

    if (action === 'add' || action === 'set') {
      const list = action === 'set'
        ? cleanTagList(source.tags, MAX_TAGS_POOL)
        : cleanTagList([...(source.tags || []), source.tag], MAX_TAGS_POOL)
      if (list.length === 0) throw new Error('至少要给一个标签')
      if (action === 'set') {
        // 保留仍被引用的标签，避免 set 之后样文上挂着一堆池子外的标签
        const used = new Set()
        for (const library of next.libraries) {
          for (const tag of library.tags) used.add(tag)
          for (const sample of library.samples) for (const tag of sample.tags) used.add(tag)
        }
        next.tags = [...new Set([...list, ...used])].slice(0, MAX_TAGS_POOL)
      } else {
        for (const tag of list) if (!has(tag)) next.tags.push(tag)
        next.tags = next.tags.slice(0, MAX_TAGS_POOL)
      }
      return { data: await persist(next), tags: next.tags }
    }

    const target = cleanOne(source.tag)
    if (!target) throw new Error('要指定标签')

    if (action === 'remove') {
      if (!has(target)) throw new Error('标签池里没有「' + target + '」')
      next.tags = next.tags.filter(tag => tag !== target)
      let touched = 0
      for (const library of next.libraries) {
        if (library.tags.includes(target)) {
          library.tags = library.tags.filter(tag => tag !== target)
          touched += 1
        }
        for (const sample of library.samples) {
          if (sample.tags.includes(target)) {
            sample.tags = sample.tags.filter(tag => tag !== target)
            touched += 1
          }
        }
      }
      return { data: await persist(next), tags: next.tags, touched }
    }

    if (action === 'rename') {
      const to = cleanOne(source.to || source.name)
      if (!to) throw new Error('要指定新标签名')
      if (to === target) return { data, tags: next.tags, touched: 0 }
      if (!has(target)) throw new Error('标签池里没有「' + target + '」')
      if (has(to)) throw new Error('标签池里已经有「' + to + '」了')
      next.tags = next.tags.map(tag => (tag === target ? to : tag))
      let touched = 0
      const swap = list => {
        if (!list.includes(target)) return list
        touched += 1
        return [...new Set(list.map(tag => (tag === target ? to : tag)))]
      }
      for (const library of next.libraries) {
        library.tags = swap(library.tags)
        for (const sample of library.samples) sample.tags = swap(sample.tags)
      }
      return { data: await persist(next), tags: next.tags, touched }
    }

    throw new Error('不认识的操作：' + action)
  }

  // 每轮算一次；内容变化不影响缓存前缀，因为它本来就属于本轮上下文。
  /** 这一局现在是第几轮；读不到就用内部计数。advance 只在真正注入时传，避免只读查询把轮次推走。 */
  async function turnOf(gameId, advance = false) {
    const key = str(gameId)
    if (typeof tavern.getTurnState === 'function') {
      try {
        const state = await tavern.getTurnState({ gameId: key })
        const turn = Number(state && state.turn)
        if (Number.isFinite(turn) && turn >= 0) {
          rotationSeed.set(key, turn)
          return turn
        }
      } catch { /* 读不到就用退路 */ }
    }
    if (advance) {
      const next = (rotationSeed.get(key) || 0) + 1
      rotationSeed.set(key, next)
      return next
    }
    return rotationSeed.get(key) || 1
  }

  // 每轮算一次；内容变化不影响缓存前缀，因为它本来就属于本轮上下文。
  tavern.turnSection({
    name: 'style-library',
    text: async ({ gameId, input }) => {
      try {
        const turn = await turnOf(gameId, true)
        const hit = await resolveFor(gameId, input, turn)
        return hit ? sectionText(hit.library, hit.sample) : ''
      } catch (error) {
        console.warn('[style-library] 注入失败：', error?.message || error)
        return ''
      }
    },
  })

  // ── 面板用的 handle ──────────────────────────────────────────
  const handle = (action, fn) => tavern.handle('dsh-tavern-style-library/' + action, fn)

  handle('list', async () => ({ data: await load(true) }))

  handle('save-library', async ({ library } = {}) => await upsertLibrary(library))

  handle('delete-library', async ({ id } = {}) => {
    const data = await load()
    const next = { ...data, libraries: data.libraries.filter(item => item.id !== str(id)) }
    if (next.libraries.length === data.libraries.length) throw new Error('没有这个样文库')
    return { data: await persist(next) }
  })

  handle('save-sample', async ({ libraryId, sample } = {}) => await upsertSample(libraryId, sample))

  handle('delete-sample', async ({ libraryId, sampleId } = {}) => {
    const out = await removeSamples(libraryId, [sampleId])
    return { data: out.data }
  })

  // 老接口：只加不删，客户端和旧调用还在用，保留。
  handle('add-tag', async ({ tag } = {}) => {
    const value = cleanOne(tag)
    if (!value) throw new Error('标签不能为空')
    const data = await load()
    if (data.tags.includes(value)) return { data }
    const next = { ...data, tags: [...data.tags, value] }
    return { data: await persist(next) }
  })

  // 标签池的统一入口：action = add | set | remove | rename
  handle('update-tags', async (input = {}) => {
    const out = await updateTags(input)
    return { data: out.data, tags: out.tags, touched: out.touched || 0 }
  })

  handle('get-active', async ({ gameId } = {}) => {
    const key = str(gameId)
    const data = await load()
    const active = await selectionFor(key)
    const library = data.libraries.find(item => item.id === active.libraryId) || null
    const turn = await turnOf(key)
    const sample = library ? sampleFor(library, active.sampleId, turn, active.shift) : null
    return { active, library, sample, turn }
  })

  handle('set-active', async ({ gameId, libraryId, sampleId } = {}) => {
    const data = await load()
    const id = str(libraryId)
    if (id && !data.libraries.some(item => item.id === id)) throw new Error('没有这个样文库')
    // sampleId 为空表示按轮次轮换；给了具体 id 就钉死在这一条。
    // 换库时把手动位移归零，否则新库会从中间某段开始。
    const previous = await selectionFor(str(gameId))
    const shift = previous.libraryId === id ? previous.shift : 0
    await writeSelection(str(gameId), id, str(sampleId), shift)
    return { ok: true }
  })

  // 换一段：把这一局的轮换往前推一格。
  //
  // 注意不能靠 rotationSeed —— 真实环境里 getTurnState 一直可用，turnOf 每次都用
  // 宿主轮次把它覆盖掉，写进去的值下一条查询就没了。所以位移必须随对局数据存。
  handle('rotate', async ({ gameId } = {}) => {
    const key = str(gameId)
    const data = await load()
    const active = await selectionFor(key)
    const library = data.libraries.find(item => item.id === active.libraryId)
    if (!library || library.samples.length === 0) {
      return { ok: false, text: '本局还没选样文库，先去侧栏选一个。' }
    }
    const shared = library.samples.filter(item => item.tags.some(tag => library.tags.includes(tag)))
    const pool = shared.length ? shared : library.samples
    if (pool.length < 2) {
      return { ok: false, text: '这个库只有一段样文，换不了；再存几段就能轮换。' }
    }
    const turn = await turnOf(key)
    // 位移 +1，再从池里取出对应的那一段；钉住某条时顺带解除钉住。
    const shift = (Number.isFinite(Number(active.shift)) ? Math.trunc(Number(active.shift)) : 0) + 1
    const next = sampleFor(library, '', turn, shift)
    await writeSelection(key, library.id, '', shift)
    const { index, total } = indexInPool(library, next)
    return {
      ok: true,
      shift,
      sampleId: next.id,
      source: next.source,
      quote: next.text,
      index,
      total,
      text: '下一轮起改用这一段。',
    }
  })

  // 回到轮换的起点：取消钉住，并把手动位移清零。
  handle('unpin', async ({ gameId } = {}) => {
    const key = str(gameId)
    const active = await selectionFor(key)
    await writeSelection(key, active.libraryId, '', 0)
    return { ok: true }
  })

  handle('preview', async ({ gameId, input } = {}) => {
    const key = str(gameId)
    const turn = await turnOf(key)
    const hit = await resolveFor(key, input, turn)
    if (!hit) return { text: '', via: '', turn }
    const place = indexInPool(hit.library, hit.sample)
    return {
      // text 是真正会注入的完整段落（含说明头、规则、原文），调试对照用；
      // sampleText 只有原文，面板上给用户看的是这个——规则说明对读者没意义。
      text: sectionText(hit.library, hit.sample),
      sampleText: hit.sample.text,
      via: hit.via, turn,
      library: hit.library.name, libraryId: hit.library.id,
      sample: hit.sample.id, sampleSource: hit.sample.source,
      sampleIndex: place.index || 1,
      sampleTotal: place.total || hit.library.samples.length,
    }
  })

  // 状态分节用：这一局此刻会注入什么，精简成几行。
  handle('status', async ({ gameId, input } = {}) => {
    const key = str(gameId)
    const turn = await turnOf(key)
    const data = await load()
    const active = await selectionFor(key)
    const marker = MARKER.exec(str(input))
    const hit = await resolveFor(key, input, turn)
    if (!hit) {
      return {
        on: false, turn, via: '', library: '', quote: '', source: '', index: 0, total: 0,
        hint: data.libraries.length === 0 ? '还没有样文库。' : (active.libraryId ? '选中的库没有样文。' : '本局没有选样文库。'),
      }
    }
    return {
      on: true,
      turn,
      via: hit.via,
      markerTag: marker ? marker[1] : '',
      library: hit.library.name,
      libraryId: hit.library.id,
      source: hit.sample.source,
      quote: hit.sample.text,
      tags: hit.sample.tags,
      index: indexInPool(hit.library, hit.sample).index || 1,
      total: indexInPool(hit.library, hit.sample).total || hit.library.samples.length,
    }
  })

  handle('analyze', async ({ gameId, text, tags } = {}) => {
    const sampleText = str(text).trim()
    if (!sampleText) throw new Error('先粘贴一段样文再分析')
    if (!str(gameId)) throw new Error('分析需要一个打开的对局（后台模型按局配置）')
    const data = await load()
    const allowed = cleanTags(tags).length ? cleanTags(tags) : data.tags
    const prompt = [
      '你是文风标注员。只判断下面这段文字的**笔调**：它与题材、剧情、人物都无关。',
      '从这些标签里挑 3 个最贴切的：' + allowed.join('、'),
      '必要时再补 1 到 2 个列表里没有的笔调标签，每个不超过 8 个字。',
      '只输出一个 JSON 数组，例如 ["冷峻","短句","留白"]。不要解释，不要代码块，不要标点符号。',
      '忽略本局的人物卡和剧情，它们与这段文字无关。',
      '',
      '文本开始',
      '"""',
      sampleText.slice(0, MAX_SAMPLE_CHARS),
      '"""',
      '文本结束',
    ].join('\n')

    let text_ = ''
    try {
      const result = await tavern.runTask({ gameId: str(gameId), prompt })
      text_ = str(result?.text)
    } catch (error) {
      throw new Error('调用后台模型失败：' + (error?.message || error) + '（这一局需要在设置里配置后台模型）')
    }
    const picked = parseTags(text_)
    if (picked.length === 0) throw new Error('模型没有返回可用的标签：' + text_.slice(0, 120))
    return { tags: picked }
  })

  // 给 Agent 用的切段：同一套规则，让模型自己也能预览切法。
  handle('split', async ({ text, target } = {}) => {
    const chunks = splitParagraphs(text, target)
    return {
      chunks: chunks.map((value, index) => ({ index: index + 1, chars: value.length, text: value })),
      total: chunks.length,
    }
  })

  // ── Agent 工具（卡片工作台里用，和创建 SKILL 一样）──────────────
  function registerTools() {
    const tools = resolve('tools')
    if (!tools || typeof tools.register !== 'function') {
      console.warn('[style-library] 没有 tools 服务，Agent 侧建库工具不可用')
      return
    }
    const disposers = []
    const add = (definition) => {
      disposers.push(tools.register(definition))
      try { tavern.toolModes({ name: definition.name, modes: ['card'] }) } catch { /* 老版本没有这个接口，忽略 */ }
    }

    add({
      name: 'style_library_list',
      description: '列出现有的样文库（名称、笔调标签、样文条数）和可用的笔调标签池。建样文库前先调用它，避免重名，也看有没有能直接追加的库。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            libraries: { type: 'array', items: { type: 'object', additionalProperties: true } },
            tags: { type: 'array', items: { type: 'string' } },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const data = await load(true)
        const libraries = data.libraries.map(libraryBrief)
        const lines = libraries.length === 0
          ? ['还没有样文库。可以新建一个，再用 style_sample_save_many 往里存摘录。']
          : ['现有样文库：'].concat(libraries.map(item => '- 「' + item.name + '」' + (item.tags.length ? ' · ' + item.tags.join('／') : '') + ' · ' + item.count + ' 条' + (item.note ? ' · ' + item.note : '')))
        lines.push('', '可用笔调标签：' + data.tags.join('、'))
        return { libraries, tags: data.tags, text: lines.join('\n') }
      },
    })

    // 长材料先切段，再逐段判断要不要留下。不给这个工具，模型容易自己切，
    // 长文里就会退化成「只挑两三段代表性的」。
    add({
      name: 'style_library_split',
      description: '把一整段或一整章材料按段落切开，返回每段的序号、字数和原文。只负责长度合理，'
        + '笔调是否完整要你自己看。材料超过 2 千字时先用它切，再决定留哪些段。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: { type: 'string', description: '要切的原文。' },
          target: { type: 'number', description: '每段目标字数，200～1600，默认 500。短段落书可以调小，长段落书调大。' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            total: { type: 'number' },
            chunks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const source = str(args && args.text)
        if (!source.trim()) throw new Error('要切分的原文是空的')
        const chunks = splitParagraphs(source, Number(args && args.target))
        const rows = chunks.map((value, index) => ({ index: index + 1, chars: value.length, text: value }))
        const lines = ['切成 ' + rows.length + ' 段（合计 ' + source.trim().length + ' 字）：']
          .concat(rows.map(row => '#' + row.index + '  ' + row.chars + ' 字  ' + row.text.slice(0, 40).replace(/\s+/g, ' ') + '…'))
          .concat(['', '挑出要留的段，用 style_sample_save_many 一次存入。'])
        return { total: rows.length, chunks: rows, text: lines.join('\n') }
      },
    })

    // 建库第一步：先把这份材料的笔调标签拟定出来给用户过目、增删改，
    // 之后按确认过的标签去切分素材。标签是切分依据，所以要先定。
    add({
      name: 'style_tags_update',
      description: '管理笔调标签池。建库前先把这份材料切合的几个笔调标签 add 进来，'
        + '列给用户看过、等他增删改；用户改完再按最终标签去切分素材。'
        + 'action=add 追加以 tags 给出的标签；set 用 tags 替换整个池子（仍在用的标签会保留）；'
        + 'remove 删掉 tag 并连同所有库和样文里的引用一起清掉；rename 把 tag 改名为 to（引用同步改）。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['add', 'set', 'remove', 'rename'], description: '要做什么。' },
          tags: { type: 'array', items: { type: 'string' }, description: 'action=add/set 时的标签列表。每个不超过 8 字，只描述笔调。' },
          tag: { type: 'string', description: 'action=remove/rename 时：要删或要改的标签。' },
          to: { type: 'string', description: 'action=rename 时：新标签名。' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            tags: { type: 'array', items: { type: 'string' } },
            added: { type: 'number' },
            touched: { type: 'number' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args) {
        const source = args || {}
        const before = await load()
        const beforeTags = [...before.tags]
        const out = await updateTags(source)
        const added = out.tags.filter(tag => !beforeTags.includes(tag))
        const lines = ['标签池现有 ' + out.tags.length + ' 个：' + out.tags.join('、')]
        if (added.length) lines.push('这次新增：' + added.join('、'))
        if (out.touched) lines.push('同步更新了 ' + out.touched + ' 处库／样文上的标签引用。')
        if (source.action === 'add' || source.action === 'set') {
          lines.push('', '把这份清单给用户看，问他要增、删、改哪些；确认后再按这些标签切分素材。')
        }
        return { tags: out.tags, added: added.length, touched: out.touched || 0, text: lines.join('\n') }
      },
    })

    add({
      name: 'style_library_save',
      description: '新建一个样文库，或改已有库的名称与笔调标签。建库本身不存样文，存摘录用 style_sample_save_many。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: {
          name: { type: 'string', description: '库名，例如「冷峻武侠」。同名会报错，要改已有库就传 id。' },
          id: { type: 'string', description: '要修改的库 id；省略表示新建。' },
          tags: { type: 'array', items: { type: 'string' }, description: '这个库整体偏哪些笔调，最多 12 个。' },
          note: { type: 'string', description: '一两句说明，例如出自哪本书。' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args) {
        const out = await upsertLibrary(args || {})
        return {
          id: out.id,
          name: str(args && args.name).trim(),
          text: '已保存样文库「' + str(args && args.name).trim() + '」（id: ' + out.id + '）。接着用 style_sample_save_many 批量存摘录。',
        }
      },
    })

    add({
      name: 'style_sample_save',
      description: '往样文库存一段原文摘录（不改写、不概括，原样存）。存多条请用 style_sample_save_many，'
        + '这个只用于单条补录或修改某一条。单条 40～2000 字，一个库最多 40 条。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['library', 'text'],
        properties: {
          library: { type: 'string', description: '库名或库 id。' },
          text: { type: 'string', description: '摘录原文，逐字照抄，不要改标点、不要补写、不要删节。' },
          tags: { type: 'array', items: { type: 'string' }, description: '这段的笔调标签，3 到 5 个，优先从标签池里挑。' },
          source: { type: 'string', description: '出处，例如书名或章节。' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'string' }, count: { type: 'string' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args) {
        const wanted = str(args && args.library).trim()
        if (!wanted) throw new Error('要指定样文库名或 id')
        const data = await load()
        const library = data.libraries.find(item => item.id === wanted) || data.libraries.find(item => item.name === wanted)
        if (!library) throw new Error('没有样文库「' + wanted + '」，先用 style_library_save 建一个')
        const out = await upsertSample(library.id, args || {})
        const after = out.data.libraries.find(item => item.id === library.id)
        return {
          id: out.id,
          count: String(after ? after.samples.length : 0),
          text: '已存入「' + library.name + '」，该库现有 ' + (after ? after.samples.length : 0) + ' 条样文。',
        }
      },
    })

    // 建库主力工具：长材料一次切出十几段是常态，
    // 一次调一条会让模型只肯存两三段，所以给批量入口。
    add({
      name: 'style_sample_save_many',
      description: '一次往样文库存多条原文摘录（不改写、不概括，原样存）。材料长的时候用它，一次存 5～20 条；'
        + '单条 40～2000 字，一个库最多 40 条。个别条目不合法只会跳过并回报，不影响其余的。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['library', 'samples'],
        properties: {
          library: { type: 'string', description: '库名或库 id。' },
          samples: {
            type: 'array',
            description: '要存的摘录，按材料中的先后顺序给。',
            items: {
              type: 'object', additionalProperties: false, required: ['text'],
              properties: {
                text: { type: 'string', description: '摘录原文，逐字照抄，不要改标点、不要补写、不要删节。' },
                tags: { type: 'array', items: { type: 'string' }, description: '这段的笔调标签，3 到 5 个，优先从标签池里挑。' },
                source: { type: 'string', description: '出处，例如书名或章节。' },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            saved: { type: 'number' }, count: { type: 'number' },
            skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args) {
        const wanted = str(args && args.library).trim()
        if (!wanted) throw new Error('要指定样文库名或 id')
        const data = await load()
        const library = data.libraries.find(item => item.id === wanted) || data.libraries.find(item => item.name === wanted)
        if (!library) throw new Error('没有样文库「' + wanted + '」，先用 style_library_save 建一个')
        const out = await upsertSamples(library.id, args && args.samples)
        const lines = ['已存入 ' + out.ids.length + ' 条，该库现有 ' + out.count + ' 条样文。']
        if (out.skipped.length) {
          lines.push('跳过 ' + out.skipped.length + ' 条：' + out.skipped.map(item => '第 ' + (item.index + 1) + ' 条（' + item.reason + '）').join('、'))
        }
        return {
          saved: out.ids.length,
          count: out.count,
          skipped: out.skipped,
          text: lines.join('\n'),
        }
      },
    })

    add({
      name: 'style_library_pick',
      description: '把某个样文库设为本局使用的文风来源。设了之后，每轮写正文都会带上它里面的一段原文作为笔调参考。传空库名表示取消。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          library: { type: 'string', description: '库名或库 id；留空表示本局不使用样文库。' },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args, exec) {
        const gameId = str(exec && exec.agent && exec.agent.session && exec.agent.session.id)
        if (!gameId) {
          // 卡片工作台里没有对局，库里先记下意图即可
          return { ok: false, text: '当前不在对局中，没法设置本局使用。等开了游戏，在面板或输入框上方的「文风」按钮里选。' }
        }
        const wanted = str(args && args.library).trim()
        if (!wanted) {
          await writeSelection(gameId, '', '')
          return { ok: true, text: '本局已取消样文库，之后不再注入文风参考。' }
        }
        const data = await load()
        const library = data.libraries.find(item => item.id === wanted) || data.libraries.find(item => item.name === wanted)
        if (!library) throw new Error('没有样文库「' + wanted + '」')
        if (library.samples.length === 0) throw new Error('「' + library.name + '」里还没有样文，先存几段')
        await writeSelection(gameId, library.id, '')
        return { ok: true, text: '本局改用样文库「' + library.name + '」，之后每轮正文都会带它的笔调参考。' }
      },
    })

    return () => { for (const dispose of disposers) { try { dispose() } catch { /* 忽略 */ } } }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => registerTools())
  else registerTools()

  // 自带的建库 Skill：写法同 create-writing-skill，卡片工作台里按场景加载。
  if (typeof tavern.skillSource === 'function') {
    try {
      const dir = fileURLToPath(new URL('./skills', import.meta.url))
      const register = () => tavern.skillSource({ dir, role: 'card' })
      if (typeof ctx.effect === 'function') ctx.effect(register)
      else register()
    } catch (error) {
      console.warn('[style-library] Skill 注册失败：', error?.message || error)
    }
  }
}
