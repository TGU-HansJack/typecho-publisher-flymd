// Typecho Publisher for flymd (ESM)
// Minimal plugin: publish current document to Typecho via XML-RPC.
// Settings are stored in localStorage; network uses fetch and supports a user-provided CORS proxy.

const LS_KEY = 'flymd:typecho-publisher:settings'

function getSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {} } catch { return {} }
}
function saveSettings(s) {
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

async function xmlRpcPost(endpoint, xml, proxyUrl) {
  const url = buildProxiedUrl(endpoint, proxyUrl)
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
  return xmlParseResponse(text)
}

function parseListInput(s) { return (s || '').split(',').map(x => x.trim()).filter(Boolean) }

export async function activate(ctx) {
  // Add a simple menu entry: Publish to Typecho
  ctx.addMenuItem({ label: '发布到 Typecho', title: '将当前文档发布到 Typecho (XML-RPC)', onClick: async () => {
    try {
      const settings = Object.assign({ endpoint: '', proxyUrl: '', username: '', password: '', blogId: '0', useCurrentTime: true, publishTimeOffset: 0 }, getSettings() || {})

      // Ensure essential settings exist
      if (!settings.endpoint) settings.endpoint = prompt('Typecho XML-RPC 接口地址 (例: https://site/xmlrpc.php):', settings.endpoint || '') || ''
      if (!settings.username) settings.username = prompt('Typecho 用户名:', settings.username || '') || ''
      if (!settings.password) settings.password = prompt('Typecho 密码:', settings.password || '') || ''
      if (!settings.blogId) settings.blogId = prompt('默认博客ID:', settings.blogId || '0') || '0'
      // Proxy (optional, used to bypass CORS)
      settings.proxyUrl = prompt('可选：CORS 代理地址 (可含 {target} 占位):', settings.proxyUrl || '') || ''
      saveSettings(settings)

      if (!settings.endpoint || !settings.username || !settings.password) { alert('接口/账号信息不完整'); return }

      const raw = ctx.getEditorValue()
      const { data: fm, body, had } = parseFrontmatter(raw)
      const k = { title: 'title', slug: 'slug', tags: 'tags', categories: 'categories', draft: 'draft', cid: 'cid', dateCreated: 'dateCreated' }

      const preset = {
        title: (fm[k.title] || '').toString() || '未命名文档',
        slug: (fm[k.slug] || '').toString(),
        tags: Array.isArray(fm[k.tags]) ? fm[k.tags] : parseListInput(fm[k.tags] || ''),
        categories: Array.isArray(fm[k.categories]) ? fm[k.categories] : parseListInput(fm[k.categories] || ''),
        draft: !!fm[k.draft],
        dateCreated: fm[k.dateCreated] ? new Date(String(fm[k.dateCreated])) : new Date(),
        cid: fm[k.cid] ? String(fm[k.cid]) : ''
      }

      // Ask missing publish inputs (minimal flow)
      const title = prompt('标题', preset.title) || preset.title
      let slug = prompt('Slug (可留空)', preset.slug || '') || ''
      const tagsStr = prompt('标签 (逗号分隔)', preset.tags.join(', ')) || ''
      const catsStr = prompt('分类 (逗号分隔，至少 1 个)', preset.categories.join(', ')) || ''
      if (!catsStr.trim()) { alert('分类不能为空'); return }
      const draftAns = prompt('草稿? 输入 yes/no', preset.draft ? 'yes' : 'no') || (preset.draft ? 'yes' : 'no')
      const draft = /^y(es)?$/i.test(draftAns)
      const useCurAns = prompt('使用当前时间作为发布时间? 输入 yes/no', 'yes') || 'yes'
      const useCurrentTime = /^y(es)?$/i.test(useCurAns)
      const offsetStr = prompt('发布时间偏移（小时，可为负，默认 0）', '0') || '0'
      const offset = parseFloat(offsetStr) || 0

      let postDate = useCurrentTime ? new Date() : (preset.dateCreated || new Date())
      if (offset) postDate = new Date(postDate.getTime() + offset * 3600 * 1000)

      const postStruct = {
        title,
        description: body,
        mt_keywords: parseListInput(tagsStr).join(','),
        categories: parseListInput(catsStr),
        post_type: 'post',
        wp_slug: slug || '',
        mt_allow_comments: 1,
        dateCreated: postDate,
      }

      const hasCid = !!preset.cid
      const method = hasCid ? 'metaWeblog.editPost' : 'metaWeblog.newPost'
      const params = hasCid
        ? [ String(preset.cid), settings.username, settings.password, postStruct, !draft ]
        : [ String(settings.blogId || '0'), settings.username, settings.password, postStruct, !draft ]

      const xml = xmlBuildCall(method, params)
      const result = await xmlRpcPost(settings.endpoint, xml, settings.proxyUrl)

      if (!hasCid) {
        const newCid = String(result)
        // Write back frontmatter
        const updated = Object.assign({}, fm)
        updated[k.title] = title
        updated[k.tags] = parseListInput(tagsStr)
        updated[k.categories] = parseListInput(catsStr)
        updated[k.draft] = draft
        updated[k.dateCreated] = iso8601(postDate)
        updated[k.cid] = newCid
        if (!slug) slug = newCid
        updated[k.slug] = slug
        const newDoc = rebuildDoc(updated, body)
        ctx.setEditorValue(newDoc)
        alert(`发布成功 (cid=${newCid})`)
      } else {
        const updated = Object.assign({}, fm)
        updated[k.title] = title
        updated[k.tags] = parseListInput(tagsStr)
        updated[k.categories] = parseListInput(catsStr)
        updated[k.draft] = draft
        updated[k.dateCreated] = iso8601(postDate)
        updated[k.slug] = slug
        const newDoc = rebuildDoc(updated, body)
        ctx.setEditorValue(newDoc)
        alert('更新成功')
      }
    } catch (e) {
      console.error(e)
      alert('发布失败: ' + (e?.message || String(e)))
    }
  } })
}

export function deactivate() {}

