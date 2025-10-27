// Typecho Publisher for flymd (ESM)
// Adds settings UI and a publish dialog; prefers host http API to avoid CORS.

const LS_KEY = 'flymd:typecho-publisher:settings'
async function loadSettings(ctx) {
  try { if (ctx?.storage?.get) { const v = await ctx.storage.get('settings'); if (v && typeof v === 'object') return v } } catch {}
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {} } catch { return {} }
}
async function saveSettings(ctx, s) {
  try { if (ctx?.storage?.set) { await ctx.storage.set('settings', s); return } } catch {}
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch {}
}

function pad(n) { return n < 10 ? '0' + n : '' + n }
function iso8601(d) {
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  )
}

// Very small YAML frontmatter parser/writer (limited cases; good enough for typical posts)
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: text, had: false }
  const yaml = m[1]
  const body = text.slice(m[0].length)
  const lines = yaml.split(/\r?\n/)
  const data = {}
  let curKey = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m2 = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/)
    if (m2) {
      const k = m2[1]
      let v = m2[2]
      if (v === '' || v === null || v === undefined) { data[k] = ''; curKey = k; continue }
      if (/^(true|false)$/i.test(v)) { data[k] = /^true$/i.test(v); curKey = null; continue }
      if (/^\[.*\]$/.test(v)) {
        const inner = v.slice(1, -1).trim();
        data[k] = inner ? inner.split(',').map(s => s.trim()).filter(Boolean) : []
        curKey = null; continue
      }
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      data[k] = v
      curKey = null
      continue
    }
    const mList = line.match(/^\s*-\s*(.+)$/)
    if (mList && curKey) {
      if (!Array.isArray(data[curKey])) data[curKey] = []
      data[curKey].push(mList[1])
      continue
    }
    if (/^\S/.test(line)) curKey = null
  }
  return { data, body, had: true }
}

function needsQuote(s) { return /[:#\-?&*!\[\]{},>|'%@`]/.test(s) || /\s/.test(s) }
function writeYaml(data) {
  const out = []
  const pushKV = (k, v) => {
    if (Array.isArray(v)) {
      out.push(`${k}:`)
      for (const it of v) {
        let val = String(it)
        if (needsQuote(val)) val = '"' + val.replace(/"/g, '\\"') + '"'
        out.push(`  - ${val}`)
      }
    } else if (typeof v === 'boolean') {
      out.push(`${k}: ${v ? 'true' : 'false'}`)
    } else if (v === null || v === undefined) {
      out.push(`${k}:`)
    } else {
      let val = String(v)
      if (needsQuote(val)) val = '"' + val.replace(/"/g, '\\"') + '"'
      out.push(`${k}: ${val}`)
    }
  }
  const keys = Object.keys(data)
  for (const k of keys) pushKV(k, data[k])
  return out.join('\n')
}

function rebuildDoc(fm, body) {
  const y = writeYaml(fm)
  return `---\n${y}\n---\n\n${body}`
}

// XML-RPC minimal encoder/decoder
function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;') }
function xmlEncodeValue(v) {
  if (v === null || v === undefined) return '<nil/>'
  if (Array.isArray(v)) return '<array><data>' + v.map(x => `<value>${xmlEncodeValue(x)}</value>`).join('') + '</data></array>'
  if (v instanceof Date) return `<dateTime.iso8601>${iso8601(v)}</dateTime.iso8601>`
  const t = typeof v
  if (t === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`
  if (t === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`
  if (t === 'object') return '<struct>' + Object.entries(v).map(([k, val]) => `<member><name>${xmlEscape(k)}</name><value>${xmlEncodeValue(val)}</value></member>`).join('') + '</struct>'
  return `<string>${xmlEscape(String(v))}</string>`
}
function xmlBuildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>` + params.map(p => `<param><value>${xmlEncodeValue(p)}</value></param>`).join('') + `</params></methodCall>`
}
function xmlParseResponse(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const fault = doc.getElementsByTagName('fault')[0]
  const parseVal = (node) => {
    if (!node) return null
    const name = node.nodeName
    if (name === 'value') { return node.children.length ? parseVal(node.children[0]) : (node.textContent ?? '') }
    if (['string','i4','int','double','boolean','dateTime.iso8601'].includes(name)) {
      const s = (node.textContent || '').trim()
      if (name === 'boolean') return s === '1'
      if (name === 'int' || name === 'i4') return parseInt(s, 10)
      if (name === 'double') return Number(s)
      return s
    }
    if (name === 'struct') {
      const obj = {}
      const members = node.getElementsByTagName('member')
      for (let i = 0; i < members.length; i++) {
        const m = members[i]
        const key = (m.getElementsByTagName('name')[0]?.textContent) || ''
        const val = parseVal(m.getElementsByTagName('value')[0])
        obj[key] = val
      }
      return obj
    }
    if (name === 'array') {
      const dataEl = node.getElementsByTagName('data')[0]
      if (!dataEl) return []
      const arr = []
      for (let i = 0; i < dataEl.children.length; i++) {
        if (dataEl.children[i].nodeName === 'value') arr.push(parseVal(dataEl.children[i]))
      }
      return arr
    }
    return node.textContent ?? ''
  }
  if (fault) {
    const v = fault.getElementsByTagName('value')[0]
    const obj = parseVal(v)
    const msg = (obj && (obj.faultString || obj['faultString'])) || 'XML-RPC 错误'
    const code = (obj && (obj.faultCode || obj['faultCode'])) || -1
    const err = new Error(`XML-RPC 错误 ${code}: ${msg}`)
    err.code = code
    throw err
  }
  const params = doc.getElementsByTagName('params')[0]
  if (!params) return null
  const first = params.getElementsByTagName('param')[0]
  if (!first) return null
  const value = first.getElementsByTagName('value')[0]
  return parseVal(value)
}

function buildProxiedUrl(endpoint, proxyUrl) {
  if (!proxyUrl) return endpoint
  try {
    if (proxyUrl.includes('{target}')) return proxyUrl.replace('{target}', encodeURIComponent(endpoint))
    if (proxyUrl.includes('?')) return proxyUrl + '&target=' + encodeURIComponent(endpoint)
    if (proxyUrl.endsWith('/')) return proxyUrl + encodeURIComponent(endpoint)
    return proxyUrl + '?target=' + encodeURIComponent(endpoint)
  } catch { return endpoint }
}

async function xmlRpcPost(ctx, endpoint, xml, proxyUrl) {
  const url = buildProxiedUrl(endpoint, proxyUrl)
  // Prefer host http (tauri-http) to bypass CORS; fallback to fetch
  try {
    if (ctx?.http?.fetch) {
      const r = await ctx.http.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml })
      const txt = await r.text()
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`)
      return xmlParseResponse(txt)
    }
  } catch (e) {
    // fallthrough to fetch
  }
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
  return xmlParseResponse(text)
}

function parseListInput(s) { return (s || '').split(',').map(x => x.trim()).filter(Boolean) }

// ========== UI Helpers ==========
function ensureStyle() {
  if (document.getElementById('tp-fly-style')) return
  const css = `
  .tp-fly-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:90000}
  .tp-fly-hidden{display:none}
  .tp-fly-dialog{width:560px;max-width:calc(100% - 40px);background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.2);}
  .tp-fly-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:14px}
  .tp-fly-body{padding:12px 16px;max-height:65vh;overflow:auto}
  .tp-fly-grid{display:grid;grid-template-columns:140px 1fr;gap:10px;align-items:center}
  .tp-fly-grid label{color:var(--muted);font-size:12px}
  .tp-fly-grid input[type="text"],.tp-fly-grid input[type="password"],.tp-fly-grid input[type="url"],.tp-fly-grid input[type="datetime-local"]{width:100%;padding:8px 10px;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:8px;outline:none;font-size:13px;min-width:0;box-sizing:border-box}
  .tp-fly-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:12px}
  .tp-fly-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:8px;padding:6px 12px;font-size:13px}
  .tp-fly-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff}
  .tp-fly-rowfull{grid-column:1/-1;color:var(--muted);font-size:12px}
  `
  const style = document.createElement('style')
  style.id = 'tp-fly-style'
  style.textContent = css
  document.head.appendChild(style)
}

function openOverlay(title, contentBuilder) {
  ensureStyle()
  const overlay = document.createElement('div')
  overlay.className = 'tp-fly-overlay'
  const dialog = document.createElement('div')
  dialog.className = 'tp-fly-dialog'
  dialog.innerHTML = `<div class="tp-fly-header"><div>${title}</div><button class="tp-fly-btn" id="tp-close">×</button></div><div class="tp-fly-body"></div>`
  document.body.appendChild(overlay)
  overlay.appendChild(dialog)
  const body = dialog.querySelector('.tp-fly-body')
  const close = () => { try { overlay.remove() } catch {} }
  dialog.querySelector('#tp-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  contentBuilder(body, close)
  return { overlay, dialog, body, close }
}

// ========== Settings UI ==========
export async function openSettings(ctx) {
  const s = Object.assign({ endpoint:'', proxyUrl:'', username:'', password:'', blogId:'0', useCurrentTime:true, publishTimeOffset:0 }, await loadSettings(ctx) || {})
  openOverlay('Typecho 发布器设置', (body, close) => {
    const wrap = document.createElement('div')
    wrap.className = 'tp-fly-grid'
    wrap.innerHTML = `
      <label>接口 URL</label><input id="tp-endpoint" type="url" placeholder="https://your-site.com/xmlrpc.php" value="${s.endpoint || ''}">
      <label>用户名</label><input id="tp-username" type="text" value="${s.username || ''}">
      <label>密码</label><input id="tp-password" type="password" value="${s.password || ''}">
      <label>默认博客ID</label><input id="tp-blogid" type="text" value="${s.blogId || '0'}">
      <label>CORS 代理</label><input id="tp-proxy" type="url" placeholder="可含 {target}" value="${s.proxyUrl || ''}">
      <div class="tp-fly-rowfull">建议优先使用桌面环境（内置原生网络层）避免 CORS；如需浏览器内使用，请配置自建代理。</div>
      <label>使用当前时间</label><input id="tp-usecur" type="checkbox" ${s.useCurrentTime ? 'checked' : ''}>
      <label>发布时间偏移(小时)</label><input id="tp-offset" type="text" value="${s.publishTimeOffset || 0}">
    `
    body.appendChild(wrap)
    const actions = document.createElement('div')
    actions.className = 'tp-fly-actions'
    const btnTest = document.createElement('button')
    btnTest.className = 'tp-fly-btn'
    btnTest.textContent = '测试连接'
    const btnSave = document.createElement('button')
    btnSave.className = 'tp-fly-btn primary'
    btnSave.textContent = '保存'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'tp-fly-btn'
    btnCancel.textContent = '取消'
    actions.appendChild(btnTest); actions.appendChild(btnSave); actions.appendChild(btnCancel)
    body.appendChild(actions)

    btnCancel.addEventListener('click', () => close())
    btnSave.addEventListener('click', async () => {
      const ns = {
        endpoint: body.querySelector('#tp-endpoint').value.trim(),
        username: body.querySelector('#tp-username').value.trim(),
        password: body.querySelector('#tp-password').value,
        blogId: body.querySelector('#tp-blogid').value.trim() || '0',
        proxyUrl: body.querySelector('#tp-proxy').value.trim(),
        useCurrentTime: !!body.querySelector('#tp-usecur').checked,
        publishTimeOffset: parseFloat(body.querySelector('#tp-offset').value) || 0,
      }
      await saveSettings(ctx, ns)
      try { ctx.ui?.notice?.('设置已保存', 'ok', 1500) } catch {}
      close()
    })
    btnTest.addEventListener('click', async () => {
      try {
        const ep = body.querySelector('#tp-endpoint').value.trim()
        const proxy = body.querySelector('#tp-proxy').value.trim()
        if (!ep) { alert('请填写接口 URL'); return }
        const xml = xmlBuildCall('system.listMethods', [])
        await xmlRpcPost(ctx, ep, xml, proxy)
        alert('连接正常')
      } catch (e) { alert('连接失败: ' + (e?.message || e)) }
    })
  })
}

// ========== Publish Dialog ==========
function toLocalDTStr(d) { const p = (n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

async function openPublishDialog(ctx) {
  const settings = Object.assign({ endpoint:'', proxyUrl:'', username:'', password:'', blogId:'0', useCurrentTime:true, publishTimeOffset:0 }, await loadSettings(ctx) || {})
  if (!settings.endpoint || !settings.username || !settings.password) {
    const go = await ctx.ui?.confirm?.('尚未配置 Typecho 参数，是否现在设置？')
    if (go) return openSettings(ctx)
    return
  }
  const raw = ctx.getEditorValue()
  const { data: fm, body } = parseFrontmatter(raw)
  const K = { title:'title', slug:'slug', tags:'tags', categories:'categories', draft:'draft', cid:'cid', dateCreated:'dateCreated' }
  const preset = {
    title: (fm[K.title] || '').toString() || '未命名文档',
    slug: (fm[K.slug] || '').toString(),
    tags: Array.isArray(fm[K.tags]) ? fm[K.tags] : parseListInput(fm[K.tags] || ''),
    categories: Array.isArray(fm[K.categories]) ? fm[K.categories] : parseListInput(fm[K.categories] || ''),
    draft: !!fm[K.draft],
    dateCreated: fm[K.dateCreated] ? new Date(String(fm[K.dateCreated])) : new Date(),
    cid: fm[K.cid] ? String(fm[K.cid]) : ''
  }
  const initDate = settings.useCurrentTime ? new Date() : (preset.dateCreated || new Date())

  openOverlay('发布到 Typecho', (bodyEl, close) => {
    const wrap = document.createElement('div')
    wrap.className = 'tp-fly-grid'
    wrap.innerHTML = `
      <label>标题</label><input id="tp-title" type="text" value="${preset.title}">
      <label>Slug</label><input id="tp-slug" type="text" placeholder="可留空" value="${preset.slug || ''}">
      <label>标签</label><input id="tp-tags" type="text" placeholder="逗号分隔" value="${preset.tags.join(', ')}">
      <label>分类</label><input id="tp-cats" type="text" placeholder="逗号分隔，至少 1 个" value="${preset.categories.join(', ')}">
      <label>草稿</label><input id="tp-draft" type="checkbox" ${preset.draft ? 'checked' : ''}>
      <label>发布时间</label><input id="tp-date" type="datetime-local" value="${toLocalDTStr(initDate)}">
      <div class="tp-fly-rowfull">将使用设置中的时间偏移: ${settings.publishTimeOffset || 0} 小时</div>
    `
    bodyEl.appendChild(wrap)
    const actions = document.createElement('div')
    actions.className = 'tp-fly-actions'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'tp-fly-btn'
    btnCancel.textContent = '取消'
    const btnOk = document.createElement('button')
    btnOk.className = 'tp-fly-btn primary'
    btnOk.textContent = '发布'
    actions.appendChild(btnCancel); actions.appendChild(btnOk)
    bodyEl.appendChild(actions)
    btnCancel.addEventListener('click', () => close())
    btnOk.addEventListener('click', async () => {
      const title = bodyEl.querySelector('#tp-title').value.trim() || '未命名文档'
      let slug = bodyEl.querySelector('#tp-slug').value.trim()
      const tags = parseListInput(bodyEl.querySelector('#tp-tags').value)
      const cats = parseListInput(bodyEl.querySelector('#tp-cats').value)
      const draft = !!bodyEl.querySelector('#tp-draft').checked
      if (cats.length === 0) { alert('分类不能为空'); return }
      let dt = new Date(String(bodyEl.querySelector('#tp-date').value))
      if (!(dt instanceof Date) || isNaN(dt.getTime())) dt = new Date()
      if (settings.publishTimeOffset) dt = new Date(dt.getTime() + settings.publishTimeOffset * 3600 * 1000)

      try {
        const postStruct = { title, description: body, mt_keywords: tags.join(','), categories: cats, post_type: 'post', wp_slug: slug || '', mt_allow_comments: 1, dateCreated: dt }
        const hasCid = !!preset.cid
        const method = hasCid ? 'metaWeblog.editPost' : 'metaWeblog.newPost'
        const params = hasCid
          ? [ String(preset.cid), settings.username, settings.password, postStruct, !draft ]
          : [ String(settings.blogId || '0'), settings.username, settings.password, postStruct, !draft ]
        const xml = xmlBuildCall(method, params)
        const result = await xmlRpcPost(ctx, settings.endpoint, xml, settings.proxyUrl)

        const updated = Object.assign({}, fm)
        updated['title'] = title
        updated['tags'] = tags
        updated['categories'] = cats
        updated['draft'] = draft
        updated['dateCreated'] = iso8601(dt)
        if (!hasCid) {
          const newCid = String(result)
          updated['cid'] = newCid
          if (!slug) slug = newCid
        }
        updated['slug'] = slug
        const newDoc = rebuildDoc(updated, body)
        ctx.setEditorValue(newDoc)
        try { ctx.ui?.notice?.(hasCid ? '更新成功' : '发布成功', 'ok', 1800) } catch {}
        close()
      } catch (e) {
        console.error(e)
        alert('发布失败: ' + (e?.message || e))
      }
    })
  })
}

export async function activate(ctx) {
  // Add menu entry to open the publish dialog
  ctx.addMenuItem({ label: '发布到 Typecho', title: '将当前文档发布到 Typecho (XML-RPC)', onClick: async () => { await openPublishDialog(ctx) } })
}

export function deactivate() {}
