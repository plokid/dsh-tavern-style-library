# 开发与实现说明

面向要改这个插件、或者想知道它内部怎么运作的人。只想知道怎么用，看 [README.md](README.md)。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 宿主侧：数据读写、轮换逻辑、注入、Agent 工具、Skill 注册 |
| `client.js` | 浏览器侧：侧栏面板、状态分节（`ctx.tavernUi`） |
| `package.json` | 插件元信息，`name` 必须与浏览器侧返回的 `name` 一致 |
| `skills/create-style-library/` | 建库用的 Agent Skill |
| `verify.mjs` | 宿主侧测试 |
| `smoke-client.mjs` | 浏览器侧测试 |

## 跑测试

```sh
node verify.mjs        # 宿主侧：切段、轮换、工具行为、注入逻辑、容错（69 项）
node smoke-client.mjs  # 浏览器侧：模块加载、注册调用、布局与交互约定（35 项）
```

两个都用假的 `tavern` / `tavernUi` / `tools` 服务跑真实代码路径，不连真环境，也不需要装任何依赖。

改了 `index.mjs` 需要重启 DSH；改了 `client.js` 刷新页面即可。

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

`sectionText()` 同时供 `turnSection`（真正注入给模型）和 `handle('preview')`（面板展示）使用。面板只显示 `sampleText`（纯原文），因为「只借它的笔调、不要借它的情节」那段规则是给模型看的，混在预览里会让人以为规则也算样文的一部分。

注入总长上限 7800 字，正常单条摘录远达不到，只有手动改 JSON 塞超长样文时才可能截断。

## 数据

| 内容 | 位置 |
| --- | --- |
| 样文库本体 | `plugin-data/dsh-tavern-style-library.json`（Tavern 数据目录下） |
| 本局选中 | 每局的插件数据，回退、分叉、导出存档的行为和 Tavern 其他按局数据一致 |

上限：总量 256 KB（接口硬上限，插件自己在 `DATA_BUDGET = 250 * 1024` 处先拦一道，留了余量给 JSON 结构开销）、单库 40 条、60 个库、单条 40～2000 字、标签池 200 个、每条样文 12 个标签。

**默认标签只在第一次使用时播种一次。** `normalize()` 用 `Array.isArray(src.tags)` 判断是否已经存过数据：存过就以存储为准（哪怕是空数组），没存过才用 `DEFAULT_TAGS`。早先的写法是无条件从 `DEFAULT_TAGS` 起手再合并，导致内置标签怎么删都会在下次 `persist` 时被加回来。

## Agent 工具

插件注册七个工具，只在**卡片工作台**出现：

| 工具 | 干什么 |
| --- | --- |
| `style_library_list` | 列现有库、条数、标签池。建库前先调，避免重名 |
| `style_tags_update` | 管标签池：`add` / `set` / `remove` / `rename`。改名和删除会同步处理所有引用 |
| `style_library_save` | 新建库或改库名／标签 |
| `style_library_split` | 把长材料按段落切开，返回每段序号、字数和原文 |
| `style_sample_save_many` | **批量**存多条摘录，一次 5～20 条，建库主力 |
| `style_sample_save` | 存单条（补录或改某一条） |
| `style_library_pick` | 把某个库设为本局使用 |

配套的 [`create-style-library`](skills/create-style-library/SKILL.md) Skill 是**两阶段**的：

1. **先定标签**——读完材料自动拟 5～18 个笔调标签加进池子，列给用户看，**停下来等用户增删改**，确认后才继续。
2. **再按标签切分**——切段、给每段定一个主标签、**同标签的段落连续排在一起**，然后批量存入。库里因此是「一种笔调一组」，轮换时同类笔调连着出现，注入的参考风格更稳。

条数按材料字数算（约「字数 ÷ 1500」，2 万字要 9～15 条），沿全文铺开不要只摘开头；只摘完整段落、原文逐字照抄、标签只描述笔调不描述题材。

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
