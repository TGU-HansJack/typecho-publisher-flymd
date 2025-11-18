// Typecho Publisher for flymd (ESM)
// Provides a publish dialog, settings UI, and header button using Tauri HTTP.

const LS_KEY = 'flymd:typecho-publisher:settings'

async function loadSettings(ctx) {
  try {
    if (ctx?.storage?.get) {
      const stored = await ctx.storage.get('settings')
      if (stored && typeof stored === 'object') return stored
    }
  } catch {}
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

async function saveSettings(ctx, settings) {
  try {
    if (ctx?.storage?.set) {
      await ctx.storage.set('settings', settings)
      return
    }
  } catch {}
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(settings))
  } catch {}
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

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

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { data: {}, body: text, had: false }
  const yaml = match[1]
  const body = text.slice(match[0].length)
  const lines = yaml.split(/\r?\n/)
  const data = {}
  let curKey = null
  for (const line of lines) {
    const m2 = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/)
    if (m2) {
      const key = m2[1]
      let value = m2[2]
      if (value === '' || value === null || value === undefined) {
        data[key] = ''
        curKey = key
        continue
      }
      if (/^(true|false)$/i.test(value)) {
        data[key] = /^true$/i.test(value)
        curKey = null
        continue
      }
      if (/^\[.*\]$/.test(value)) {
        const inner = value.slice(1, -1).trim()
        data[key] = inner ? inner.split(',').map((s) => s.trim()).filter(Boolean) : []
        curKey = null
        continue
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      data[key] = value
      curKey = null
      continue
    }
    const list = line.match(/^\s*-\s*(.+)$/)
    if (list && curKey) {
      if (!Array.isArray(data[curKey])) data[curKey] = []
      data[curKey].push(list[1])
      continue
    }
    if (/^\S/.test(line)) curKey = null
  }
  return { data, body, had: true }
}

function needsQuote(value) {
  return /[:#\-?&*!\[\]{},>|'%@`]/.test(value) || /\s/.test(value)
}

function writeYaml(data) {
  const out = []
  const pushEntry = (key, value) => {
    if (Array.isArray(value)) {
      out.push(`${key}:`)
      for (const it of value) {
        let val = String(it)
        if (needsQuote(val)) val = '"' + val.replace(/"/g, '\\"') + '"'
        out.push(`  - ${val}`)
      }
    } else if (typeof value === 'boolean') {
      out.push(`${key}: ${value ? 'true' : 'false'}`)
    } else if (value === null || value === undefined) {
      out.push(`${key}:`)
    } else {
      let val = String(value)
      if (needsQuote(val)) val = '"' + val.replace(/"/g, '\\"') + '"'
      out.push(`${key}: ${val}`)
    }
  }
  for (const key of Object.keys(data)) pushEntry(key, data[key])
  return out.join('\n')
}

function rebuildDoc(fm, body) {
  return `---\n${writeYaml(fm)}\n---\n\n${body}`
}

const httpState = { available: null, checking: null, error: null }

async function ensureHttpAvailable(ctx, { silent = false } = {}) {
  if (httpState.available === true) return true
  if (!httpState.checking) {
    httpState.checking = (async () => {
      try {
        if (ctx?.http?.available) {
          // 由上层提供的 available() 即视为可用；避免外部网络探测导致误报不可用
          const ok = await ctx.http.available()
          httpState.available = (ok !== false)
          if (httpState.available) httpState.error = null
        } else {
          httpState.available = !!ctx?.http?.fetch
          if (!httpState.available) httpState.error = new Error('ctx.http.fetch 不可用')
        }
      } catch (e) {
        httpState.available = false
        httpState.error = e
      } finally {
        httpState.checking = null
      }
      return httpState.available
    })()
  }
  const result = await httpState.checking
  if (!result && !silent) {
    ctx?.ui?.notice?.('网络层不可用：请在桌面版使用或确保已启用 @tauri-apps/plugin-http', 'err', 4000)
  }
  return !!result
}

function responseOk(res) {
  if (!res) return false
  if (typeof res.ok === 'boolean') return res.ok
  const status = typeof res.status === 'number' ? res.status : 0
  return status >= 200 && status < 300
}

async function readResponseText(res) {
  if (!res) return ''
  if (typeof res.text === 'function') {
    try { return await res.text() } catch {}
  }
  if (typeof res.data === 'string') return res.data
  if (res.body && typeof res.body === 'string') return res.body
  return ''
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function xmlEncodeValue(v) {
  if (v === null || v === undefined) return '<nil/>'
  if (Array.isArray(v)) {
    return '<array><data>' + v.map((x) => `<value>${xmlEncodeValue(x)}</value>`).join('') + '</data></array>'
  }
  if (v instanceof Date) return `<dateTime.iso8601>${iso8601(v)}</dateTime.iso8601>`
  const t = typeof v
  if (t === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`
  if (t === 'number') return Number.isInteger(v) ? `<int>${v}</int>` : `<double>${v}</double>`
  if (t === 'object') {
    return '<struct>' + Object.entries(v).map(([k, val]) => `<member><name>${xmlEscape(k)}</name><value>${xmlEncodeValue(val)}</value></member>`).join('') + '</struct>'
  }
  return `<string>${xmlEscape(String(v))}</string>`
}

function xmlBuildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>` +
    params.map((p) => `<param><value>${xmlEncodeValue(p)}</value></param>`).join('') +
    `</params></methodCall>`
}

function xmlParseResponse(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const fault = doc.getElementsByTagName('fault')[0]

  const parseVal = (node) => {
    if (!node) return null
    const name = node.nodeName
    if (name === 'value') {
      return node.children.length ? parseVal(node.children[0]) : (node.textContent ?? '')
    }
    if (['string', 'i4', 'int', 'double', 'boolean', 'dateTime.iso8601'].includes(name)) {
      const s = (node.textContent || '').trim()
      if (name === 'boolean') return s === '1'
      if (name === 'int' || name === 'i4') return parseInt(s, 10)
      if (name === 'double') return Number(s)
      return s
    }
    if (name === 'struct') {
      const result = {}
      const members = node.getElementsByTagName('member')
      for (let i = 0; i < members.length; i++) {
        const member = members[i]
        const key = member.getElementsByTagName('name')[0]?.textContent || ''
        const val = parseVal(member.getElementsByTagName('value')[0])
        result[key] = val
      }
      return result
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
    const valueNode = fault.getElementsByTagName('value')[0]
    const payload = parseVal(valueNode)
    const msg = (payload && (payload.faultString || payload['faultString'])) || 'XML-RPC 错误'
    const code = (payload && (payload.faultCode || payload['faultCode'])) || -1
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
  } catch {
    return endpoint
  }
}

async function xmlRpcPost(ctx, endpoint, xml, proxyUrl) {
  const url = buildProxiedUrl(endpoint, proxyUrl)
  const http = ctx?.http
  const available = await ensureHttpAvailable(ctx)
  if (!available || !http?.fetch) {
    // 兜底：走后端命令（由宿主注入 ctx.invoke），规避 plugin-http 域名白名单
    try {
      const text = await (ctx?.invoke ? ctx.invoke('http_xmlrpc_post', { req: { url, xml } }) : Promise.reject(new Error('invoke unavailable')))
      return xmlParseResponse(text)
    } catch (e) {
      throw new Error('Tauri HTTP 不可用，无法完成请求')
    }
  }
  const headers = {
    'Content-Type': 'text/xml; charset=UTF-8',
    'Accept': 'text/xml, */*;q=0.1',
    'Cache-Control': 'no-cache',
    'User-Agent': 'flymd-typecho-publisher/0.1'
  }
  const options = {
    method: 'POST',
    headers,
    body: http.Body?.text ? http.Body.text(xml) : xml,
    timeout: 20000
  }
  if (http.ResponseType?.Text !== undefined && options.responseType === undefined) {
    options.responseType = http.ResponseType.Text
  }
  try {
    const resp = await http.fetch(url, options)
    const text = await readResponseText(resp)
    if (!responseOk(resp)) {
      const tip = `URL=${url}; endpoint=${endpoint}; proxy=${proxyUrl || ''}`
      throw new Error(`HTTP ${resp?.status ?? 'ERR'}: ${text.slice(0, 200)}\n${tip}`)
    }
    return xmlParseResponse(text)
  } catch (e) {
    // 若被 plugin-http 拦截（域名不在 scope）则回退到后端命令
    const msg = String(e?.message || e || '')
    if (/not allowed on the configured scope|scope/i.test(msg)) {
      const text = await (ctx?.invoke ? ctx.invoke('http_xmlrpc_post', { req: { url, xml } }) : Promise.reject(new Error('invoke unavailable')))
      return xmlParseResponse(text)
    }
    throw e
  }
}

function parseListInput(s) {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean)
}

function ensureStyle() {
  if (document.getElementById('tp-fly-style')) return
  const css = `
  .tp-fly-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:90000}  
  .tp-fly-hidden{display:none}
  .tp-fly-dialog{width:560px;max-width:calc(100% - 40px);background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.2);}
  .tp-fly-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);font-weight:600;font-size:16px}  
  .tp-fly-body{padding:24px 30px;max-height:65vh;overflow:auto}
  .tp-fly-grid{display:grid;grid-template-columns:120px 1fr;gap:18px;align-items:start;margin-bottom:18px}
  .tp-fly-grid label{color:var(--muted);font-size:14px;font-weight:500;padding-top:8px}
  .tp-fly-grid input[type="text"],.tp-fly-grid input[type="password"],.tp-fly-grid input[type="url"],.tp-fly-grid input[type="datetime-local"]{width:100%;padding:12px 14px;border:1px solid var(--border);background:var(--bg);color:var(--fg);border-radius:8px;outline:none;font-size:14px;min-width:0;box-sizing:border-box}
  .tp-fly-grid input[type="checkbox"]{transform: scale(1.2);margin: 16px 0}
  .tp-fly-actions{display:flex;justify-content:flex-end;gap:14px;margin-top:24px;padding-top:20px;border-top:1px solid var(--border)}
  .tp-fly-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:8px;padding:10px 20px;font-size:14px;transition:all 0.2s}
  .tp-fly-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff}
  .tp-fly-btn:hover{background:rgba(127,127,127,.14)}
  .tp-fly-btn.primary:hover{background:#1d4ed8;border-color:#1d4ed8}
  .tp-fly-rowfull{grid-column:1/-1;color:var(--muted);font-size:13px;padding:16px 20px;line-height:1.6;background-color:rgba(127,127,127,.05);border-radius:8px;margin:12px 0;border:1px solid rgba(127,127,127,.1)}
  .tp-fly-headbar{display:flex;align-items:center;gap:12px;margin:0 16px 0 12px;-webkit-appregion:no-drag}
  .tp-fly-head-btn{cursor:pointer;border:1px solid var(--border);background:rgba(127,127,127,.08);color:var(--fg);border-radius:8px;padding:6px 12px;font-size:13px;transition:all 0.2s}
  .tp-fly-head-btn.primary{border-color:#2563eb;background:#2563eb;color:#fff}
  .tp-fly-head-btn:hover{background:rgba(127,127,127,.14)}
  `
  const style = document.createElement('style')
  style.id = 'tp-fly-style'
  style.textContent = css
  document.head.appendChild(style)
}

function ensureHeadbar() {
  const titlebar = document.querySelector('.titlebar')
  if (!titlebar) return null
  let host = titlebar.querySelector('.tp-fly-headbar')
  if (!host) {
    host = document.createElement('div')
    host.className = 'tp-fly-headbar'
    const filename = titlebar.querySelector('.filename')
    if (filename && filename.parentElement === titlebar) {
      titlebar.insertBefore(host, filename.nextSibling)
    } else {
      titlebar.appendChild(host)
    }
  }
  return host
}

function addHeaderButton({ id, label, title, onClick, primary = false }) {
  let disposed = false
  let button = null
  let host = null

  const attach = () => {
    if (disposed) return true
    host = ensureHeadbar()
    if (!host) return false
    if (id) {
      const dup = host.querySelector(`[data-tp-fly-id="${id}"]`)
      if (dup) {
        try { dup.remove() } catch {}
      }
    }
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'tp-fly-head-btn' + (primary ? ' primary' : '')
    button.textContent = label
    if (title) button.title = title
    if (id) button.dataset.tpFlyId = id
    button.addEventListener('click', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      try {
        const result = onClick?.()
        if (result && typeof result.then === 'function') result.catch((err) => console.error(err))
      } catch (err) {
        console.error(err)
      }
    })
    host.appendChild(button)
    return true
  }

  if (!attach()) {
    const timer = setInterval(() => {
      if (attach() || disposed) clearInterval(timer)
    }, 400)
    return () => {
      disposed = true
      clearInterval(timer)
      if (button) try { button.remove() } catch {}
      if (host && host.children.length === 0) try { host.remove() } catch {}
    }
  }

  return () => {
    disposed = true
    if (button) try { button.remove() } catch {}
    if (host && host.children.length === 0) try { host.remove() } catch {}
  }
}

function openOverlay(title, contentBuilder) {
  ensureStyle()
  const overlay = document.createElement('div')
  overlay.className = 'tp-fly-overlay'
  const dialog = document.createElement('div')
  dialog.className = 'tp-fly-dialog'
  dialog.innerHTML = `<div class="tp-fly-header"><div>${title}</div><button class="tp-fly-btn" id="tp-close" type="button">×</button></div><div class="tp-fly-body"></div>`
  document.body.appendChild(overlay)
  overlay.appendChild(dialog)
  const body = dialog.querySelector('.tp-fly-body')
  const close = () => { try { overlay.remove() } catch {} }
  dialog.querySelector('#tp-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  contentBuilder(body, close)
  return { overlay, dialog, body, close }
}

export async function openSettings(ctx) {
  const defaults = { endpoint: '', proxyUrl: '', username: '', password: '', blogId: '0', useCurrentTime: true, publishTimeOffset: 0 } 
  const s = Object.assign({}, defaults, await loadSettings(ctx) || {})
  openOverlay('Typecho 发布器设置', (body, close) => {
    const wrap = document.createElement('div')
    wrap.className = 'tp-fly-grid'
    wrap.innerHTML = `
      <label>接口 URL</label><input id="tp-endpoint" type="url" placeholder="https://your-site/action/xmlrpc.php" value="${s.endpoint || ''}">
      <label>用户名</label><input id="tp-username" type="text" value="${s.username || ''}">
      <label>密码</label><input id="tp-password" type="password" value="${s.password || ''}">
      <label>默认博客ID</label><input id="tp-blogid" type="text" value="${s.blogId || '0'}">
      <label>CORS 代理</label><input id="tp-proxy" type="url" placeholder="可含 {target}" value="${s.proxyUrl || ''}">
      <div class="tp-fly-rowfull">建议优先使用桌面环境（内置原生网络层）避免 CORS；如需浏览器端使用，请配置自建代理。</div>
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
    actions.appendChild(btnTest)
    actions.appendChild(btnSave)
    actions.appendChild(btnCancel)
    body.appendChild(actions)

    btnCancel.addEventListener('click', close)
    btnSave.addEventListener('click', async () => {
      const next = {
        endpoint: body.querySelector('#tp-endpoint').value.trim(),
        username: body.querySelector('#tp-username').value.trim(),
        password: body.querySelector('#tp-password').value,
        blogId: body.querySelector('#tp-blogid').value.trim() || '0',
        proxyUrl: body.querySelector('#tp-proxy').value.trim(),
        useCurrentTime: !!body.querySelector('#tp-usecur').checked,
        publishTimeOffset: parseFloat(body.querySelector('#tp-offset').value) || 0,
      }
      await saveSettings(ctx, next)
      try { ctx.ui?.notice?.('设置已保存', 'ok', 1500) } catch {}
      close()
    })

    btnTest.addEventListener('click', async () => {
      try {
        const ready = await ensureHttpAvailable(ctx)
        if (!ready) return
        const endpoint = body.querySelector('#tp-endpoint').value.trim()
        const proxy = body.querySelector('#tp-proxy').value.trim()
        if (!endpoint) { alert('请填写接口 URL'); return }
        const xml = xmlBuildCall('system.listMethods', [])
        await xmlRpcPost(ctx, endpoint, xml, proxy)
        alert('连接正常')
      } catch (e) {
        alert('连接失败: ' + (e?.message || e))
      }
    })
  })
}

function toLocalDateTimeString(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

async function openPublishDialog(ctx) {
  const settings = Object.assign({ endpoint: '', proxyUrl: '', username: '', password: '', blogId: '0', useCurrentTime: true, publishTimeOffset: 0 }, await loadSettings(ctx) || {})
  if (!await ensureHttpAvailable(ctx)) return
  if (!settings.endpoint || !settings.username || !settings.password) {
    const go = await ctx.ui?.confirm?.('尚未配置 Typecho 参数，是否现在设置？')
    if (go) return openSettings(ctx)
    return
  }

  const raw = ctx.getEditorValue()
  const { data: fm, body } = parseFrontmatter(raw)
  const keys = { title: 'title', slug: 'slug', tags: 'tags', categories: 'categories', draft: 'draft', cid: 'cid', dateCreated: 'dateCreated' }
  const preset = {
    title: (fm[keys.title] || '').toString() || '未命名文档',
    slug: (fm[keys.slug] || '').toString(),
    tags: Array.isArray(fm[keys.tags]) ? fm[keys.tags] : parseListInput(fm[keys.tags] || ''),
    categories: Array.isArray(fm[keys.categories]) ? fm[keys.categories] : parseListInput(fm[keys.categories] || ''),
    draft: !!fm[keys.draft],
    dateCreated: fm[keys.dateCreated] ? new Date(String(fm[keys.dateCreated])) : new Date(),
    cid: fm[keys.cid] ? String(fm[keys.cid]) : ''
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
      <label>发布时间</label><input id="tp-date" type="datetime-local" value="${toLocalDateTimeString(initDate)}">
      <div class="tp-fly-rowfull">将使用设置中的时间偏移 ${settings.publishTimeOffset || 0} 小时</div>
    `
    bodyEl.appendChild(wrap)
    const actions = document.createElement('div')
    actions.className = 'tp-fly-actions'
    const btnCancel = document.createElement('button')
    btnCancel.className = 'tp-fly-btn'
    btnCancel.textContent = '取消'
    const btnOpenSettings = document.createElement('button')
    btnOpenSettings.className = 'tp-fly-btn'
    btnOpenSettings.textContent = '设置'
    const btnPublish = document.createElement('button')
    btnPublish.className = 'tp-fly-btn primary'
    btnPublish.textContent = '发布'
    actions.appendChild(btnCancel)
    actions.appendChild(btnOpenSettings)
    actions.appendChild(btnPublish)
    bodyEl.appendChild(actions)

    btnCancel.addEventListener('click', close)
    btnOpenSettings.addEventListener('click', () => { try { openSettings(ctx) } catch {} })
    btnPublish.addEventListener('click', async () => {
      const title = bodyEl.querySelector('#tp-title').value.trim() || '未命名文档'
      let slug = bodyEl.querySelector('#tp-slug').value.trim()
      const tags = parseListInput(bodyEl.querySelector('#tp-tags').value)
      const categories = parseListInput(bodyEl.querySelector('#tp-cats').value)
      const draft = !!bodyEl.querySelector('#tp-draft').checked
      if (categories.length === 0) { alert('分类不能为空'); return }
      let dt = new Date(String(bodyEl.querySelector('#tp-date').value))
      if (!(dt instanceof Date) || isNaN(dt.getTime())) dt = new Date()
      if (settings.publishTimeOffset) dt = new Date(dt.getTime() + settings.publishTimeOffset * 3600 * 1000)

      try {
        const postStruct = {
          title,
          description: body,
          mt_keywords: tags.join(','),
          categories,
          post_type: 'post',
          wp_slug: slug || '',
          mt_allow_comments: 1,
          dateCreated: dt
        }
        const hasCid = !!preset.cid
        const method = hasCid ? 'metaWeblog.editPost' : 'metaWeblog.newPost'
        const params = hasCid
          ? [String(preset.cid), settings.username, settings.password, postStruct, !draft]
          : [String(settings.blogId || '0'), settings.username, settings.password, postStruct, !draft]
        const xml = xmlBuildCall(method, params)
        const result = await xmlRpcPost(ctx, settings.endpoint, xml, settings.proxyUrl)

        const updated = Object.assign({}, fm)
        updated.title = title
        updated.tags = tags
        updated.categories = categories
        updated.draft = draft
        updated.dateCreated = iso8601(dt)
        if (!hasCid) {
          const newCid = String(result)
          updated.cid = newCid
          if (!slug) slug = newCid
        }
        updated.slug = slug
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

const activeDisposers = []

function registerDisposer(fn) {
  if (typeof fn === 'function') activeDisposers.push(fn)
  return fn
}

function cleanupDisposers() {
  while (activeDisposers.length) {
    const fn = activeDisposers.pop()
    try { fn() } catch {}
  }
}

export async function activate(ctx) {
  cleanupDisposers()
  ensureStyle()
  await ensureHttpAvailable(ctx, { silent: false })
  const openPublish = () => openPublishDialog(ctx)
  const openSettingsDialog = () => openSettings(ctx)

  const menuPublish = ctx?.addMenuItem?.({
    label: '发布到 Typecho',
    title: '将当前文档发布到 Typecho (XML-RPC)',
    onClick: () => { void openPublish() }
  })
  if (typeof menuPublish === 'function') registerDisposer(menuPublish)

  const menuSettings = ctx?.addMenuItem?.({
    label: 'Typecho 设置',
    title: '配置 Typecho 发布参数',
    onClick: () => { void openSettingsDialog() }
  })
  if (typeof menuSettings === 'function') registerDisposer(menuSettings)

  registerDisposer(addHeaderButton({
    id: 'tp-fly-typecho-publish',
    label: 'Typecho 发布',
    title: '发布当前文档到 Typecho',
    primary: true,
    onClick: () => { void openPublish() }
  }))
}

export function deactivate() {
  cleanupDisposers()
  httpState.available = null
  httpState.checking = null
  httpState.error = null
}
