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

// ── 风格卡（7+1 维度提炼）────────────────────────────────────────
//
// 融合 perfectly-replicate-writing-skills 的分析框架（MIT，见
// skills/style-library/references/framework.md）：把一整个库的摘录
// 提炼成一张「可执行的风格卡」——七个维度的量化观察、跨维度验证过的写作基因、
// 铁律、以及「从不出现」的禁用清单。摘录是原文证据，风格卡是规则；两者一起
// 注入，模型既有样子可看，也有边界可守。
const CARD_DIMENSIONS = [
  ['lexical', '词汇'],
  ['syntactic', '句法'],
  ['tonal', '语气'],
  ['discourse', '篇章'],
  ['rhetoric', '修辞'],
  ['emotion', '情感'],
  ['perspective', '视角'],
  // 下面两项来自 fiction-distiller 的「五感权重 / 人物与对话」：写小说时它们比
  // 抽象的「修辞」更能决定像不像——一段文字有没有具体的冷热、有没有人真的在说话。
  ['imagery', '感官'],
  ['dialogue', '对白'],
]
const DIMENSION_ALIAS = {
  词汇: 'lexical', 词汇特征: 'lexical', lexical: 'lexical',
  句法: 'syntactic', 句法特征: 'syntactic', 句式: 'syntactic', 标点: 'syntactic', syntactic: 'syntactic',
  语气: 'tonal', 语气特征: 'tonal', 调性: 'tonal', tonal: 'tonal',
  篇章: 'discourse', 篇章结构: 'discourse', 结构: 'discourse', 节奏: 'discourse', discourse: 'discourse',
  修辞: 'rhetoric', 修辞表达: 'rhetoric', 修辞系统: 'rhetoric', rhetoric: 'rhetoric',
  情感: 'emotion', 情感态度: 'emotion', 情绪: 'emotion', 氛围: 'emotion', emotion: 'emotion',
  视角: 'perspective', 内容视角: 'perspective', 叙事视角: 'perspective', perspective: 'perspective',
  感官: 'imagery', 五感: 'imagery', 意象: 'imagery', 描写: 'imagery', imagery: 'imagery',
  对白: 'dialogue', 对话: 'dialogue', 人物: 'dialogue', dialogue: 'dialogue',
}
const MAX_CARD_POINTS = 5
const MAX_CARD_POINT_CHARS = 140
const MAX_CARD_GENES = 5
const MAX_CARD_LAWS = 10
const MAX_CARD_DISALLOWED = 10
const MAX_CARD_ITEM_CHARS = 120
const MAX_CARD_MANTRA = 200
const MAX_CARD_SUMMARY = 300
const MAX_CARD_AI_BAN = 20
const MAX_CARD_AI_BAN_CHARS = 24
// 试写只返回给面板显示，不存进卡：它是一次校验，不是资产。
// 存进去会让「改卡 → 再试」的循环不断撞字节上限，收益却只是下次打开还能看到。
// 这个数字只用来限制返回给面板的长度。
const MAX_CARD_TESTED = 800
const MAX_CARD_DIGEST = 2600
// 字段上限写满约 30 KB，这里留 24 KB 当兜底：
// 正常一张卡两三 KB，写满还能存的卡基本已经是一堆废话了。
const MAX_CARD_BYTES = 24 * 1024
// 每轮注入什么：只用摘录（默认，和以前一致）/ 摘录 + 风格卡 / 只用风格卡。
const CARD_MODES = ['sample', 'both', 'card']

const str = value => (typeof value === 'string' ? value : '')

const clampInt = (value, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

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

// ── 风格卡的归一化 ───────────────────────────────────────────
// 风格卡是由模型（AI 提炼）或 Agent 写出来的 JSON，形状一定不会完全规整：
// 键名中英混着、数组里混着字符串和对象、条目多到放不下。这里统一收一遍，
// 收到的永远是一个固定形状的对象，后面的渲染和注入就不用再操心。

const squeeze = (value, max) => {
  const text = str(value).replace(/\s+/gu, ' ').trim()
  return text.length > max ? text.slice(0, max) : text
}

/** 把「字符串或字符串数组」收成去重后的字符串数组；也接受 {text/point/…} 对象。 */
function cardList(value, max, maxChars) {
  let list
  if (Array.isArray(value)) list = value
  else if (typeof value === 'string') list = value.split(/\n+|；|;/u)
  else list = []
  const out = []
  for (const item of list) {
    const raw = item && typeof item === 'object'
      ? (item.text ?? item.point ?? item.value ?? item.finding ?? item.desc ?? item.description ?? item.label ?? item.name ?? '')
      : item
    const text = squeeze(raw, maxChars)
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

function cardDimensions(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const out = {}
  for (const [key, points] of Object.entries(src)) {
    const raw = str(key).trim()
    const name = DIMENSION_ALIAS[raw] || DIMENSION_ALIAS[raw.toLowerCase()]
    if (!name || out[name]) continue
    const list = cardList(points, MAX_CARD_POINTS, MAX_CARD_POINT_CHARS)
    if (list.length) out[name] = list
  }
  return out
}

function cardGenes(value) {
  const out = []
  const source = Array.isArray(value) ? value : (value && typeof value === 'string' ? [value] : [])
  for (const item of source) {
    let name = ''
    let text = ''
    if (item && typeof item === 'object') {
      name = squeeze(item.name ?? item.title ?? '', 24)
      text = squeeze(item.text ?? item.desc ?? item.description ?? item.detail ?? '', MAX_CARD_POINT_CHARS)
    } else {
      const raw = squeeze(item, MAX_CARD_POINT_CHARS + 24)
      const cut = raw.search(/[：:]/u)
      if (cut > 0 && cut <= 24) {
        name = squeeze(raw.slice(0, cut), 24)
        text = squeeze(raw.slice(cut + 1), MAX_CARD_POINT_CHARS)
      } else {
        text = raw
      }
    }
    if (!name && !text) continue
    out.push({ name: name || '写作基因' + (out.length + 1), text })
    if (out.length >= MAX_CARD_GENES) break
  }
  return out
}

// withPrevious=false 用来掐断递归：上一版自己不再带上一版，只留一层。
function normalizeCard(raw, withPrevious = true) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!src) return null
  const corpusRaw = src.corpus && typeof src.corpus === 'object' ? src.corpus : {}
  const card = {
    author: squeeze(src.author ?? src.name ?? '', 40),
    genre: squeeze(src.genre ?? src['体裁'] ?? '', 40),
    platform: squeeze(src.platform ?? src['平台'] ?? '', 40),
    corpus: {
      articles: clampInt(corpusRaw.articles ?? src.articles, 0, 999),
      chars: clampInt(corpusRaw.chars ?? corpusRaw.words ?? src.chars, 0, 99999999),
    },
    // 维度既可能收在 dimensions 里，也可能被平铺在根上（模型常这么写）；
    // cardDimensions 只认那九个键，多给的 author/genre 之类会被忽略。
    dimensions: cardDimensions(src.dimensions ?? src['维度'] ?? src),
    genes: cardGenes(src.genes ?? src['写作基因']),
    laws: cardList(src.laws ?? src.ironLaws ?? src.rules ?? src['铁律'], MAX_CARD_LAWS, MAX_CARD_ITEM_CHARS),
    disallowed: cardList(
      src.disallowed ?? src.never ?? src['禁用清单'] ?? src['禁用'] ?? src['反面清单'],
      MAX_CARD_DISALLOWED, MAX_CARD_ITEM_CHARS,
    ),
    // AI 腔黑名单：比「禁用动作」更细，是具体的词和套话。fiction-distiller 那套
    // 反 AI 痕迹的做法里最有用的一条——模型最容易在这里露馅。
    aiBan: cardList(
      src.aiBan ?? src.aiWords ?? src['AI腔'] ?? src['AI词'] ?? src['黑名单'],
      MAX_CARD_AI_BAN, MAX_CARD_AI_BAN_CHARS,
    ),
    summary: squeeze(src.summary ?? src['指纹小结'] ?? src['小结'] ?? '', MAX_CARD_SUMMARY),
    mantra: squeeze(src.mantra ?? src['口诀'] ?? src['起笔口诀'] ?? '', MAX_CARD_MANTRA),
    formula: squeeze(src.formula ?? src['公式'] ?? '', 60),
    match: clampInt(src.match ?? src.score ?? src['匹配度'], 0, 100),
    // 上一版：重新提炼/手改/导入时由 writeCard 自动塞进来，给「恢复上一版」用。
    previous: withPrevious && src.previous ? normalizeCard(src.previous, false) : null,
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
  // 一张什么实质内容都没有的卡等于没有卡——不要拿它去注入。
  // `summary` 不算实质内容：它只是转述，单独存在的话注入出去只有一行标题。
  const meaningful = Object.keys(card.dimensions).length > 0 || card.genes.length > 0
    || card.laws.length > 0 || card.disallowed.length > 0 || card.aiBan.length > 0
    || Boolean(card.mantra)
  return meaningful ? card : null
}

function cardBytes(card) {
  return Buffer.byteLength(JSON.stringify(card))
}

const hasCard = card => Boolean(card && normalizeCardLite(card))

// normalizeCard 会补 updatedAt，判断「有没有卡」只需要看实质内容。
function normalizeCardLite(card) {
  if (!card || typeof card !== 'object') return null
  const dims = card.dimensions && typeof card.dimensions === 'object' ? Object.keys(card.dimensions).length : 0
  const ok = dims > 0 || (card.genes || []).length > 0 || (card.laws || []).length > 0
    || (card.disallowed || []).length > 0 || (card.aiBan || []).length > 0
    || Boolean(card.mantra)
  return ok ? card : null
}

// 这张卡给模型看的时候长什么样：一行维度一句，基因、铁律、禁用各一段。
// 有意做得比导出的 Prompt 短——它要和摘录挤在同一段注入里。
function cardDigest(card) {
  if (!hasCard(card)) return ''
  const meta = []
  if (card.author) meta.push(card.author)
  if (card.corpus && card.corpus.articles) meta.push(card.corpus.articles + ' 篇')
  if (card.corpus && card.corpus.chars) meta.push(Number(card.corpus.chars).toLocaleString('zh-CN') + ' 字')
  if (card.match) meta.push('自评贴合 ' + card.match + '%')
  // 不塞 summary。那句指纹小结是给人和导出的 Prompt 看的，和下面的维度条目
  // 说的是同一件事；每轮都重复一遍，只是把 300 字预算花了两次。
  // 也不在标题里再解释一遍「规则/证据」——上一行的规则说明刚说完。
  const lines = ['■ 风格卡' + (meta.length ? '（' + meta.join(' · ') + '）' : '')]
  for (const [key, label] of CARD_DIMENSIONS) {
    const points = card.dimensions && card.dimensions[key]
    if (points && points.length) lines.push(label + '：' + points.join('；'))
  }
  if (card.genes && card.genes.length) {
    lines.push('写作基因：' + card.genes.map((gene, index) =>
      (index + 1) + ') ' + gene.name + (gene.text ? ' — ' + gene.text : '')).join('｜'))
  }
  if (card.laws && card.laws.length) {
    lines.push('铁律：' + card.laws.map((law, index) => (index + 1) + '. ' + law).join(' '))
  }
  if (card.disallowed && card.disallowed.length) {
    lines.push('从不出现（写出来就是出戏）：' + card.disallowed.join('；'))
  }
  if (card.aiBan && card.aiBan.length) {
    lines.push('AI 腔（一个都不许用）：' + card.aiBan.join('、'))
  }
  if (card.mantra) lines.push('起笔口诀：' + card.mantra)
  const text = lines.join('\n')
  return text.length > MAX_CARD_DIGEST ? text.slice(0, MAX_CARD_DIGEST) + '…' : text
}

/** 状态页用的一行提要：没有摘录可显示时，用它顶替引文位置。 */
function cardBrief(card) {
  if (!hasCard(card)) return ''
  const bits = []
  for (const [key, label] of CARD_DIMENSIONS) {
    const points = card.dimensions && card.dimensions[key]
    if (points && points.length) bits.push(label + ' ' + points[0])
    if (bits.length >= 3) break
  }
  return bits.length ? bits.join('；') : (card.mantra || (card.genes && card.genes[0] ? card.genes[0].name : '') || '')
}

// 导出的「便携风格 Prompt」：给任何 LLM 都能直接用，不依赖本插件。
// 外面传进来的卡不一定过过 normalize（手改 JSON、老数据都算），所以这里再收一次口。
function cardPrompt(library) {
  if (!hasCard(library && library.card)) {
    throw new Error('这个样文库还没有风格卡，先提炼一张（AI 提炼，或让 Agent 用 style_card_save 存）。')
  }
  const card = normalizeCard(library.card)
  if (!card) throw new Error('这张风格卡读不出来（结构不对），重新提炼一次。')
  const who = card.author || library.name
  const lines = [
    '# 写作风格 Prompt · ' + who + (card.genre ? '（' + card.genre + '）' : ''),
    '',
    '## 身份',
    '你是一位' + (card.genre || '小说') + '写作者，笔调参照「' + who + '」。' + (card.mantra ? '落笔前默念：' + card.mantra : ''),
  ]
  if (card.summary) lines.push('', '## 指纹小结', card.summary)
  lines.push('', '## 铁律')
  if (card.laws.length) card.laws.forEach((law, index) => lines.push((index + 1) + '. ' + law))
  else lines.push('（这张卡没有写铁律，按下面的维度观察落笔。）')
  lines.push('', '## 风格参考卡')
  for (const [key, label] of CARD_DIMENSIONS) {
    const points = card.dimensions[key]
    if (!points || !points.length) continue
    lines.push('### ' + label)
    for (const point of points) lines.push('- ' + point)
    lines.push('')
  }
  if (card.genes.length) {
    lines.push('## 写作基因（跨维度验证过，删掉就不像了）')
    card.genes.forEach((gene, index) => lines.push((index + 1) + '. ' + gene.name + (gene.text ? '：' + gene.text : '')))
    lines.push('')
  }
  if (card.disallowed.length) {
    lines.push('## 禁用清单')
    for (const item of card.disallowed) lines.push('- ' + item)
    lines.push('')
  }
  if (card.aiBan.length) {
    lines.push('## AI 腔黑名单（一个都不许出现）')
    for (const item of card.aiBan) lines.push('- ' + item)
    lines.push('')
  }
  if (card.formula) lines.push('## 叙事公式', card.formula, '')
  if (library.tags && library.tags.length) lines.push('## 笔调标签', library.tags.join('／'), '')
  const corpus = []
  if (card.corpus.articles) corpus.push(card.corpus.articles + ' 篇')
  if (card.corpus.chars) corpus.push(card.corpus.chars + ' 字')
  // 自评跟着语料一行走：它是这张卡上一次试写的结果，单独开一节反而更奇怪。
  if (card.match) corpus.push('自评贴合 ' + card.match + '%')
  if (corpus.length) {
    lines.push('## 语料', corpus.join(' · ') + (card.platform ? '（' + card.platform + '）' : ''))
  }
  return lines.join('\n').trim()
}

// ── 把导出的 Prompt 读回成一张卡 ──────────────────────────────
// 和 cardPrompt() 是一对：导出的东西能原样贴回来。
// 否则「别人给了我一张卡」只能重走一遍建库存摘录再提炼，绕得没有道理。
const SECTION_KEYS = [
  [/^身份/u, 'identity'],
  [/^指纹小结/u, 'summary'],
  [/^铁律/u, 'laws'],
  [/^风格参考卡/u, 'dimensions'],
  [/^写作基因/u, 'genes'],
  [/^禁用清单/u, 'disallowed'],
  [/^AI\s*腔/u, 'aiBan'],
  [/^叙事公式/u, 'formula'],
  [/^笔调标签/u, 'tags'],
  [/^语料/u, 'corpus'],
]

function sectionKeyOf(heading) {
  const value = str(heading).trim()
  for (const [pattern, key] of SECTION_KEYS) if (pattern.test(value)) return key
  return ''
}

function dimensionKeyOf(label) {
  const value = str(label).trim()
  const hit = CARD_DIMENSIONS.find(([, name]) => name === value)
  if (hit) return hit[0]
  return DIMENSION_ALIAS[value] || DIMENSION_ALIAS[value.toLowerCase()] || ''
}

function parseCardPrompt(text) {
  const raw = str(text).replace(/\r\n?/gu, '\n')
  if (!raw.trim()) return null
  const card = { dimensions: {} }
  const add = (key, value) => {
    if (!value) return
    if (!card[key]) card[key] = []
    card[key].push(value)
  }

  const title = raw.match(/^#\s*写作风格\s*Prompt\s*[·・]\s*(.+)$/mu)
  if (title) {
    const value = title[1].trim()
    const split = value.match(/^(.+?)[（(](.+?)[）)]$/u)
    if (split) {
      card.author = split[1].trim()
      card.genre = split[2].trim()
    } else {
      card.author = value
    }
  }

  let section = ''
  let dimension = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const h3 = trimmed.match(/^###\s*(.+)$/u)
    if (h3) {
      dimension = dimensionKeyOf(h3[1])
      section = dimension ? 'dimension' : ''
      continue
    }
    const h2 = trimmed.match(/^##\s*(.+)$/u)
    if (h2) {
      section = sectionKeyOf(h2[1])
      dimension = ''
      continue
    }
    if (/^#\s/u.test(trimmed)) continue
    // 去掉列表符号和序号；「（这张卡没有写铁律…）」这类占位说明跳过
    const body = trimmed.replace(/^[-*]\s*/u, '').replace(/^\d+[.、)]\s*/u, '').trim()
    if (!body || /^[（(].*[）)]$/u.test(body)) continue
    switch (section) {
      case 'identity': {
        const mantra = body.match(/落笔前默念[：:]\s*(.+)$/u)
        if (mantra) card.mantra = mantra[1].trim()
        break
      }
      case 'summary':
        card.summary = card.summary ? card.summary + ' ' + body : body
        break
      case 'laws': add('laws', body); break
      case 'dimension': if (dimension) add2(card.dimensions, dimension, body); break
      case 'genes': {
        const split = body.match(/^(.+?)[：:]\s*(.*)$/u)
        const gene = split ? { name: split[1].trim(), text: split[2].trim() } : { name: body, text: '' }
        if (!card.genes) card.genes = []
        card.genes.push(gene)
        break
      }
      case 'disallowed': add('disallowed', body); break
      case 'aiBan': add('aiBan', body); break
      case 'formula':
        card.formula = card.formula ? card.formula + ' ' + body : body
        break
      case 'corpus': {
        const articles = body.match(/(\d+)\s*篇/u)
        const chars = body.match(/(\d+)\s*字/u)
        const match = body.match(/自评贴合\s*(\d{1,3})\s*%/u)
        card.corpus = {
          articles: articles ? Number(articles[1]) : 0,
          chars: chars ? Number(chars[1]) : 0,
        }
        if (match) card.match = Number(match[1])
        break
      }
      default: break
    }
  }
  return normalizeCard(card)
}

function add2(map, key, value) {
  if (!map[key]) map[key] = []
  map[key].push(value)
}

// ── 让模型自己产出风格卡 / 盲测 ────────────────────────────────
// 取材要沿全文铺开：只喂开头几段，提炼出来的是「开头那一段的笔调」。
function cardSource(library, max = 12, perSample = 700) {
  const samples = library.samples || []
  if (samples.length <= max) return samples.map(item => item.text.slice(0, perSample))
  const step = samples.length / max
  return Array.from({ length: max }, (_, index) => samples[Math.floor(index * step)].text.slice(0, perSample))
}

function distillPrompt(library) {
  const picked = cardSource(library)
  const chars = picked.reduce((sum, text) => sum + text.length, 0)
  return [
    '你是文体分析员。下面是同一批材料里摘出的 ' + picked.length + ' 段原文（合计约 ' + chars + ' 字），',
    '请按 9 个维度提炼出一张可执行的写作风格卡，供别人照着写同一副笔调。',
    '',
    '原则：',
    '- 只描述这批文字**实际呈现**的特征；不评价好坏，不给通用写作建议。',
    '- 能量化就量化。「喜欢用短句」没有信息量；「平均 11 字，七成句子在 8 字以内」有用。',
    '- 反复出现 3 次以上的才算特征。只出现一两次的是即兴，不要写进来。',
    '- 材料里互相矛盾的地方**保留矛盾**，不要抹平。',
    '- 不要猜作者生平、写作意图，也不要拿别的作家来类比。',
    '- 铁律要能自检：写完回头看一眼就知道有没有做到，不要写「要生动」这种没法判的。',
    '- 禁用清单写「这段文字从不做的事」，具体到句式、词、动作——它比正面特征更能定边界。',
    '- AI 腔单列一份词表：这批文字里根本不会出现的套话，最多 20 个。',
    '',
    // runTask 跑的是本局的后台 Agent，前缀里带着人物卡和世界观。
    // 不显式切掉的话，模型会把「这一局是什么故事」混进「这批材料什么笔调」里。
    '忽略本局的人物卡、世界观和剧情，它们与这批材料无关。',
    '',
    '只输出一个 JSON 对象，不要解释，不要代码块：',
    '{',
    '  "author": "作者或书名，不知道就留空",',
    '  "genre": "体裁",',
    '  "corpus": { "articles": 篇数, "chars": 字数 },',
    '  "summary": "300 字以内的指纹小结：一口气说清这副笔调是什么样",',
    '  "dimensions": {',
    '    "lexical": ["3-5 条：高频词、指纹词、搭配、用词质感"],',
    '    "syntactic": ["3-5 条：平均句长、长短句分布、标点指纹、段落节奏"],',
    '    "tonal": ["3-5 条：口语化程度、冷热、断言强弱、句长波动"],',
    '    "discourse": ["3-5 条：开头怎么起、场景怎么推进、在哪收"],',
    '    "rhetoric": ["3-5 条：比喻密度与取材、排比、设问、具体与抽象的比例"],',
    '    "emotion": ["3-5 条：情绪极性、弧线、克制度"],',
    '    "perspective": ["3-5 条：人称、聚焦方式、价值词"],',
    '    "imagery": ["3-5 条：视觉/听觉/触觉各占多少，有没有通感"],',
    '    "dialogue": ["3-5 条：对白多长、有没有提示语、人物怎么用词区分"]',
    '  },',
    '  "genes": [{ "name": "4-6 字", "text": "一句话，说清它由哪几个维度共同支撑" }],',
    '  "laws": ["6-10 条铁律：落到操作层，能直接照着写、也能自检"],',
    '  "disallowed": ["5-10 条：这段文字从不出现的东西"],',
    '  "aiBan": ["AI 腔词句黑名单，最多 20 个"],',
    '  "mantra": "30 字以内的起笔口诀",',
    '  "formula": "如果要套一个叙事公式，推荐哪个、为什么"',
    '}',
    '',
    '原文开始',
    '"""',
    ...picked.map((text, index) => '【第 ' + (index + 1) + ' 段】\n' + text),
    '"""',
    '原文结束',
  ].join('\n')
}

function blindTestPrompt(library) {
  const card = library.card
  return [
    '按下面这张风格卡，写一段 200～300 字的叙事片段。',
    '不要提到风格卡，不要解释你在做什么，直接写正文。写完再自评贴合度。',
    // 同上：别把本局的人物卡和剧情带进来，否则写出来是「这一局」的样子，不是「这张卡」的样子。
    '这段只是试写，不要使用本局的人物、地名和已发生的剧情，也不要续写。',
    '',
    cardDigest(card),
    '',
    '输出格式，严格照此：',
    '【试写】',
    '（正文）',
    '【自评】',
    '（逐维度一句话，说明哪里像、哪里不像）',
    '综合匹配度：82%',
  ].join('\n')
}

// 从模型回复里抠 JSON：整段就是 JSON 最好，不行就从 ```json 块或第一个大括号起截。
function parseCardReply(text) {
  const raw = str(text).trim()
  if (!raw) return null
  const candidates = []
  candidates.push(raw)
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/u)
  if (fence) candidates.push(fence[1])
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      const card = normalizeCard(value)
      if (card) return card
    } catch { /* 试下一个候选 */ }
  }
  return null
}

function parseTestReply(text) {
  const raw = str(text).trim()
  const score = Number((raw.match(/匹配度[^\d]{0,6}(\d{1,3})/u) || [])[1])
  const mark = raw.indexOf('【自评】')
  const body = (mark > 0 ? raw.slice(0, mark) : raw)
    .replace(/【试写】/gu, '')
    .trim()
    .slice(0, MAX_CARD_TESTED)
  return { text: body, match: Number.isFinite(score) ? Math.min(100, score) : 0 }
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
      // 风格卡：老数据没有这一项，读出来就是 null，行为和以前完全一样。
      card: normalizeCard(item.card),
      mode: CARD_MODES.includes(str(item.mode)) ? str(item.mode) : 'sample',
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

/** 这个库是不是「只用风格卡」——设成 card 但卡被清掉时要退回摘录。 */
const cardOnly = library => Boolean(library && hasCard(library.card) && library.mode === 'card')
/** 这一轮到底会不会把风格卡带进去。 */
const usesCard = library => Boolean(library && hasCard(library.card) && library.mode !== 'sample')

function sectionText(library, sample) {
  const withCard = usesCard(library)
  const onlyCard = cardOnly(library)
  const tags = []
  if (sample && sample.tags.length) tags.push(sample.tags.join('／'))
  if (withCard) tags.push('风格卡')
  const head = '【文风参考 · ' + library.name + (tags.length ? ' · ' + tags.join(' · ') : '') + '】'
  const rule = '只借它的笔调：句子的长短与节奏、留白的位置、用词的质感和克制程度。'
    + (withCard && !onlyCard ? '风格卡给的是规则，原文给的是证据，两样都以笔调为准。' : '')
    + '\n不要借它的情节、人物、名字，不要照抄任何原句，也不要在正文里提到它或它的出处。'
  const parts = [head, rule]
  if (withCard) parts.push(cardDigest(library.card))
  if (!onlyCard && sample) parts.push('参考原文：\n' + sample.text)
  const text = parts.join('\n')
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
      throw new Error('样文库接近 256 KB 上限（当前 ' + Math.round(bytes / 1024)
        + ' KB）：请删掉一些样文、缩短单条样文，或清掉几个不用的风格卡。')
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
      // 能不能用不能只看 sample：库里的摘录被删光、但还留着风格卡时，
      // 「摘录＋风格卡」这一档应该退化成只注入卡，而不是整段消失。
      if (hit.library && (hit.sample || usesCard(hit.library))) {
        return { library: hit.library, sample: hit.sample || null, via: 'marker' }
      }
    }
    const library = data.libraries.find(item => item.id === active.libraryId)
    if (!library) return null
    const sample = sampleFor(library, active.sampleId, seed, active.shift)
    if (sample || usesCard(library)) return { library, sample: sample || null, via: 'active' }
    return null
  }

  // ── 存储操作：面板和 Agent 工具共用 ──────────────────────────────
  function cloneLibraries(data) {
    return data.libraries.map(item => ({
      ...item,
      tags: [...item.tags],
      samples: item.samples.map(sample => ({ ...sample, tags: [...sample.tags] })),
      card: item.card ? JSON.parse(JSON.stringify(item.card)) : null,
    }))
  }

  async function upsertLibrary(input) {
    const source = input && typeof input === 'object' ? input : {}
    const name = str(source.name).trim().slice(0, MAX_LIBRARY_NAME)
    if (!name) throw new Error('样文库名称不能为空')
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const existing = next.libraries.find(item => item.id === str(source.id))
    // mode 只在显式给出时改；Agent 的 style_library_save 不带 mode 时不能把用户设的模式冲掉。
    const wantedMode = CARD_MODES.includes(str(source.mode)) ? str(source.mode) : ''
    let id
    if (existing) {
      existing.name = name
      existing.tags = cleanTags(source.tags)
      existing.note = str(source.note).trim().slice(0, 200)
      if (wantedMode) existing.mode = wantedMode
      if (source.card !== undefined) existing.card = normalizeCard(source.card)
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
        card: normalizeCard(source.card),
        mode: wantedMode || 'sample',
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
      mode: library.mode,
      hasCard: hasCard(library.card),
      cardMatch: library.card ? library.card.match : 0,
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

  // ── 风格卡的读写 ────────────────────────────────────────────
  // 卡是整库一份，跟库一起存（plugin-data 里），不进按局数据：
  // 换一局、回退到哪一轮，用的都是同一张卡，不需要按版本管理。
  // 覆盖一张卡前，把旧的那张留成 previous：
  // 重新提炼是「再问一次模型」，这次没读全就得能退回上一次，否则只能反复碰运气。
  // keepPrevious=false 用于改分数这类不算版本的写入（试写）和「恢复上一版」自身。
  async function writeCard(libraryId, rawCard, options = {}) {
    const card = normalizeCard(rawCard)
    if (!card) {
      throw new Error('风格卡是空的：至少要给出维度观察、写作基因、铁律、禁用清单里的任意一项')
    }
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const library = next.libraries.find(item => item.id === str(libraryId))
    if (!library) throw new Error('没有这个样文库')

    if (options.keepPrevious !== false && hasCard(library.card)) {
      // 内容没变就沿用原来那版上一版——否则「原样再存一次」会把上一版冲成空，
      // 用户什么都没改，却丢了退路。
      card.previous = cardFingerprint(library.card) === cardFingerprint(card)
        ? (library.card.previous ? normalizeCard(library.card.previous, false) : null)
        : normalizeCard(library.card, false)
    }
    // 上一版是「以防万一」的东西，卡本身快满时先丢它，别让主内容存不进去。
    if (card.previous && cardBytes(card) > MAX_CARD_BYTES) card.previous = null

    const bytes = cardBytes(card)
    if (bytes > MAX_CARD_BYTES) {
      throw new Error('风格卡太长（' + Math.round(bytes / 1024) + ' KB，上限 '
        + Math.round(MAX_CARD_BYTES / 1024) + ' KB）：删掉几条再存')
    }
    library.card = card
    library.updatedAt = Date.now()
    const saved = await persist(next)
    return { data: saved, card }
  }

  // 只比内容，不比时间戳和上一版——否则每次保存都算「变过」，都会挤掉真正的上一版。
  function cardFingerprint(card) {
    return JSON.stringify({ ...normalizeCard(card, false), previous: null, updatedAt: 0 })
  }

  async function clearCard(libraryId) {
    const data = await load()
    const next = { ...data, libraries: cloneLibraries(data) }
    const library = next.libraries.find(item => item.id === str(libraryId))
    if (!library) throw new Error('没有这个样文库')
    library.card = null
    // 卡没了，模式也得跟着回到只用摘录，否则面板显示「只用风格卡」却什么都不注入。
    library.mode = 'sample'
    library.updatedAt = Date.now()
    return { data: await persist(next) }
  }

  function libraryOf(data, wanted) {
    const key = str(wanted).trim()
    if (!key) throw new Error('要指定样文库名或 id')
    const library = data.libraries.find(item => item.id === key) || data.libraries.find(item => item.name === key)
    if (!library) throw new Error('没有样文库「' + key + '」')
    return library
  }

  /** 调本局后台模型跑一次，拿回一段文本。 */
  async function runPrompt(gameId, prompt) {
    if (!str(gameId)) throw new Error('这一步需要一个打开的对局（后台模型按局配置）')
    try {
      const result = await tavern.runTask({ gameId: str(gameId), prompt })
      return str(result && result.text)
    } catch (error) {
      throw new Error('调用后台模型失败：' + (error && error.message ? error.message : error) + '（这一局需要在设置里配置后台模型）')
    }
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
    if (cardOnly(library)) {
      return { ok: false, text: '这个库设成「只用风格卡」，摘录不参与注入；要换段就把注入方式改成「摘录＋风格卡」。' }
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
    if (!hit) return { text: '', via: '', turn, chars: 0, cardChars: 0, sampleChars: 0 }
    const place = indexInPool(hit.library, hit.sample)
    const text = sectionText(hit.library, hit.sample)
    const sampleText = hit.sample ? hit.sample.text : ''
    const cardText = usesCard(hit.library) ? cardDigest(hit.library.card) : ''
    return {
      // text 是真正会注入的完整段落（含说明头、规则、原文），调试对照用；
      // sampleText 只有原文、cardText 只有风格卡，面板上给用户看的是这两样——
      // 规则说明对读者没意义，混在一起还会让人以为规则是样文自带的文字。
      text,
      sampleText,
      cardText,
      // 字数：开了「摘录＋风格卡」每轮多花多少，用户得看得见才谈得上取舍
      chars: text.length,
      cardChars: cardText.length,
      sampleChars: sampleText.length,
      mode: hit.library.mode,
      via: hit.via, turn,
      library: hit.library.name, libraryId: hit.library.id,
      sample: hit.sample ? hit.sample.id : '', sampleSource: hit.sample ? hit.sample.source : '',
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
      const reason = data.libraries.length === 0
        ? '还没有样文库。'
        : (active.libraryId ? '选中的库没有样文，也没有风格卡。' : '本局没有选样文库。')
      return {
        on: false, turn, via: '', library: '', quote: '', source: '', index: 0, total: 0,
        card: false, mode: 'sample', hint: reason,
      }
    }
    const place = indexInPool(hit.library, hit.sample)
    return {
      on: true,
      turn,
      via: hit.via,
      markerTag: marker ? marker[1] : '',
      library: hit.library.name,
      libraryId: hit.library.id,
      source: hit.sample ? hit.sample.source : '',
      // 只用风格卡时没有摘录可显示，就用卡里的三行观察顶替引文位置。
      quote: hit.sample ? hit.sample.text : cardBrief(hit.library.card),
      tags: hit.sample ? hit.sample.tags : (hit.library.tags || []),
      index: place.index || 1,
      total: place.total || hit.library.samples.length,
      card: usesCard(hit.library),
      mode: hit.library.mode,
      // 这一轮实际会占用多少字（和真正注入的是同一段文本）
      chars: sectionText(hit.library, hit.sample).length,
    }
  })

  // ── 风格卡：存、清、提炼、盲测、导出 ──────────────────────────
  handle('card-save', async ({ libraryId, card } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    const out = await writeCard(library.id, card)
    return { data: out.data, card: out.card, libraryId: library.id }
  })

  handle('card-clear', async ({ libraryId } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    return await clearCard(library.id)
  })

  // 恢复上一版：把当前这张换回 previous。
  // 恢复之后「上一版」变成刚才那张，所以连着点两次会在两版之间来回，不会丢东西。
  handle('card-restore', async ({ libraryId } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    const previous = library.card && library.card.previous
    if (!hasCard(previous)) throw new Error('这个库没有上一版可以恢复')
    const out = await writeCard(
      library.id,
      { ...previous, previous: normalizeCard(library.card, false) },
      { keepPrevious: false },
    )
    return { data: out.data, card: out.card, libraryId: library.id }
  })

  // 用本局后台模型把整库摘录提炼成一张卡。素材只取库里的摘录——
  // 素材库里用户引用的原始材料插件读不到（那是 Tavern 的内部目录）。
  handle('card-distill', async ({ gameId, libraryId } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    if (library.samples.length === 0) throw new Error('这个库还没有样文，先存几段再提炼')
    const reply = await runPrompt(gameId, distillPrompt(library))
    const card = parseCardReply(reply)
    if (!card) {
      throw new Error('模型没有给出可用的风格卡：' + str(reply).slice(0, 160))
    }
    // 模型不知道语料规模，用库里的真实情况覆盖一次。
    card.corpus = {
      articles: library.samples.length,
      chars: library.samples.reduce((sum, item) => sum + item.text.length, 0),
    }
    const out = await writeCard(library.id, card)
    return { data: out.data, card: out.card, libraryId: library.id }
  })

  // 盲测：不给原文，只按卡写一段，再让它自己打分。写出来像不像，用户一眼就能判。
  handle('card-test', async ({ gameId, libraryId } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    if (!hasCard(library.card)) throw new Error('这个库还没有风格卡，先提炼一张')
    const reply = await runPrompt(gameId, blindTestPrompt(library))
    const out = parseTestReply(reply)
    if (!out.text) throw new Error('模型没有给出试写内容：' + str(reply).slice(0, 160))
    // 只把分数写进卡；试写正文随返回值给面板显示，不落盘。
    // keepPrevious:false —— 改个分数不算一次「重新提炼」，不该占用上一版的位置。
    const saved = await writeCard(library.id, {
      ...library.card,
      match: out.match || library.card.match,
    }, { keepPrevious: false })
    return { data: saved.data, card: saved.card, text: out.text, match: out.match, libraryId: library.id }
  })

  // 导出便携 Prompt：不调模型，纯拼装，任何 LLM 都能用。
  handle('export-prompt', async ({ libraryId } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    return { text: cardPrompt(library), name: library.name }
  })

  // 导入：把导出的 Prompt 原样贴回来（或贴一份同格式的手写卡）。
  handle('card-import', async ({ libraryId, text } = {}) => {
    const data = await load()
    const library = libraryOf(data, libraryId)
    const source = str(text).trim()
    if (!source) throw new Error('先把风格卡贴进来再导入')
    const card = parseCardPrompt(source)
    if (!card) {
      throw new Error('没从这段文字里认出风格卡：需要有「## 铁律」「### 词汇」这类标题，'
        + '直接贴「导出 Prompt」的原文最稳。')
    }
    const out = await writeCard(library.id, card)
    return { data: out.data, card: out.card, libraryId: library.id }
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
          : ['现有样文库：'].concat(libraries.map(item => '- 「' + item.name + '」'
            + (item.tags.length ? ' · ' + item.tags.join('／') : '')
            + ' · ' + item.count + ' 条'
            + (item.hasCard ? ' · 有风格卡' + (item.cardMatch ? '（自评 ' + item.cardMatch + '%）' : '') : ' · 还没有风格卡')
            + (item.note ? ' · ' + item.note : '')))
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
      description: '新建一个样文库，或改已有库的名称、笔调标签与注入方式。建库本身不存样文，存摘录用 style_sample_save_many；'
        + '攒够摘录后可以用 style_card_save 存一张风格卡（见 style-library Skill）。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: {
          name: { type: 'string', description: '库名，例如「冷峻武侠」。同名会报错，要改已有库就传 id。' },
          id: { type: 'string', description: '要修改的库 id；省略表示新建。' },
          tags: { type: 'array', items: { type: 'string' }, description: '这个库整体偏哪些笔调，最多 12 个。' },
          note: { type: 'string', description: '一两句说明，例如出自哪本书。' },
          mode: { type: 'string', enum: ['sample', 'both', 'card'], description: '每轮注入什么：sample 只用摘录（默认）、both 摘录＋风格卡、card 只用风格卡。省略则不改。' },
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
        const library = out.data.libraries.find(item => item.id === out.id)
        return {
          id: out.id,
          name: str(args && args.name).trim(),
          text: '已保存样文库「' + str(args && args.name).trim() + '」（id: ' + out.id + '，注入：'
            + ((library && library.mode) || 'sample') + '）。接着用 style_sample_save_many 批量存摘录。',
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
      description: '把某个样文库设为本局使用的文风来源。设了之后，每轮写正文都会带上它的笔调参考'
        + '（一段原文，或者它提炼出的风格卡，看这个库的注入方式）。传空库名表示取消。',
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
        // 没有摘录时，只有「卡会真的进注入」才算可用——否则选了等于什么都没带。
        if (library.samples.length === 0 && !usesCard(library)) {
          throw new Error(library.card
            ? '「' + library.name + '」里没有摘录，注入方式又是「只用摘录」，这一局什么都不会带。把注入方式改成「摘录＋风格卡」或「只用风格卡」再用。'
            : '「' + library.name + '」里还没有样文，先存几段')
        }
        await writeSelection(gameId, library.id, '')
        return {
          ok: true,
          text: '本局改用样文库「' + library.name + '」，之后每轮正文都会带它的笔调参考'
            + (usesCard(library) ? '（含风格卡）。' : '。'),
        }
      },
    })

    // ── 风格卡工具 ────────────────────────────────────────────
    // 分析框架在 style-library Skill 里：Agent 读完材料按 9 个维度分析，
    // 再把结果按这里的形状存进来。存进来的东西会跟摘录一起注入正文。
    add({
      name: 'style_card_save',
      description: '把一张风格卡存到某个样文库上（整库一份，会覆盖旧的）。'
        + '卡是分析 7+1 维度后写出的结构化结论：维度观察、写作基因、铁律、禁用清单、AI 腔黑名单。'
        + '内容要求：量化、只写反复出现 3 次以上的特征、保留矛盾、不用通用写作建议凑数。'
        + '存之前先 style_card_get 看一眼旧卡，有就做增量修订，不要整张重写。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['library', 'card'],
        properties: {
          library: { type: 'string', description: '库名或库 id。' },
          card: {
            type: 'object', additionalProperties: false,
            properties: {
              author: { type: 'string', description: '作者或书名，不知道就留空。' },
              genre: { type: 'string', description: '体裁，例如「武侠短篇」。' },
              summary: { type: 'string', description: '300 字以内的指纹小结。' },
              corpus: {
                type: 'object', additionalProperties: false,
                properties: {
                  articles: { type: 'number', description: '分析用了多少段/篇材料。' },
                  chars: { type: 'number', description: '材料总字数。' },
                },
              },
              dimensions: {
                type: 'object', additionalProperties: false,
                description: '九个维度，每个维度 3～5 条量化观察，每条不超过 140 字。',
                properties: {
                  lexical: { type: 'array', items: { type: 'string' }, description: '词汇：高频词、指纹词、搭配、用词质感。' },
                  syntactic: { type: 'array', items: { type: 'string' }, description: '句法：平均句长、长短句分布、标点指纹、段落节奏。' },
                  tonal: { type: 'array', items: { type: 'string' }, description: '语气：口语化程度、冷热、断言强弱、句长波动。' },
                  discourse: { type: 'array', items: { type: 'string' }, description: '篇章：开头怎么起、场景怎么推进、在哪收。' },
                  rhetoric: { type: 'array', items: { type: 'string' }, description: '修辞：比喻密度与取材、排比、设问、具体与抽象的比例。' },
                  emotion: { type: 'array', items: { type: 'string' }, description: '情感：极性、弧线、克制度。' },
                  perspective: { type: 'array', items: { type: 'string' }, description: '视角：人称、聚焦方式、价值词。' },
                  imagery: { type: 'array', items: { type: 'string' }, description: '感官：视觉/听觉/触觉的权重，有没有通感。' },
                  dialogue: { type: 'array', items: { type: 'string' }, description: '对白：长度、提示语、人物用词的区别。' },
                },
              },
              genes: {
                type: 'array', description: '3～5 条写作基因：跨两个以上维度验证过、删掉就不像了的特征。',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    name: { type: 'string', description: '4～6 字的名称。' },
                    text: { type: 'string', description: '一句话说清它是什么、由哪几个维度支撑。' },
                  },
                },
              },
              laws: { type: 'array', items: { type: 'string' }, description: '6～10 条铁律，落到操作层，能照着写也能自检。' },
              disallowed: { type: 'array', items: { type: 'string' }, description: '5～10 条：这段文字从不做的事。' },
              aiBan: { type: 'array', items: { type: 'string' }, description: 'AI 腔词句黑名单，最多 20 个。' },
              mantra: { type: 'string', description: '30 字以内的起笔口诀。' },
              formula: { type: 'string', description: '推荐的叙事公式，一句话说明为什么。' },
              match: { type: 'number', description: '盲测自评的贴合度 0～100，没测就不填。' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean' }, library: { type: 'string' },
            counts: { type: 'object', additionalProperties: true },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      async execute(args) {
        const wanted = str(args && args.library).trim()
        if (!wanted) throw new Error('要指定样文库名或 id')
        const data = await load()
        const library = libraryOf(data, wanted)
        const out = await writeCard(library.id, args && args.card)
        const card = out.card
        const counts = {
          dimensions: Object.keys(card.dimensions).length,
          genes: card.genes.length,
          laws: card.laws.length,
          disallowed: card.disallowed.length,
          aiBan: card.aiBan.length,
        }
        return {
          ok: true,
          library: library.name,
          counts,
          text: '风格卡已存进「' + library.name + '」：' + counts.dimensions + ' 个维度、'
            + counts.genes + ' 条写作基因、' + counts.laws + ' 条铁律、'
            + counts.disallowed + ' 条禁用、' + counts.aiBan + ' 个 AI 腔词。\n'
            + '这一步还没让它真正生效：要注入得把这个库的 mode 设成 both 或 card'
            + '（style_library_save 传 mode），或者提醒用户去面板里改。',
        }
      },
    })

    add({
      name: 'style_card_get',
      description: '读某个样文库现有的风格卡（维度观察、基因、铁律、禁用清单）和它当前的注入方式。'
        + '要在旧卡上做增量修订、或想知道这个库还缺什么时先调它。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['library'],
        properties: { library: { type: 'string', description: '库名或库 id。' } },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            ok: { type: 'boolean' }, mode: { type: 'string' },
            card: { type: 'object', additionalProperties: true },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const data = await load(true)
        const library = libraryOf(data, args && args.library)
        if (!hasCard(library.card)) {
          return {
            // 输出 schema 声明 card 是 object，这里给空对象而不是 null——
            // 校验按 schema 走的话，null 会让整次调用被判定为不合格。
            ok: false, mode: library.mode, card: {},
            text: '「' + library.name + '」还没有风格卡。库里现有 ' + library.samples.length
              + ' 条摘录，可以先读这些摘录做分析，再用 style_card_save 存卡。',
          }
        }
        return {
          ok: true, mode: library.mode, card: library.card,
          text: '「' + library.name + '」的风格卡（注入方式：' + library.mode + '）：\n' + cardDigest(library.card),
        }
      },
    })

    return () => { for (const dispose of disposers) { try { dispose() } catch { /* 忽略 */ } } }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => registerTools())
  else registerTools()

  // 自带的 Skill：建库 + 提炼卡是同一个流程，放在一个 SKILL.md 里。
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
