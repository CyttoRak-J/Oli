import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Database } from '../src/main/services/database'
import { runMigrations } from '../src/main/services/migrations'
import { DownloadService } from '../src/main/services/downloads'
import { initLogger } from '../src/main/services/logger'

initLogger(os.tmpdir())

const BODY = Buffer.from('not really flac but bytes are bytes '.repeat(5000))
const GOOD_MD5 = createHash('md5').update(BODY).digest('hex')

describe('plain-file downloads (Internet Archive)', () => {
  let dir: string
  let db: Database
  let server: http.Server
  let base: string
  let svc: DownloadService

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oli-dl-'))
    db = new Database({ file: path.join(dir, 'library.sqlite') })
    await db.init()
    await runMigrations(db)
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length })
      res.end(BODY)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/f.flac`
    svc = new DownloadService(db, path.join(dir, 'downloads'))
  })
  afterAll(async () => {
    server.close()
    await db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function settle(id: string): Promise<ReturnType<DownloadService['getItem']>> {
    for (let i = 0; i < 100; i++) {
      const it = svc.getItem(id)
      if (it && it.state !== 'queued' && it.state !== 'downloading') return it
      await new Promise((r) => setTimeout(r, 50))
    }
    return svc.getItem(id)
  }

  it('saves into <folder>/<file>, verifies md5 and keeps a long name\'s extension', async () => {
    const longName = 'x'.repeat(200) + '.flac'
    const row = await svc.enqueueFile(base, { title: 'Good', fileName: longName, folder: 'Album: One?', md5: GOOD_MD5 })
    const done = await settle(row!.id)
    expect(done?.state).toBe('completed')
    expect(done?.destPath.endsWith('.flac')).toBe(true)
    expect(path.basename(path.dirname(done!.destPath))).toBe('Album_ One_')
    expect(fs.readFileSync(done!.destPath).equals(BODY)).toBe(true)
  })

  it('fails and deletes the file when the checksum is wrong', async () => {
    const row = await svc.enqueueFile(base, { title: 'Bad', fileName: 'bad.flac', folder: 'Album', md5: '0'.repeat(32) })
    const done = await settle(row!.id)
    expect(done?.state).toBe('failed')
    expect(done?.error).toMatch(/Checksum mismatch/)
    expect(fs.existsSync(done!.destPath)).toBe(false)
  })

  it('does not queue the same file twice while it is pending', async () => {
    const a = await svc.enqueueFile(base + '?a', { title: 'Dup', fileName: 'dup.flac', folder: 'Album' })
    const b = await svc.enqueueFile(base + '?a', { title: 'Dup', fileName: 'dup.flac', folder: 'Album' })
    expect(b?.id).toBe(a?.id)
    await settle(a!.id)
  })

  it('rejects non-http urls', async () => {
    expect(await svc.enqueueFile('file:///C:/x', { title: 'x', fileName: 'x.flac' })).toBeNull()
  })
})
