// CDP driver for the harness window: plays real songs through the real app + NativeAudio + Capacitor bridge protocol.
const fs = require('fs')
const PORT = process.env.PORT || 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const consoleMsgs = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    } else if (d.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push(`[${d.params.type}] ` + d.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    } else if (d.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push('[exception] ' + JSON.stringify(d.params.exceptionDetails).slice(0, 300))
    }
  }
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable')
  const ev = async (expr) => {
    const d = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true })
    if (d.error) throw new Error(JSON.stringify(d.error))
    if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 500))
    return d.result.result.value
  }
  const shot = async (file) => {
    const d = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(d.result.data, 'base64'))
  }
  return { ev, send, shot, consoleMsgs, close: () => ws.close() }
}

module.exports = { connect, sleep }
