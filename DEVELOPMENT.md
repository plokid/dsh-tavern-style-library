# 开发与实现说明

面向要改这个插件、或者想知道它内部怎么运作的人。只想知道怎么用，看 [README.md](README.md)。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 宿主侧：数据读写、轮换逻辑、注入、风格卡、Agent 工具、Skill 注册 |
| `client.js` | 浏览器侧：侧栏面板、状态分节（`ctx.tavernUi`） |
| `package.json` | 插件元信息，`name` 必须与浏览器侧返回的 `name` 一致 |
| `skills/style-library/` | Agent Skill：建库 + 提炼卡一条流程（含 `references/`：维度框架、叙事公式） |
| `verify.mjs` | 宿主侧测试 |
| `smoke-client.mjs` | 浏览器侧测试 |

## 跑测试

```sh
node verify.mjs        # 宿主侧：切段、轮换、工具行为、注入、风格卡、上一版、容错（103 项）
node smoke-client.mjs  # 浏览器侧：注册接线、布局约定、组件渲染、交互（48 项）
```

两个都用假的 `tavern` / `tavernUi` / `tools` 服务跑真实代码路径，不连真环境，也不需要装任何依赖。

改了 `index.mjs` 需要重启 DSH；改了 `client.js` 刷新页面即可。

### 浏览器侧的两种 React 替身

`smoke-client.mjs` 里有两份最小 React，用途不同：

| 替身 | 能做什么 | 用来测 |
| --- | --- | --- |
| `React`（静态） | `createElement` + 空 hooks | 注册接线、类名、布局约定、源码里的约定 |
| `makeRuntime()`（会更新） | 状态真的更新、真的重渲染、能派发事件 | 点按钮、改输入框、保存、失败回滚 |

交互测试的写法：`runtime.mount(createElement(Editor, props))` → `byText` / `byLabel` 找到节点 → 调 `props.onClick()` / `props.onChange({target:{value}})` → `await runtime.settle()` → 断言宿主收到了什么。同一份源码配不同的 React 各加载一次（`loadWith(react)`），互不干扰。

三个坑，改这个文件前先看一眼：

1. **组件必须用 `createElement` 挂上去**，不能 `Editor(props)` 直接调用——直接调用等于在渲染器外面跑，hook 全落到错误的槽位上。
2. **`props.children` 要摊成 children**。`<Button>编辑</Button>` 的文案是走 `props.children` 进的（`Button` 把 `...rest` 整个透传给 `<button>`），替身不认这条，按钮上的字就读不到，「按文案找按钮」永远找不到。
3. **一次 `mount` 就是一棵新树**，要清空槽位；不清的话第二次挂载会复用上一次的状态，测出来的是上一棵树。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| DSH Tavern | 插件接口 ≥ 2 |
| 注册的 UI 接口 | `registerPanel`、`registerStatusSection`、`openOverlay`、`callHost` |
| 使用的主机接口 | `turnSection`、`handle`、`runTask`、`readPluginData` / `savePluginData`、`readGameData` / `saveGameData`、`toolModes`、`skillSource` |
| DSH 服务 | `tools` |

只使用 Tavern 公开插件接口（`docs/plugin-api*.md`），不改 Tavern 源码，不读 Tavern 数据文件。Tavern 升级不需要跟着改；万一公开接口本身发生不兼容变化，才需要适配。

## 注入方式

用 `turnSection` 追加到本轮上下文尾部，不改提示词前缀：

- 系统提示、规则、历史对话这些前缀没有被动过，**不降低缓存命中率**。
- 注入的那一段每轮内容都不同，按新 token 计费。
- 不进世界书条目池，不会诱发额外的预筛调用。

`sectionText()` 同时供 `turnSection`（真正注入给模型）和 `handle('preview')`（面板展示）使用。面板只显示 `sampleText`（纯原文）和 `cardText`（纯风格卡），因为「只借它的笔调、不要借它的情节」那段规则是给模型看的，混在预览里会让人以为规则也算样文的一部分。

一段注入里的顺序是：标题 → 规则 → 风格卡（可选）→ 参考原文（可选）。三个可选段的取舍由库的 `mode` 决定：

| mode | 卡 | 原文 |
| --- | --- | --- |
| `sample`（默认） | — | ✅ |
| `both` | ✅ | ✅ |
| `card` | ✅ | — |

`mode` 是**每库**的，存在库里而不是对局数据里。设成 `card` 但卡被清掉时，`cardOnly()` 为假，自动退回只用摘录——不做这个兜底，用户看到的就是「注入了空段落」。

注入总长上限 7800 字。风格卡摘要单独限 2600 字（`MAX_CARD_DIGEST`），余下的空间留给摘录。正常一张卡只有几百到一千多字，够用。

## 风格卡

一张卡是整库一份，形状固定（`normalizeCard()` 收口）：

```js
{
  author, genre, platform,
  corpus: { articles, chars },
  summary,                                   // 指纹小结 ≤ 300 字，只在面板和导出里用，不进注入
  dimensions: { lexical: [...], ... },        // 九个维度，每维 ≤ 5 条、每条 ≤ 140 字
  genes: [{ name, text }],                    // 写作基因 ≤ 5
  laws: [...],                                // 铁律 ≤ 10
  disallowed: [...],                          // 从不出现 ≤ 10
  aiBan: [...],                               // AI 腔词表 ≤ 20
  mantra, formula, match, updatedAt,
  previous: { ...同上，但自己不再带 previous },   // 上一版，只留一层
}
```

**`previous` 是「覆盖前的快照」，用来给「恢复上一版」兜底。** 三条规则：

1. 只在内容真的变了时才写（`cardFingerprint()` 比较时抹掉 `updatedAt` 和 `previous`）——原样再存一次不该挤掉退路。
2. `keepPrevious: false` 用于不算版本的写入：试写只改分数、以及「恢复上一版」自身（它要显式把自己塞进 `previous`，才能在两版之间来回）。
3. 卡快顶到字节上限时先丢 `previous`，别让主内容存不进去——和「试写不落盘」是同一个取舍：附属信息让步于主体。

三处要注意：

1. **收口比校验重要。** 卡是模型写的 JSON，键名一定不规整。`DIMENSION_ALIAS` 认中英文两套键（「词汇」「lexical」「句式」「标点」「五感」「对白」都会落到对应维度），不认识的键直接丢。基因既接受 `{name, text}` 也接受 `"名称：说明"` 字符串。
2. **「有没有卡」和「卡的内容」要分开判。** `normalizeCard()` 会补 `updatedAt`，每次调用都产生新对象；判断存在性用 `hasCard()` / `normalizeCardLite()`，只看有没有实质内容。空卡（只有 author 没有条目）一律当没有。
3. **`card-clear` 顺手把 `mode` 改回 `sample`。** 否则面板显示「只用风格卡」却什么都不注入。

三种产出方式：

| 入口 | 怎么来的 | 模型调用 |
| --- | --- | --- |
| `handle('card-distill')` | 面板「AI 提炼」，`distillPrompt()` 取库里最多 12 段（沿全文均匀取样，不是只取开头）、每段截 700 字 | 1 次 |
| `style_card_save` 工具 | Agent 按 `style-library` Skill 分析完自己填 | 0 次（Agent 自己就是那次调用） |
| `card-test` | 面板「试写一段」，`blindTestPrompt()` 只给卡、不给原文，写完自评匹配度。**正文只回给面板显示，不落盘** | 1 次 |

`parseCardReply()` 从回复里抠 JSON，顺序是：整段 → ```` ```json ```` 块 → 第一个 `{` 到最后一个 `}`。三层都失败才报错，并把回复前 160 字贴出来——不贴的话用户只知道「失败了」，不知道是模型跑题还是格式没跟上。

`card-distill` 会把 `corpus` 按库里的真实情况覆盖一次：模型不知道你存了多少字，让它自己填一定是错的。

`export-prompt` 是纯拼装、不调模型：把卡渲染成一段自包含的 Markdown，可以直接粘给任何 LLM。和注入用的 `cardDigest()` 是两个东西——后者要短，前者要全。

**两张渲染的取舍**：

| | `cardDigest()`（每轮注入） | `cardPrompt()`（导出） |
| --- | --- | --- |
| 维度 | 一行一个，分号连 | 一节一个，列表 |
| 指纹小结 `summary` | **不写** | 写 |
| 铁律 / 禁用 / AI 腔 | 压成紧凑的单行 | 逐条列表 |
| 篇幅 | ≤ 2600 字 | 不限 |

`summary` 不进注入是有意的：它和九个维度的条目说的是一件事，每轮重复等于把预算花两次。也正因为如此，`normalizeCard()` 和 `normalizeCardLite()` 判断「有没有卡」时都不把 `summary` 算作实质内容——只有一句小结的卡注入出去只剩一行标题。

## 数据

| 内容 | 位置 |
| --- | --- |
| 样文库本体 | `plugin-data/dsh-tavern-style-library.json`（Tavern 数据目录下） |
| 本局选中 | 每局的插件数据，回退、分叉、导出存档的行为和 Tavern 其他按局数据一致 |

上限：总量 256 KB（接口硬上限，插件自己在 `DATA_BUDGET = 250 * 1024` 处先拦一道，留了余量给 JSON 结构开销）、单库 40 条、60 个库、单条 40～2000 字、标签池 200 个、每条样文 12 个标签、每库一张风格卡 ≤ 24 KB（`MAX_CARD_BYTES`，字段上限写满约 30 KB，所以这条是兜底）。

风格卡跟着库一起存在同一个 JSON 里，不是单独文件：它天然是「这个库的一部分」，分开存反而要处理两边不同步。卡超 24 KB 时 `writeCard()` 直接抛错，不做截断——截断会悄悄丢掉用户看不见的条目。

**默认标签只在第一次使用时播种一次。** `normalize()` 用 `Array.isArray(src.tags)` 判断是否已经存过数据：存过就以存储为准（哪怕是空数组），没存过才用 `DEFAULT_TAGS`。早先的写法是无条件从 `DEFAULT_TAGS` 起手再合并，导致内置标签怎么删都会在下次 `persist` 时被加回来。

## Agent 工具

插件注册九个工具，只在**卡片工作台**出现：

| 工具 | 干什么 |
| --- | --- |
| `style_library_list` | 列现有库、条数、标签池、有没有风格卡。建库前先调，避免重名 |
| `style_tags_update` | 管标签池：`add` / `set` / `remove` / `rename`。改名和删除会同步处理所有引用 |
| `style_library_save` | 新建库或改库名／标签／`mode` |
| `style_library_split` | 把长材料按段落切开，返回每段序号、字数和原文 |
| `style_sample_save_many` | **批量**存多条摘录，一次 5～20 条，建库主力 |
| `style_sample_save` | 存单条（补录或改某一条） |
| `style_library_pick` | 把某个库设为本局使用 |
| `style_card_get` | 读现有风格卡和注入方式。做增量修订前先调 |
| `style_card_save` | 存一张风格卡（会覆盖旧的）。字段形状见上面「风格卡」 |

一个 Skill，四段流程：

**[`style-library`](skills/style-library/SKILL.md)** 把「建库」和「提炼卡」串成同一条流程——它们本来就是一批材料上的前后两段，拆成两个 Skill 会让 Agent 和用户都要多判一次「现在该用哪个」：

1. **定标签**——读完材料自动拟 5～18 个笔调标签加进池子，列给用户看，**停下来等增删改**，确认后才继续。
2. **切段入库**——切段、给每段定一个主标签、**同标签的段落连续排在一起**，批量存入。条数按材料字数算（约「字数 ÷ 1500」，2 万字要 9～15 条），沿全文铺开不要只摘开头；只摘完整段落、原文逐字照抄。
3. **提炼卡**——给用户看一眼入库结果，**问一句再动手**；然后九个维度落数 → 合成基因／铁律／禁用／AI 腔 → `style_card_save` → 问要哪种 `mode` 并改。素材不到 3 条时拒绝提炼并说明原因。
4. **收尾**——`style_library_pick` 设成本局使用，告诉用户去哪看效果。

另外列了张「不必走完整流程」的表：用户只说「加几段摘录」或「改个标签」时，直接调对应工具，别硬拉一遍全流程。

`references/framework.md` 是维度定义和量化阈值（按中文小说校准过），`references/formulas.md` 是叙事公式。两份都在文件末尾保留了上游项目的 MIT 许可原文——`verify.mjs` 里那条「SKILL 提到的工具都真实存在」会扫整个 `skills/` 目录，改 SKILL 时记得只写已注册的工具名；另一条断言「只应有一个 Skill」防止以后又被拆开。

## 布局的坑

侧栏页面的高度靠这条容器链传下来（类名是 betterSidebar 压缩后的，结构稳定、hash 会变）：

```
pane          flex:1; min-height:0
paneContent   flex:1; min-height:0; overflow:hidden
paneTab       flex:1; min-height:0
nativeTabHost height:100%; min-height:0; display:flex; flex-direction:column  ← 插件的父
```

`.dsl-page` 是 `nativeTabHost` 的直接子项，所以**必须**写 `flex: 1; min-height: 0`。只写 `height: 100%` 不管用：flex 子项默认 `min-height: auto`，内容一长就把它撑破，`overflow-y: auto` 永远触发不了。同理 `.dsl-page-body` 要 `flex: 1; min-height: 0`，它的直接子项要 `flex: none`。

滚动定位（点「编辑」或「删除」后把那条滚进视野）不要用 `scrollIntoView`：它会向外冒泡找可滚动祖先，在这种多层 flex 嵌套里经常一声不响地什么都不做。自己算位置直接写 `box.scrollTop`，并处理靠末尾时被 `maxScroll` 夹住的情况（改成底边对齐）。

## 删除确认

三处删除（库、标签、单条样文）都走面板内的 `ConfirmBar`，不用浏览器原生弹窗——样式不可控，而且在宿主的 iframe 里可能被直接拦掉，点了什么都不发生，比没有确认更糟。
