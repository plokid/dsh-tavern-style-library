// dsh-tavern-style-library — 浏览器侧
//
// 由浏览器直接加载，不需要打包。改完几秒内自动生效。
// load 的 id 必须和 package.json 的 name 一致。
//
// 界面：侧栏「样文库」面板 + 输入框上方「文风」按钮 + 「酒馆状态」页的一节
//
// 样式：复用 Tavern 自己的类名（dsh-tavern-settings-*）和 CSS 变量，
// 让面板长在侧栏里、跟 Tavern 其他页一致，不再用内联样式另起一套。

window.__ModuleLoader__.load({
  id: 'dsh-tavern-style-library',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const SELF = 'dsh-tavern-style-library'
    const API_MIN = 2
    const MAX_SAMPLE_CHARS = 2000

    // ── 插件自己的样式 ────────────────────────────────────────────
    // 只定义 Tavern 没有的东西（样文条目、标签、引文块），
    // 颜色一律取 Tavern 的设计变量，暗色模式自动跟随。
    const STYLE_ID = 'dsh-tavern-style-library-css'

    const CSS = [
      '.dsl-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }',
      '.dsl-actions.is-tight { gap: 6px; }',
      '.dsl-spacer { flex: 1 1 auto; }',

      '.dsl-btn { height: 32px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;',
      '  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer;',
      '  transition: border-color .18s, color .18s, background .18s; }',
      '.dsl-btn:hover:not(:disabled) { border-color: var(--dsh-tavern-accent); color: var(--dsh-tavern-accent);',
      '  background: color-mix(in srgb, var(--dsh-tavern-accent) 8%, transparent); }',
      '.dsl-btn:disabled { opacity: .55; cursor: default; }',
      '.dsl-btn.is-primary { border-color: var(--dsh-tavern-accent); color: var(--dsh-tavern-accent);',
      '  background: color-mix(in srgb, var(--dsh-tavern-accent) 8%, transparent); }',
      '.dsl-btn.is-danger:hover:not(:disabled) { border-color: var(--dsh-tavern-accent-error); color: var(--dsh-tavern-accent-error); background: transparent; }',
      '.dsl-btn.is-small { height: 26px; padding: 0 9px; font-size: 11px; }',

      // 页面骨架照 Tavern 自带侧栏页（Skill 库、预设库）的写法：
      // 外层占满高度、纵向 flex，头部固定不滚，列表区自己滚。
      //
      // 高度是怎么传下来的（dsh-better-sidebar 的类名，压缩后就这一组）：
      //   pane          flex:1; min-height:0
      //   paneContent   flex:1; min-height:0; overflow:hidden
      //   paneTab       flex:1; min-height:0
      //   nativeTabHost height:100%; min-height:0; display:flex; flex-direction:column  ← 我们的父
      // 下面这层就是 nativeTabHost 的直接子项，所以**必须**带 flex:1 + min-height:0。
      // 只写 height:100% 的话，在 flex 父容器里子项默认 min-height:auto，
      // 内容一长就把它撑过容器高度，overflow-y:auto 永远触发不了——滚动就是这么丢的。
      '.dsl-page { flex: 1; min-height: 0; box-sizing: border-box; display: flex; flex-direction: column;',
      '  color: var(--dsw-alias-label-primary); background: var(--dsw-specific-sidebar-fill); }',
      '.dsl-page-head { flex: none; display: flex; align-items: center; gap: 8px;',
      '  padding: 16px 16px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }',
      '.dsl-page-title { font-size: 18px; font-weight: 400; letter-spacing: -0.2px;',
      '  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      // min-height:0 同样不能少：它是 .dsl-page 的 flex 子项，默认 auto 会撑破父级。
      '.dsl-page-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;',
      '  overscroll-behavior: contain; padding: 12px 14px 20px;',
      '  display: flex; flex-direction: column; gap: 14px; }',
      // 内容块不许被压：.dsl-page-body 是纵向 flex，子项默认 flex-shrink:1，
      // 高度不够时每一块都被挤扁，看起来就是「滚不动、条目叠在一起」。
      '.dsl-page-body > * { flex: none; }',

      '.dsl-section { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; }',
      '.dsl-group-label { padding: 12px 16px 4px; font-size: 13px; font-weight: 650; }',
      '.dsl-section-head { display: flex; align-items: center; gap: 10px; }',
      '.dsl-section-title { margin: 0; font-size: 15px; font-weight: 650; }',
      '.dsl-field { display: flex; flex-direction: column; gap: 6px; }',
      '.dsl-field-label { font-size: 13px; font-weight: 650; }',
      '.dsl-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }',
      '.dsl-hint.is-warn { color: #b7791f; }',
      '.dsl-error { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsh-tavern-accent-error); }',

      '.dsl-input, .dsl-area, .dsl-select { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2);',
      '  border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 13px; padding: 8px 10px; }',
      '.dsl-area { min-height: 110px; resize: vertical; line-height: 1.7; }',
      '.dsl-input:focus, .dsl-area:focus, .dsl-select:focus { outline: none; border-color: var(--dsh-tavern-accent); }',
      '.dsl-select { cursor: pointer; }',

      '.dsl-item { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;',
      '  border-top: 1px solid var(--dsw-alias-border-l2); }',
      '.dsl-item.is-active { background: color-mix(in srgb, var(--dsh-tavern-accent) 7%, transparent); }',
      // 正在就地编辑的那条：左边一道色条 + 淡底，一眼能看出现在在改哪一段。
      '.dsl-item.is-editing { background: color-mix(in srgb, var(--dsh-tavern-accent) 6%, transparent);',
      '  box-shadow: inset 3px 0 0 var(--dsh-tavern-accent); }',
      '.dsl-inline-edit { display: flex; flex-direction: column; gap: 8px; padding-top: 4px;',
      '  border-top: 1px dashed var(--dsw-alias-border-l2); margin-top: 2px; }',
      '.dsl-inline-edit .dsl-area { min-height: 150px; }',
      '.dsl-item-head { display: flex; align-items: flex-start; gap: 10px; }',
      '.dsl-item-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }',
      '.dsl-item-title { font-size: 14px; font-weight: 650; }',
      '.dsl-item-meta { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-tertiary); }',

      // 删除的二级确认：就地展开在条目里，不弹原生 confirm（那东西不可控、也难看）
      '.dsl-confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;',
      '  border-radius: 10px; border: 1px solid color-mix(in srgb, var(--dsh-tavern-accent-error) 35%, transparent);',
      '  background: color-mix(in srgb, var(--dsh-tavern-accent-error) 8%, transparent); }',
      '.dsl-confirm-text { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsh-tavern-accent-error); }',
      '.dsl-confirm-text b { font-weight: 650; }',
      '.dsl-confirm-actions { display: flex; gap: 8px; flex-wrap: wrap; }',
      '.dsl-btn.is-danger-solid { border-color: var(--dsh-tavern-accent-error);',
      '  background: var(--dsh-tavern-accent-error); color: var(--dsw-alias-label-primary-foreground); }',
      '.dsl-btn.is-danger-solid:hover:not(:disabled) { filter: brightness(1.06); }',
      '.dsl-badge { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px;',
      '  border: 1px solid var(--dsh-tavern-accent-border); color: var(--dsh-tavern-accent);',
      '  background: color-mix(in srgb, var(--dsh-tavern-accent) 10%, transparent); }',

      // flex:none —— .dsl-item 是纵向 flex，不写这个它会被压到比 max-height 还矮，
      // 里面的 overflow:auto 就没意义了。
      '.dsl-quote { flex: none; border-left: 2px solid var(--dsw-alias-border-l2); padding: 2px 0 2px 12px; margin: 0;',
      '  font-size: 12px; line-height: 1.75; color: var(--dsw-alias-label-secondary);',
      '  white-space: pre-wrap; overflow: auto; max-height: 110px; }',
      '.dsl-quote.is-open { max-height: 340px; }',
      '.dsl-quote.is-clickable { cursor: pointer; }',

      '.dsl-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.dsl-chip { padding: 3px 10px; border-radius: 999px; font: inherit; font-size: 12px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); }',
      '.dsl-chip:hover:not(:disabled) { border-color: var(--dsh-tavern-accent-border); color: var(--dsh-tavern-accent); }',
      '.dsl-chip.is-on { border-color: var(--dsh-tavern-accent-border); color: var(--dsh-tavern-accent);',
      '  background: color-mix(in srgb, var(--dsh-tavern-accent) 12%, transparent); }',
      '.dsl-chip:disabled { opacity: .55; cursor: default; }',

      '.dsl-chunk { display: flex; flex-direction: column; gap: 6px; padding: 10px 0;',
      '  border-top: 1px solid var(--dsw-alias-border-l2); }',
      '.dsl-chunk.is-off { opacity: .45; }',
      '.dsl-check { display: flex; align-items: center; gap: 8px; cursor: pointer;',
      '  font-size: 12px; color: var(--dsw-alias-label-secondary); }',

      // 状态分节：外观照原版「下一轮文风联想」那一节来，
      // 两节挨着排（Tavern 把插件分节排在自带各节之后）时读起来是一块。
      '.dsl-status-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-bottom: 6px; }',
      '.dsl-status-head > .dsl-status-label { margin: 0; flex-shrink: 0; }',
      '.dsl-status-label { margin-bottom: 7px; color: var(--dsw-alias-label-secondary);',
      '  font-size: 11px; font-weight: 700; letter-spacing: .06em; }',
      '.dsl-status-caption { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;',
      '  white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
      '.dsl-status-link { margin-left: auto; flex-shrink: 0; font: inherit; font-size: 12px;',
      '  color: var(--dsw-alias-label-tertiary); background: transparent; border: 0; padding: 0;',
      '  cursor: pointer; text-decoration: none; }',
      '.dsl-status-link:hover:not(:disabled) { color: var(--dsw-alias-label-primary); text-decoration: underline;',
      '  text-underline-offset: 3px; }',
      '.dsl-status-link:disabled { opacity: .55; cursor: default; }',
      '.dsl-status-quote { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.7;',
      '  white-space: pre-wrap; cursor: pointer; display: -webkit-box; -webkit-box-orient: vertical;',
      '  -webkit-line-clamp: 2; overflow: hidden; }',
      '.dsl-status-quote.is-expanded { display: block; -webkit-line-clamp: unset; }',
      '.dsl-status-quote.is-empty { cursor: default; -webkit-line-clamp: unset; opacity: .8; }',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const message = error => String((error && error.message) || error || '出错了')

    function call(ui, action, args) {
      return ui.callHost(SELF + '/' + action, args || {})
    }

    // 拼类名的小工具
    const cx = (...names) => names.filter(Boolean).join(' ')

    // ── 通用零件 ────────────────────────────────────────────────

    function Button({ primary, danger, solid, small, ...rest }) {
      return h('button', {
        type: 'button',
        ...rest,
        className: cx('dsl-btn', primary && 'is-primary', danger && 'is-danger',
          solid && danger && 'is-danger-solid', small && 'is-small', rest.className),
      })
    }

    // 删除前的二级确认条。第一次点「删除」不真的删，先在原地展开这一条，
    // 把「删什么、影响多大」说清楚，再点一次才执行。
    // 不用浏览器原生弹窗（confirm）：样式不可控、在某些宿主里还会被当成
    // 「页面弹窗」拦掉，点了没反应的体验比没有确认更糟。
    function ConfirmBar({ text, confirmLabel, busy, onConfirm, onCancel }) {
      return h('div', { className: 'dsl-confirm' },
        h('p', { className: 'dsl-confirm-text' }, text),
        h('div', { className: 'dsl-confirm-actions' },
          h(Button, { small: true, danger: true, solid: true, disabled: busy, onClick: onConfirm },
            busy ? '删除中…' : (confirmLabel || '确认删除')),
          h(Button, { small: true, disabled: busy, onClick: onCancel }, '取消'),
        ),
      )
    }

    function TagPicker({ all, value, onChange, onNewTag, label }) {
      const [custom, setCustom] = useState('')
      const toggle = tag => onChange(value.includes(tag) ? value.filter(item => item !== tag) : [...value, tag])
      const submit = async () => {
        const tag = custom.trim().replace(/\s+/g, '').slice(0, 16)
        if (!tag) return
        if (!value.includes(tag)) onChange([...value, tag])
        setCustom('')
        if (onNewTag && !all.includes(tag)) await onNewTag(tag)
      }
      const extra = value.filter(tag => !all.includes(tag))
      return h('div', { className: 'dsl-field' },
        label ? h('div', { className: 'dsl-field-label' }, label) : null,
        h('div', { className: 'dsl-chips' },
          [...all, ...extra].map(tag => h('button', {
            key: tag, type: 'button',
            className: cx('dsl-chip', value.includes(tag) && 'is-on'),
            onClick: () => toggle(tag),
          }, tag)),
        ),
        h('div', { className: 'dsl-actions is-tight' },
          h('input', {
            className: 'dsl-input', style: { flex: 1 }, value: custom, placeholder: '自定义标签',
            onChange: event => setCustom(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); submit() } },
          }),
          h(Button, { onClick: submit }, '添加'),
        ),
      )
    }

    // ── 样文库编辑（弹层）────────────────────────────────────────────

    function Editor({ gameId, ui, tags, library, onClose, onChanged }) {
      const empty = { id: '', name: '', tags: [], note: '', samples: [] }
      const [draft, setDraft] = useState(() => ({ ...empty, ...(library || {}) }))
      const [tagPool, setTagPool] = useState(tags || [])
      const [sample, setSample] = useState({ id: '', text: '', source: '', tags: [] })
      const [importText, setImportText] = useState('')
      const [importSource, setImportSource] = useState('')
      const [chunkSize, setChunkSize] = useState(500)
      const [chunks, setChunks] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      // 正在问「确定删这一段吗」的那一条的 id，空表示没有
      const [deleting, setDeleting] = useState('')

      const patch = changes => setDraft(current => ({ ...current, ...changes }))

      const resetSample = () => setSample({ id: '', text: '', source: '', tags: [] })

      // 把某一条滚进视野。编辑和删除确认共用，两者的毛病是一样的：
      // 被点的那条可能在屏幕外，不滚过去用户看到的还是「没反应」。
      //
      // 不用 scrollIntoView：它会向外冒泡找可滚动祖先，在这种多层 flex 嵌套
      // （pane > paneContent > paneTab > nativeTabHost > dsl-page > dsl-page-body）
      // 里经常一声不响地什么都不做（实测条目停在 3712px，完全在视野外）。
      // 自己算目标位置，直接写 scrollTop，行为确定。
      const scrollIntoViewOn = attribute => {
        if (typeof document === 'undefined') return
        // 等 React 把展开后的内容画出来再滚，否则量到的是展开前的高度。
        requestAnimationFrame(() => {
          const node = document.querySelector('[' + attribute + ']')
          if (!node) return
          const box = node.closest('.dsl-page-body')
          if (!box) return
          const boxRect = box.getBoundingClientRect()
          const nodeRect = node.getBoundingClientRect()
          const nodeHeight = nodeRect.height
          const boxHeight = boxRect.height
          const offsetTop = nodeRect.top - boxRect.top + box.scrollTop
          // 已经在视野里（整条都能看见）就不动，免得点中间那条时页面乱跳。
          if (offsetTop >= box.scrollTop && offsetTop + nodeHeight <= box.scrollTop + boxHeight) return

          // 默认让这条的顶边对齐内容区顶边。
          let target = offsetTop - 8
          // 靠末尾的几条顶边对齐后会超出可滚范围，scrollTop 会被夹住，
          // 这一条就还是露出大半截在下面。这种情况改成让底边对齐，
          // 保证整块都看得见。
          const maxScroll = box.scrollHeight - boxHeight
          if (target > maxScroll) target = Math.min(offsetTop, Math.max(0, offsetTop + nodeHeight - boxHeight + 12))
          box.scrollTop = Math.max(0, target)
        })
      }

      // 点某条样文的「编辑」：内容填进去，并把这条滚到视野里。
      const startEdit = item => {
        setSample({ ...item })
        setDeleting('')
        setError('')
        scrollIntoViewOn('data-editing-sample="' + item.id + '"')
      }

      // 点「删除」：不真删，就地换成确认条再问一次。
      const askDelete = item => {
        resetSample()
        setDeleting(item.id)
        setError('')
        scrollIntoViewOn('data-editing-confirm="' + item.id + '"')
      }

      const addTag = async tag => {
        try {
          const result = await call(ui, 'add-tag', { tag })
          setTagPool(result.data.tags)
        } catch (error) { setError(message(error)) }
      }

      const saveLibrary = async () => {
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'save-library', { library: draft })
          const fresh = (result.data.libraries || []).find(item => item.id === result.id)
          if (fresh) setDraft(fresh)
          setTagPool(result.data.tags)
          if (onChanged) onChanged(result.data)
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const saveSample = async () => {
        if (!draft.id) { setError('先保存样文库，再添加样文'); return }
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'save-sample', { libraryId: draft.id, sample })
          // 保存后收起就地表单：id 清空，那一条自动回到只读状态。
          resetSample()
          const fresh = (result.data.libraries || []).find(item => item.id === draft.id)
          if (fresh) setDraft(fresh)
          setTagPool(result.data.tags)
          if (onChanged) onChanged(result.data)
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const removeSample = async id => {
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'delete-sample', { libraryId: draft.id, sampleId: id })
          const fresh = (result.data.libraries || []).find(item => item.id === draft.id)
          if (fresh) setDraft(fresh)
          if (onChanged) onChanged(result.data)
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const analyze = async () => {
        if (!sample.text.trim()) { setError('先粘贴一段样文'); return }
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'analyze', { gameId, text: sample.text, tags: tagPool })
          setSample(current => ({ ...current, tags: result.tags }))
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      // ── 切段导入：粘一大段，按空行/段落切开，勾选要哪些 ──
      const splitSource = async () => {
        if (!importText.trim()) { setError('先把长文粘进来'); return }
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'split', { text: importText, target: chunkSize })
          const list = (result.chunks || []).filter(item => item.text.length >= 40 && item.text.length <= MAX_SAMPLE_CHARS)
          if (list.length === 0) { setError('没切出可用的段落（单条需要 40～2000 字）'); return }
          setChunks(list.map(item => ({ ...item, keep: true, tags: [] })))
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const toggleChunk = index => setChunks(list => list.map((item, at) => at === index ? { ...item, keep: !item.keep } : item))

      const importChunks = async () => {
        const wanted = chunks.filter(item => item.keep)
        if (wanted.length === 0) { setError('没有勾选任何段落'); return }
        setBusy(true); setError('')
        let done = 0
        try {
          for (const item of wanted) {
            const result = await call(ui, 'save-sample', {
              libraryId: draft.id,
              sample: { text: item.text, source: importSource, tags: item.tags },
            })
            const fresh = (result.data.libraries || []).find(entry => entry.id === draft.id)
            if (fresh) setDraft(fresh)
            setTagPool(result.data.tags)
            done += 1
          }
          setChunks([])
          setImportText('')
          if (onChanged) { const out = await call(ui, 'list'); onChanged(out.data) }
          setError('')
        } catch (error) {
          setError('已存入 ' + done + ' 条，第 ' + (done + 1) + ' 条失败：' + message(error))
        } finally { setBusy(false) }
      }

      const analyzeChunk = async index => {
        const item = chunks[index]
        if (!item) return
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'analyze', { gameId, text: item.text, tags: tagPool })
          setChunks(list => list.map((entry, at) => at === index ? { ...entry, tags: result.tags } : entry))
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const analyzeAllChunks = async () => {
        const wanted = chunks.map((item, index) => ({ item, index })).filter(entry => entry.item.keep)
        if (wanted.length === 0) { setError('没有勾选任何段落'); return }
        setBusy(true); setError('')
        try {
          for (const entry of wanted) {
            const result = await call(ui, 'analyze', { gameId, text: entry.item.text, tags: tagPool })
            setChunks(list => list.map((item, at) => at === entry.index ? { ...item, tags: result.tags } : item))
          }
        } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }

      const kept = chunks.filter(item => item.keep).length

      // 照 Tavern 自带页：左上角「← 返回」，标题跟在后面，操作按钮靠右。
      return h('div', { className: 'dsl-page' },
        h('div', { className: 'dsl-page-head' },
          h(Button, { onClick: () => onClose(null) }, '← 返回'),
          h('div', { className: 'dsl-page-title' }, draft.id ? '编辑样文库' : '新建样文库'),
          h('span', { className: 'dsl-spacer' }),
        ),
        h('div', { className: 'dsl-page-body' },

        // 库信息
        h('section', { className: 'dsh-tavern-settings-group' },
          h('div', { className: 'dsl-section' },
            h('div', { className: 'dsl-field' },
              h('div', { className: 'dsl-field-label' }, '名称'),
              h('input', {
                className: 'dsl-input', value: draft.name, placeholder: '例如：冷峻武侠',
                onChange: event => patch({ name: event.target.value }),
              }),
            ),
            h('div', { className: 'dsl-field' },
              h('div', { className: 'dsl-field-label' }, '备注'),
              h('input', {
                className: 'dsl-input', value: draft.note || '', placeholder: '这本书为什么值得参考（只给你自己看）',
                onChange: event => patch({ note: event.target.value }),
              }),
            ),
            h(TagPicker, {
              all: tagPool, value: draft.tags || [], label: '这个库的整体笔调（用于按标签挑选）',
              onChange: next => patch({ tags: next }), onNewTag: addTag,
            }),
            h('div', { className: 'dsl-actions' },
              h(Button, { primary: true, disabled: busy, onClick: saveLibrary },
                draft.id ? '保存库信息' : '创建'),
            ),
          ),
        ),

        // 已有样文
        draft.id ? h('section', { className: 'dsh-tavern-settings-group' },
          h('div', { className: 'dsl-section', style: { paddingBottom: 0 } },
            h('div', { className: 'dsl-actions' },
              h('div', { className: 'dsl-section-title', style: { flex: 1 } },
                '样文（' + (draft.samples || []).length + ' 条）'),
              h('span', { className: 'dsl-hint' }, '单条最多 ' + MAX_SAMPLE_CHARS + ' 字'),
            ),
          ),
          (draft.samples || []).map((item, index) => {
            // 编辑就地展开在这条下面。之前是把内容塞进页面最底下的「单条添加」表单，
            // 那一块在视口之外，看起来就是点了没反应。
            const editing = sample.id === item.id
            // 删除也走就地确认：第一次点只是把这一条换成确认条，点完确认才真删。
            const asking = deleting === item.id
            return h('div', {
              key: item.id, className: cx('dsl-item', (editing || asking) && 'is-editing'),
              // startEdit 靠这个属性把展开后的卡片滚进视野
              'data-editing-sample': editing ? item.id : undefined,
              // 确认条靠这个属性把自己滚进视野（和编辑用同一套 scrollIntoViewOn）
              'data-editing-confirm': asking ? item.id : undefined,
              'data-confirm-delete': asking ? item.id : undefined,
            },
              h('div', { className: 'dsl-item-head' },
                h('div', { className: 'dsl-item-copy' },
                  h('div', { className: 'dsl-item-meta' },
                    '第 ' + (index + 1) + ' 段 · '
                    + (item.source || '未署来源')
                    + (item.tags.length ? ' · ' + item.tags.join('／') : '')
                    + ' · ' + item.text.length + ' 字'),
                ),
                asking
                  ? null
                  : h('div', { className: 'dsl-actions is-tight' },
                    // 再点一次收起，一次误触不用往下找取消
                    h(Button, {
                      small: true, primary: editing,
                      onClick: () => editing ? resetSample() : startEdit(item),
                    }, editing ? '收起' : '编辑'),
                    h(Button, {
                      small: true, danger: true, disabled: busy,
                      onClick: () => askDelete(item),
                    }, '删除'),
                  ),
              ),

              asking
                ? h(ConfirmBar, {
                  busy,
                  confirmLabel: '确认删除这一段',
                  text: '删除第 ' + (index + 1) + ' 段'
                    + (item.source ? '（' + item.source + '）' : '')
                    + '：' + item.text.length + ' 字，不可恢复。',
                  onConfirm: () => { setDeleting(''); removeSample(item.id) },
                  onCancel: () => setDeleting(''),
                })
                : null,

              asking
                ? null
                : editing
                  ? h('div', { className: 'dsl-inline-edit' },
                  h('textarea', {
                    className: 'dsl-area', value: sample.text,
                    placeholder: '把小说里的一段原样粘进来，不做任何修改',
                    'aria-label': '样文正文',
                    onChange: event => setSample(current => ({ ...current, text: event.target.value })),
                  }),
                  h('p', { className: 'dsl-hint' }, sample.text.length + ' / ' + MAX_SAMPLE_CHARS),
                  h('input', {
                    className: 'dsl-input', value: sample.source,
                    placeholder: '出处，例如《边城》沈从文（可留空）',
                    'aria-label': '样文出处',
                    onChange: event => setSample(current => ({ ...current, source: event.target.value })),
                  }),
                  h(TagPicker, {
                    all: tagPool, value: sample.tags || [], label: '这条样文的笔调',
                    onChange: next => setSample(current => ({ ...current, tags: next })), onNewTag: addTag,
                  }),
                  h('div', { className: 'dsl-actions' },
                    h(Button, { disabled: busy, onClick: analyze }, busy ? '分析中…' : 'AI 分析笔调'),
                    h(Button, { primary: true, disabled: busy, onClick: saveSample }, busy ? '保存中…' : '保存修改'),
                    h(Button, { disabled: busy, onClick: resetSample }, '取消'),
                  ),
                )
                  : h('div', { className: 'dsl-quote' },
                    item.text.length > 180 ? item.text.slice(0, 180) + '…' : item.text),
            )
          }),
        ) : h('section', { className: 'dsh-tavern-settings-group' },
          h('div', { className: 'dsl-section' },
            h('p', { className: 'dsl-hint' }, '先点上面的「创建」，再回来添加样文。'),
          ),
        ),

        // 切段导入
        draft.id ? h('section', { className: 'dsh-tavern-settings-group' },
          h('div', { className: 'dsl-section' },
            h('div', { className: 'dsl-section-title' }, '从长文切段'),
            h('p', { className: 'dsl-hint' },
              '粘一整段或一整章进来，按空行／段落自动切开，勾选要留下的，再一起存进去。切段只保证长度合理，笔调是否完整要你自己看一眼。'),
            h('textarea', {
              className: 'dsl-area', value: importText, placeholder: '把小说的一整段粘进来，不做任何修改',
              onChange: event => setImportText(event.target.value),
            }),
            h('p', { className: 'dsl-hint' }, importText.length + ' 字'),
            h('div', { className: 'dsl-actions' },
              h('input', {
                className: 'dsl-input', style: { flex: '2 1 200px' }, value: importSource,
                placeholder: '出处，例如《边城》沈从文（可留空）',
                onChange: event => setImportSource(event.target.value),
              }),
              h('select', {
                className: 'dsl-select', style: { flex: '1 1 130px' }, value: String(chunkSize),
                onChange: event => setChunkSize(Number(event.target.value)),
              },
                [[300, '每段约 300 字'], [500, '每段约 500 字'], [800, '每段约 800 字'], [1200, '每段约 1200 字']].map(item =>
                  h('option', { key: item[0], value: String(item[0]) }, item[1]),
                ),
              ),
              h(Button, { primary: true, disabled: busy, onClick: splitSource }, '切段'),
            ),

            chunks.length ? h('div', null,
              h('div', { className: 'dsl-actions', style: { marginTop: 4 } },
                h('span', { className: 'dsl-hint', style: { flex: 1 } },
                  '切出 ' + chunks.length + ' 段，已选 ' + kept + ' 段'),
                h(Button, { small: true, disabled: busy, onClick: () => setChunks(list => list.map(item => ({ ...item, keep: true }))) }, '全选'),
                h(Button, { small: true, disabled: busy, onClick: () => setChunks(list => list.map(item => ({ ...item, keep: false }))) }, '全不选'),
                h(Button, { small: true, disabled: busy, onClick: analyzeAllChunks }, busy ? '分析中…' : '全部打标签'),
              ),
              chunks.map((item, index) => h('div', {
                key: item.index, className: cx('dsl-chunk', !item.keep && 'is-off'),
              },
                h('div', { className: 'dsl-actions' },
                  h('label', { className: 'dsl-check', style: { flex: 1 } },
                    h('input', { type: 'checkbox', checked: item.keep, onChange: () => toggleChunk(index) }),
                    h('span', null, '第 ' + item.index + ' 段 · ' + item.chars + ' 字'),
                  ),
                  h(Button, { small: true, disabled: busy, onClick: () => analyzeChunk(index) }, 'AI 打标签'),
                ),
                h('div', { className: 'dsl-quote' }, item.text),
                item.tags.length ? h('p', { className: 'dsl-hint' }, item.tags.join('／')) : null,
              )),
              h('div', { className: 'dsl-actions', style: { marginTop: 8 } },
                h(Button, { primary: true, disabled: busy, onClick: importChunks },
                  busy ? '存入中…' : '存入勾选的 ' + kept + ' 段'),
                h(Button, { disabled: busy, onClick: () => { setChunks([]); setImportText('') } }, '清空'),
              ),
            ) : null,
          ),
        ) : null,

        // 单条添加（只用来新增；改已有的点上面那条自己的「编辑」，就地展开）
        draft.id ? h('section', { className: 'dsh-tavern-settings-group' },
          h('div', { className: 'dsl-section' },
            h('div', { className: 'dsl-section-title' }, '新增一条样文'),
            h('p', { className: 'dsl-hint' },
              '要改已有的样文，点上面对应那一条的「编辑」，会在原位展开。'),
            h('textarea', {
              className: 'dsl-area', value: sample.id ? '' : sample.text,
              placeholder: '把小说里的一段原样粘进来，不做任何修改',
              'aria-label': '新增样文正文',
              onChange: event => setSample(current => ({ ...current, text: event.target.value })),
            }),
            h('p', { className: 'dsl-hint' }, sample.text.length + ' / ' + MAX_SAMPLE_CHARS),
            h('input', {
              className: 'dsl-input', value: sample.id ? '' : sample.source,
              placeholder: '出处，例如《边城》沈从文（可留空）',
              'aria-label': '新增样文出处',
              onChange: event => setSample(current => ({ ...current, source: event.target.value })),
            }),
            h(TagPicker, {
              all: tagPool, value: sample.id ? [] : (sample.tags || []), label: '这条样文的笔调',
              onChange: next => { if (!sample.id) setSample(current => ({ ...current, tags: next })) },
              onNewTag: addTag,
            }),
            h('div', { className: 'dsl-actions' },
              h(Button, { disabled: busy, onClick: analyze }, busy ? '分析中…' : 'AI 分析笔调'),
              h(Button, { primary: true, disabled: busy, onClick: saveSample }, '保存样文'),
            ),
            h('p', { className: 'dsl-hint' }, 'AI 分析用本局的后台模型，会产生一次调用。分析结果只是建议，你可以改。'),
          ),
        ) : null,

        error ? h('p', { className: 'dsl-error' }, error) : null,
        ),
      )
    }

    // ── 游戏内状态分节 ───────────────────────────────────────────────
    // 位置：Tavern 把插件分节统一排在它自带各节之后（plugin-api-ui.md 明说），
    // 所以这几节会紧跟在原版「下一轮文风联想」下面。外观照那一节做，
    // 打开状态页看到的是连着的两块「下一轮文风…」。

    function StatusSection({ gameId, ui, title, onOpen }) {
      const [info, setInfo] = useState(null)
      const [expanded, setExpanded] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [flash, setFlash] = useState('')
      const open = () => { if (typeof onOpen === 'function') onOpen() }

      const refresh = useCallback(async () => {
        try {
          const next = await call(ui, 'status', { gameId })
          setInfo(next)
          setError('')
        } catch (err) { setError(message(err)) }
      }, [gameId, ui])

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const next = await call(ui, 'status', { gameId })
            if (alive) { setInfo(next); setError('') }
          } catch (err) { if (alive) setError(message(err)) }
        }
        load()
        // watchTurnState 会先回调一次，所以订阅后就别再手动 load 第二次。
        if (typeof ui.watchTurnState !== 'function') return () => { alive = false }
        let stop = null
        try {
          stop = ui.watchTurnState(gameId, () => { if (alive) load() })
        } catch { /* 订阅不上就只留首屏那一次 */ }
        return () => { alive = false; if (typeof stop === 'function') stop() }
      }, [gameId, ui])

      const rotate = async () => {
        setBusy(true); setError(''); setFlash('')
        try {
          const result = await call(ui, 'rotate', { gameId })
          if (!result.ok) setFlash(result.text || '换不了')
          else setExpanded(false)
          await refresh()
        } catch (err) { setError(message(err)) } finally { setBusy(false) }
      }

      if (error && !info) return h('p', { className: 'dsl-error' }, error)
      if (!info) return h('p', { className: 'dsl-hint' }, '读取中…')

      // 没选库：一节都不占，免得状态页空出一块（原版没开联想时也是整块不显示）。
      if (!info.on) {
        return h('div', { className: 'dsl-field' },
          h('p', { className: 'dsl-status-quote is-empty' },
            info.hint || '本局没有用样文库。'),
          h('div', { className: 'dsl-actions' },
            h('button', {
              type: 'button', className: 'dsl-status-link', style: { marginLeft: 0 },
              onClick: open,
            }, '去样文库选一段 →'),
          ),
          error ? h('p', { className: 'dsl-error' }, error) : null,
        )
      }

      const caption = [
        info.total > 1 ? '第 ' + info.index + '/' + info.total + ' 段' : '',
        info.via === 'marker' ? '#文风 ' + info.markerTag : '',
        info.tags && info.tags.length ? info.tags.join('／') : '',
      ].filter(Boolean).join(' · ')

      // 版式对齐原版那一节：标题行右侧「换一段」+ 两行截断的引文，点击展开。
      return h('div', { className: 'dsl-field' },
        h('div', { className: 'dsl-status-head' },
          h('div', { className: 'dsl-status-label' }, title || '下一轮用这段样文'),
          h('span', {
            className: 'dsl-status-caption',
            title: info.source ? '来源：' + info.source : undefined,
          }, caption),
          info.total > 1
            ? h('button', {
              type: 'button', className: 'dsl-status-link', disabled: busy,
              onClick: rotate,
            }, busy ? '正在换…' : '换一段')
            : null,
        ),
        h('div', {
          className: cx('dsl-status-quote', expanded && 'is-expanded'),
          title: expanded ? '点击收起' : '点击展开全文',
          onClick: () => setExpanded(value => !value),
        }, info.quote),
        h('div', { className: 'dsl-actions' },
          h('button', {
            type: 'button', className: 'dsl-status-link', style: { marginLeft: 0 },
            onClick: open,
          }, '换库或固定某一段 →'),
        ),
        flash ? h('p', { className: 'dsl-hint is-warn' }, flash) : null,
        error ? h('p', { className: 'dsl-error' }, error) : null,
      )
    }

    // ── 侧栏面板 ─────────────────────────────────────────────────────
    // 编辑库和快速选择都在面板内切换显示，不弹遮罩层，
    // 这样内容始终在侧边栏里，和其他页的阅读习惯一致。

    function Panel({ gameId, ui }) {
      const [data, setData] = useState(null)
      const [active, setActive] = useState({ libraryId: '' })
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState('')
      // view: 'list' | 'edit' | 'pick' | 'tags'
      const [view, setView] = useState('list')
      const [editing, setEditing] = useState(null)
      const [pickBusy, setPickBusy] = useState(false)
      const [pickError, setPickError] = useState('')
      // 搜索：库名、笔调标签、说明、样文全文都能搜到
      const [query, setQuery] = useState('')
      // 标签池管理
      const [tagBusy, setTagBusy] = useState(false)
      const [tagError, setTagError] = useState('')
      const [tagNotice, setTagNotice] = useState('')
      const [newTag, setNewTag] = useState('')
      const [renaming, setRenaming] = useState('')
      // 待确认删除的对象：{ kind: 'library' | 'tag', id }，空表示没有待确认的。
      // 只放「正在问的那一个」，这样切换页面或点别处自然就撤销了。
      const [pendingDelete, setPendingDelete] = useState(null)
      const [renameDraft, setRenameDraft] = useState('')

      const refresh = useCallback(async () => {
        try {
          const [list, current] = await Promise.all([
            call(ui, 'list', {}),
            call(ui, 'get-active', { gameId }),
          ])
          setData(list.data)
          setActive(current.active || { libraryId: '' })
          setError('')
        } catch (err) { setError(message(err)) }
      }, [gameId, ui])

      useEffect(() => { refresh() }, [refresh])

      const openEditor = library => {
        setEditing(library || null)
        setView('edit')
      }

      const closeEditor = () => {
        setEditing(null)
        setView('list')
        refresh()
      }

      // 拉一次「下一轮会用哪段」，返回要显示的文案。只看不推进轮次。
      const fetchPreview = useCallback(async () => {
        const result = await call(ui, 'preview', { gameId, input: '' })
        if (!result.text) return '（本轮不会注入：没有选中文风，或这个库里还没有样文）'
        const where = result.sampleTotal > 1
          ? '第 ' + result.sampleIndex + '/' + result.sampleTotal + ' 段（每轮换一段）'
          : '唯一一段'
        // 只显示原文。result.text 是真正注入的整段（带「只借笔调」的规则说明），
        // 那是给模型的，摆在这里只会让人以为规则也算样文的一部分。
        const body = result.sampleText || ''
        return '第 ' + ((result.turn || 0) + 1) + ' 轮会用：' + result.library + ' · ' + where
          + (result.sampleSource ? ' · ' + result.sampleSource : '') + '\n\n' + body
      }, [gameId, ui])

      const rotateNow = async () => {
        setBusy(true); setError('')
        try {
          const result = await call(ui, 'rotate', { gameId })
          if (!result.ok) { setError(result.text || '换不了'); return }
          await refresh()
          // 换完直接显示新的一段，省掉再点一次「预览下一轮」。
          setPreview(await fetchPreview())
        } catch (err) { setError(message(err)) } finally { setBusy(false) }
      }

      const useLibrary = async libraryId => {
        setBusy(true); setError('')
        try {
          await call(ui, 'set-active', { gameId, libraryId, sampleId: '' })
          await refresh()
          // 取消时预览没意义，直接收起来；选中时顺手把会用的那段显示出来。
          setPreview(libraryId ? await fetchPreview() : '')
        } catch (err) { setError(message(err)) } finally { setBusy(false) }
      }

      const pick = async (libraryId, sampleId) => {
        setPickBusy(true); setPickError('')
        try {
          await call(ui, 'set-active', { gameId, libraryId, sampleId: sampleId || '' })
          await refresh()
          setPreview(libraryId ? await fetchPreview() : '')
          setView('list')
        } catch (err) { setPickError(message(err)) } finally { setPickBusy(false) }
      }

      const remove = async library => {
        setBusy(true); setError('')
        try {
          await call(ui, 'delete-library', { id: library.id })
          if (active.libraryId === library.id) await call(ui, 'set-active', { gameId, libraryId: '', sampleId: '' })
          await refresh()
        } catch (err) { setError(message(err)) } finally { setBusy(false) }
      }

      const showPreview = async () => {
        try { setPreview(await fetchPreview()) } catch (err) { setError(message(err)) }
      }

      // 标签池的增删改。改名会连带改掉库和样文上已用的标签，所以提示里说改了"几处"。
      const editTags = async (payload, done) => {
        setTagBusy(true); setTagError(''); setTagNotice('')
        try {
          const result = await call(ui, 'update-tags', payload)
          setData(result.data)
          setTagNotice(done + (result.touched ? '（同步更新了 ' + result.touched + ' 处引用）' : ''))
          setNewTag('')
          setRenaming('')
          setRenameDraft('')
        } catch (err) { setTagError(message(err)) } finally { setTagBusy(false) }
      }

      const addTag = () => {
        const tag = newTag.trim().replace(/\s+/g, '')
        if (!tag) return
        editTags({ action: 'add', tags: [tag] }, '已添加标签「' + tag + '」')
      }

      // 确认在按钮那一层就做过了（点了「删除」先展开确认条），这里不再问第二遍，
      // 也不再走浏览器原生弹窗——它在宿主的 iframe 里可能被直接拦掉。
      const removeTag = (tag) => {
        editTags({ action: 'remove', tag }, '已删除标签「' + tag + '」')
      }

      const renameTag = (from) => {
        const to = renameDraft.trim().replace(/\s+/g, '')
        if (!to || to === from) { setRenaming(''); setRenameDraft(''); return }
        editTags({ action: 'rename', tag: from, to }, '已把「' + from + '」改名为「' + to + '」')
      }

      const libraries = (data && data.libraries) || []

      // 搜索分两层：
      //   1. 库本身命中（库名／标签／备注）→ 整库照常列出
      //   2. 样文命中 → 把命中的那一条单独摘出来，带上库名和段号，直接点开看
      // 第二种是重点：库里有 40 条，只告诉用户「命中 3 条」还得自己翻进去找。
      // 样文最多 60 库 × 40 条，逐条 includes 完全够用，不必建索引。
      const keyword = query.trim().toLowerCase()
      const hitText = value => String(value || '').toLowerCase().includes(keyword)

      const libraryHit = library => !keyword || [
        library.name,
        (library.tags || []).join(' '),
        library.note,
      ].some(hitText)

      // 命中的样文条目：{[libraryId]: [sample, ...]}
      const sampleHits = {}
      if (keyword) {
        for (const library of libraries) {
          const list = (library.samples || []).filter(item => hitText(item.text) || hitText(item.source))
          if (list.length) sampleHits[library.id] = list
        }
      }

      const visible = keyword
        ? libraries.filter(library => libraryHit(library) || sampleHits[library.id])
        : libraries

      // 只在库本身已经列出、样文又命中时才标「命中 N 条」，避免重复。
      const hitsIn = library => (keyword && libraryHit(library) ? (sampleHits[library.id] || []).length : 0)

      // 编辑页
      if (view === 'edit') {
        return h(Editor, {
          gameId, ui, tags: (data && data.tags) || [], library: editing,
          onClose: closeEditor,
          onChanged: () => { refresh() },
        })
      }

      // 手动选择页
      if (view === 'pick') {
        return h('div', { className: 'dsl-page' },
          h('div', { className: 'dsl-page-head' },
            h(Button, { onClick: () => { setView('list'); setPickError('') } }, '← 返回'),
            h('div', { className: 'dsl-page-title' }, '本局用哪段文风'),
            h('span', { className: 'dsl-spacer' }),
          ),
          h('div', { className: 'dsl-page-body' },
          h('p', { className: 'dsl-hint' },
            '选中后每轮正文都会带上这个库里的一段参考，并在库内逐轮轮换，直到你换掉或取消。点某一条可以只固定用它。'),

          libraries.length === 0
            ? h('section', { className: 'dsh-tavern-settings-group' },
              h('div', { className: 'dsl-section' },
                h('p', { className: 'dsl-hint' }, '还没有样文库。返回后点「新建」。'),
              ),
            )
            : h('section', { className: 'dsh-tavern-settings-group' },
              libraries.map(library => {
                const on = active.libraryId === library.id
                return h('div', { key: library.id, className: cx('dsl-item', on && 'is-active') },
                  h('div', { className: 'dsl-item-head' },
                    h('div', { className: 'dsl-item-copy' },
                      h('div', { className: 'dsl-item-title' }, library.name),
                      h('div', { className: 'dsl-item-meta' },
                        ((library.tags || []).join('／') || '未设笔调标签')
                        + ' · ' + (library.samples || []).length + ' 条样文'),
                    ),
                    on ? h('span', { className: 'dsl-badge' }, '正在用') : null,
                    h(Button, {
                      small: true, primary: !on, disabled: pickBusy || (library.samples || []).length === 0,
                      onClick: () => pick(library.id, ''),
                    }, on ? '保留' : '用这个'),
                  ),
                  (library.samples || []).length > 1
                    ? h('div', { className: 'dsl-chips' },
                      (library.samples || []).map(item => h('button', {
                        key: item.id, type: 'button', disabled: pickBusy, className: 'dsl-chip',
                        onClick: () => pick(library.id, item.id),
                        title: '只固定用这一条，不参与轮换',
                      }, (item.source || '样文') + (item.tags.length ? ' · ' + item.tags.join('／') : ''))))
                    : null,
                )
              }),
            ),

          active.libraryId
            ? h('div', { className: 'dsl-actions' },
              h(Button, { danger: true, disabled: pickBusy, onClick: () => pick('', '') }, '本局取消文风'),
            )
            : null,
          pickError ? h('p', { className: 'dsl-error' }, pickError) : null,
          ),
        )
      }

      // 标签池管理页
      if (view === 'tags') {
        const pool = (data && data.tags) || []
        const usedIn = tag => libraries.filter(library =>
          (library.tags || []).includes(tag)
          || (library.samples || []).some(item => (item.tags || []).includes(tag))).length
        const usedCount = pool.filter(tag => usedIn(tag) > 0).length
        // 每个标签被用了几处，摊平到库和样文上算
        const usage = tag => libraries.reduce((sum, library) => {
          let n = (library.tags || []).includes(tag) ? 1 : 0
          for (const item of (library.samples || [])) if ((item.tags || []).includes(tag)) n += 1
          return sum + n
        }, 0)

        return h('div', { className: 'dsl-page' },
          h('div', { className: 'dsl-page-head' },
            h(Button, { onClick: () => { setView('list'); setTagError(''); setTagNotice(''); setPendingDelete(null) } }, '← 返回'),
            h('div', { className: 'dsl-page-title' }, '笔调标签'),
            h('span', { className: 'dsl-spacer' }),
          ),
          h('div', { className: 'dsl-page-body' },

          h('section', { className: 'dsh-tavern-settings-group' },
            h('div', { className: 'dsl-section' },
              h('div', { className: 'dsl-actions' },
                h('div', { className: 'dsl-section-title', style: { flex: 1 } },
                  '标签池（' + pool.length + ' 个）'),
                pool.length
                  ? h('span', { className: 'dsl-hint' }, usedCount + ' 个在用')
                  : null,
              ),
              h('p', { className: 'dsl-hint' },
                '建库时 Agent 会按这些标签给素材分类，游玩时也能用「#文风 标签名」临时指定。改名会同步改掉已经用上的地方。'),
              h('div', { className: 'dsl-actions is-tight' },
                h('input', {
                  className: 'dsl-input', style: { flex: 1 }, value: newTag,
                  placeholder: '新标签，例如「冷峻」',
                  'aria-label': '新笔调标签',
                  onChange: event => setNewTag(event.target.value),
                  onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addTag() } },
                }),
                h(Button, { primary: true, disabled: tagBusy || !newTag.trim(), onClick: addTag }, '添加'),
              ),
              tagNotice ? h('p', { className: 'dsl-hint' }, tagNotice) : null,
              tagError ? h('p', { className: 'dsl-error' }, tagError) : null,
            ),
          ),

          pool.length === 0
            ? h('section', { className: 'dsh-tavern-settings-group' },
              h('div', { className: 'dsl-section' },
                h('p', { className: 'dsl-hint' }, '标签池还是空的。上面加几个，比如「冷峻」「絮语」「白描」。'),
                h('p', { className: 'dsl-hint' },
                  '也可以先不管这里：编辑样文库时，样文下面的标签选择器里能直接新建。'),
              ),
            )
            : h('section', { className: 'dsh-tavern-settings-group' },
              h('div', { className: 'dsl-group-label' }, '全部标签'),
              pool.map(tag => {
                const used = usedIn(tag)
                const count = usage(tag)
                const isRenaming = renaming === tag
                const asking = pendingDelete && pendingDelete.kind === 'tag' && pendingDelete.id === tag
                return h('div', {
                  key: tag,
                  className: cx('dsl-item', asking && 'is-editing'),
                  'data-confirm-delete': asking ? tag : undefined,
                },
                  h('div', { className: 'dsl-item-head' },
                    h('div', { className: 'dsl-item-copy' },
                      isRenaming
                        ? h('input', {
                          className: 'dsl-input', value: renameDraft, autoFocus: true,
                          'aria-label': '新标签名',
                          onChange: event => setRenameDraft(event.target.value),
                          onKeyDown: event => {
                            if (event.key === 'Enter') { event.preventDefault(); renameTag(tag) }
                            if (event.key === 'Escape') { setRenaming(''); setRenameDraft('') }
                          },
                        })
                        : h('div', { className: 'dsl-item-title' }, tag),
                      h('div', { className: 'dsl-item-meta' },
                        used
                          ? '被 ' + used + ' 个库或样文使用，共 ' + count + ' 处'
                          : '还没被用到'),
                    ),
                  ),
                  asking
                    ? h(ConfirmBar, {
                      busy: tagBusy,
                      text: used
                        ? '删除「' + tag + '」会清掉它在这 ' + used + ' 个库或样文上的 ' + count + ' 处标记。样文本身不受影响。'
                        : '删除「' + tag + '」。它现在没有被任何库或样文使用。',
                      onConfirm: () => { setPendingDelete(null); removeTag(tag) },
                      onCancel: () => setPendingDelete(null),
                    })
                    : h('div', { className: 'dsl-actions is-tight' },
                      isRenaming
                        ? h(Button, { small: true, primary: true, disabled: tagBusy, onClick: () => renameTag(tag) }, '保存')
                        : h(Button, {
                          small: true, disabled: tagBusy,
                          onClick: () => { setRenaming(tag); setRenameDraft(tag); setTagError(''); setTagNotice(''); setPendingDelete(null) },
                        }, '改名'),
                      isRenaming
                        ? h(Button, { small: true, onClick: () => { setRenaming(''); setRenameDraft('') } }, '取消')
                        : h(Button, {
                          small: true, danger: true, disabled: tagBusy,
                          onClick: () => { setPendingDelete({ kind: 'tag', id: tag }); setTagError(''); setTagNotice('') },
                        }, '删除'),
                    ),
                )
              }),
            ),
          ),
        )
      }

      // 列表页
      return h('div', { className: 'dsl-page' },
        h('div', { className: 'dsl-page-head' },
          h('div', { className: 'dsl-page-title' }, '样文库'),
          h('span', { className: 'dsl-spacer' }),
          h(Button, { primary: true, onClick: () => openEditor(null) }, '新建'),
          h(Button, { onClick: () => { setView('tags'); setTagError(''); setTagNotice('') } }, '标签'),
        ),
        h('div', { className: 'dsl-page-body' },

        // 搜索：库多起来之后找库全靠它，也是唯一的跨库找样文入口。
        h('div', { className: 'dsl-actions is-tight' },
          h('input', {
            className: 'dsl-input', style: { flex: 1 }, value: query, type: 'search',
            placeholder: '搜索库名、笔调标签、备注或样文原文',
            'aria-label': '搜索样文库',
            onChange: event => setQuery(event.target.value),
          }),
          query
            ? h(Button, { small: true, onClick: () => setQuery('') }, '清空')
            : null,
        ),

        // 搜到样文时先单独列出来：库里有几十条，只告诉用户「命中 3 条」还得自己翻。
        keyword && Object.keys(sampleHits).length
          ? h('section', { className: 'dsh-tavern-settings-group' },
            h('div', { className: 'dsl-group-label' }, '命中的样文'),
            Object.keys(sampleHits).map(libraryId => {
              const library = libraries.find(item => item.id === libraryId)
              return sampleHits[libraryId].map(sample => {
                const place = (library.samples || []).findIndex(item => item.id === sample.id) + 1
                return h('div', { key: libraryId + ':' + sample.id, className: 'dsl-item' },
                  h('div', { className: 'dsl-item-head' },
                    h('div', { className: 'dsl-item-copy' },
                      h('div', { className: 'dsl-item-meta' },
                        library.name + ' · 第 ' + place + ' 段'
                        + (sample.source ? ' · ' + sample.source : '')),
                      (sample.tags || []).length
                        ? h('div', { className: 'dsl-item-meta' }, sample.tags.join('／'))
                        : null,
                    ),
                  ),
                  h('blockquote', { className: 'dsl-quote' }, sample.text),
                  h('div', { className: 'dsl-actions is-tight' },
                    h(Button, {
                      small: true, disabled: busy,
                      onClick: () => pick(library.id, sample.id),
                    }, '本局固定用这段'),
                    h(Button, { small: true, onClick: () => openEditor(library) }, '打开所在库'),
                  ),
                )
              })
            }),
          )
          : null,

        h('p', { className: 'dsl-hint' },
          '这里存你自己的小说摘录，按笔调归档。选中一个库后，每轮正文都会带上它的一段样文做笔调参考，并在库内逐轮轮换。'),
        h('p', { className: 'dsl-hint is-warn' },
          '同时开着本局的「文风联想」会注入两段笔调参考，建议关掉其中一个。'),

        libraries.length === 0
          ? h('section', { className: 'dsh-tavern-settings-group' },
            h('div', { className: 'dsl-section' },
              h('p', { className: 'dsl-hint' }, '还没有样文库。点右上角「新建」。'),
            ),
          )
          : visible.length === 0
            ? h('section', { className: 'dsh-tavern-settings-group' },
              h('div', { className: 'dsl-section' },
                h('p', { className: 'dsl-hint' }, '没有匹配「' + query.trim() + '」的库或样文。'),
                h(Button, { small: true, onClick: () => setQuery('') }, '清空搜索'),
              ),
            )
            : h('section', { className: 'dsh-tavern-settings-group' },
              visible.map(library => {
                const on = active.libraryId === library.id
                const count = (library.samples || []).length
                const matched = hitsIn(library)
                const asking = pendingDelete && pendingDelete.kind === 'library' && pendingDelete.id === library.id
                return h('div', {
                  key: library.id,
                  className: cx('dsl-item', on && 'is-active', asking && 'is-editing'),
                  'data-confirm-delete': asking ? library.id : undefined,
                },
                  h('div', { className: 'dsl-item-head' },
                    h('div', { className: 'dsl-item-copy' },
                      h('div', { className: 'dsl-item-title' }, library.name),
                      h('div', { className: 'dsl-item-meta' },
                        ((library.tags || []).join('／') || '未设笔调标签') + ' · ' + count + ' 条'),
                      library.note ? h('div', { className: 'dsl-item-meta' }, library.note) : null,
                      matched
                        ? h('div', { className: 'dsl-item-meta' }, '样文中有 ' + matched + ' 条命中')
                        : null,
                    ),
                    on ? h('span', { className: 'dsl-badge' }, '本局使用中') : null,
                  ),
                  asking
                    ? h(ConfirmBar, {
                      busy,
                      confirmLabel: '确认删除这个库',
                      text: '删除「' + library.name + '」会一并删掉里面 '
                        + count + ' 段样文，不可恢复。'
                        + (on ? '这一局正在用它，删掉后会取消文风。' : ''),
                      onConfirm: () => { setPendingDelete(null); remove(library) },
                      onCancel: () => setPendingDelete(null),
                    })
                    : h('div', { className: 'dsl-actions is-tight' },
                      h(Button, {
                        small: true, primary: !on, disabled: busy || count === 0,
                        onClick: () => useLibrary(on ? '' : library.id),
                      }, on ? '取消' : '本局使用'),
                      h(Button, { small: true, onClick: () => openEditor(library) }, '编辑'),
                      h(Button, {
                        small: true, danger: true, disabled: busy,
                        onClick: () => { setPendingDelete({ kind: 'library', id: library.id }); setError('') },
                      }, '删除'),
                    ),
                )
              }),
            ),

        h('div', { className: 'dsl-actions' },
          h(Button, { onClick: () => setView('pick') }, '手动选择'),
          h(Button, { onClick: showPreview }, '预览下一轮'),
          active.libraryId ? h(Button, { disabled: busy, onClick: rotateNow }, '换一段') : null,
        ),
        preview ? h('div', { className: 'dsl-quote is-open' }, preview) : null,
        h('p', { className: 'dsl-hint' },
          '正文里写「#文风 冷峻」可以临时指定标签，优先级高于这里选中的库。'),
        error ? h('p', { className: 'dsl-error' }, error) : null,
        ),
      )
    }

    // 打开侧栏里的样文库页。「文风」按钮和状态分节里的链接都走这里。
    //
    // 两个坑都在这里，都踩过：
    // 1. tabId 必须和宿主 registerPanel 生成的一模一样：
    //      "tavern-plugin:" + owner + ":" + id   （plugin-extensions.js:498）
    // 2. betterSidebar.openTab 的第一个参数是 **seed 对象**，它读的是 seed.type：
    //      const descriptor = tabs.get(seed.type); if (descriptor === void 0) return;
    //    传字符串时 seed.type 是 undefined，tabs.get(undefined) 拿不到东西就**静默 return**，
    //    不抛错，所以 try/catch 也是空的——点了完全没反应。
    //    正确写法：openTab({ type: tabId }, { sessionId })。
    const TAB_ID = 'tavern-plugin:' + SELF + ':style-library'

    function sidebarOf(ctx) {
      try {
        if (ctx && ctx.betterSidebar) return ctx.betterSidebar
        if (ctx && typeof ctx.get === 'function') return ctx.get('betterSidebar') || null
      } catch { /* 服务没就绪就当没有 */ }
      return null
    }

    function makeOpenPanel(ctx) {
      return function openPanel(ui, gameId) {
        // 每次点击都重新取服务：apply 时才读的话，服务晚上线就一直拿不到。
        const sidebar = sidebarOf(ctx)
        if (sidebar && typeof sidebar.openTab === 'function') {
          let usable = true
          try {
            if (typeof sidebar.getTab === 'function') usable = Boolean(sidebar.getTab(TAB_ID))
            if (usable && typeof sidebar.isTabEnabled === 'function') usable = sidebar.isTabEnabled(TAB_ID)
          } catch { usable = true }
          if (usable) {
            try {
              sidebar.openTab({ type: TAB_ID }, { sessionId: gameId })
              return
            } catch { /* 打不开再退回下面那层说明 */ }
          }
        }
        ui.openOverlay({
          gameId,
          render: ({ close }) => h('div', {
            className: 'dsh-tavern-settings-section',
            style: { maxWidth: 480, margin: '0 auto', padding: 4 },
          },
            h('h3', { className: 'dsl-section-title' }, '样文库在侧栏里'),
            h('p', { className: 'dsl-hint' },
              '当前界面没能自动打开侧栏页。点侧栏的「＋」，在「插件」组里打开「样文库」。'),
            h(Button, { onClick: () => close() }, '关闭'),
          ),
        })
      }
    }

    return {
      name: SELF,
      // betterSidebar 用来让「文风」按钮直接打开侧栏页而不是另弹一层。
      // 这个名字是对的：插件一直能加载起来就说明注入成功。
      inject: ['tavernUi', 'betterSidebar'],
      apply(ctx) {
        const ui = ctx.tavernUi
        if (!ui || !(ui.apiVersion >= API_MIN)) return

        ensureStyles()
        const openPanel = makeOpenPanel(ctx)

        try {
          ui.registerPanel({
            id: 'style-library',
            title: '样文库',
            render: ({ gameId }) => h(Panel, { gameId, ui }),
          })
        } catch (error) {
          // 没侧栏时宿主会在这里抛错；不要连累下面的分节和按钮。
          console.warn('[style-library] 侧栏面板注册失败：', message(error))
        }

        // 不注册 registerStartGroup：按 plugin-api-ui.md，不声明时 registerPanel 的面板
        // 落在侧栏的「插件」组里，入口就是「插件 / 样文库」。
        // 之前声明了一个 title 为「样文库」的组，侧栏才多出一层「样文库 / 样文库」。

        // 紧挨着原版「下一轮文风联想」：Tavern 把插件分节排在自带各节之后，
        // 所以这一节会落在那一块下面，两节版式也做成一样的。
        if (typeof ui.registerStatusSection === 'function') {
          try {
            ui.registerStatusSection({
              id: 'style-library',
              title: '下一轮样文笔调',
              render: ({ gameId }) => h(StatusSection, {
                gameId, ui, title: '下一轮样文笔调',
                onOpen: () => openPanel(ui, gameId),
              }),
            })
          } catch (error) {
            console.warn('[style-library] 状态分节注册失败：', message(error))
          }
        }

        // 不再注册输入框上方的「文风」按钮：那一条工具栏位置紧、几个插件抢，
        // 而且点开还是侧栏页，等于绕一圈。入口只留侧栏「插件 → 样文库」
        // 和「酒馆状态」页那一节里的跳转链接。
      },
    }
  },
})
