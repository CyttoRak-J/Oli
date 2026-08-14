import { forwardRef, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DatabaseBackup,
  Check,
  FolderPlus,
  FolderOpen,
  Loader2,
  RefreshCw,
  ScanLine,
  Trash2,
  Eye,
  EyeOff,
  X
} from 'lucide-react'
import type { AppSettings, ScanProgress, ThemeMode, RepeatMode } from '@shared/types'
import { useSettings } from '../store/settings'
import {
  addLibraryFolder,
  cancelScan,
  getAppInfo,
  getLibraryFolders,
  getScanState,
  listBackups,
  removeLibraryFolder,
  rescanLibrary,
  restoreBackup,
  createBackup,
  checkForUpdates,
  isProviderConfigured,
  on
} from '../lib/ipc'
import { formatCount, formatFileSize } from '../lib/format'
import { IPC } from '@shared/ipc'
import { cn } from '../components/cn'
import { ThemedSelect } from '../components/ThemedSelect'

export function Settings(): React.JSX.Element {
  const store = useSettings()
  const s = store.settings
  const [showSecret, setShowSecret] = useState(false)
  const [savedKeys, setSavedKeys] = useState(false)
  const spotifyIdRef = useRef<HTMLInputElement>(null)
  const spotifySecretRef = useRef<HTMLInputElement>(null)
  const youtubeKeyRef = useRef<HTMLInputElement>(null)
  const acoustidKeyRef = useRef<HTMLInputElement>(null)

  const appInfo = useQuery({ queryKey: ['app-info'], queryFn: getAppInfo })

  if (!s) return <div className="p-6 text-[13px] text-ink-3">Loading settings…</div>

  const set = (patch: Partial<AppSettings>): void => {
    void store.set(patch)
  }

  const saveKeys = async (): Promise<void> => {
    await store.set({
      spotifyClientId: spotifyIdRef.current?.value.trim() ?? '',
      spotifyClientSecret: spotifySecretRef.current?.value.trim() ?? '',
      youtubeApiKey: youtubeKeyRef.current?.value.trim() ?? '',
      acoustidApiKey: acoustidKeyRef.current?.value.trim() ?? ''
    })
    setSavedKeys(true)
    setTimeout(() => setSavedKeys(false), 1500)
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-ink-0">Settings</h1>
      <div className="space-y-8 pb-8">
        <Section title="Library">
          <LibrarySection />
        </Section>

        <Section title="Appearance">
          <Row label="Theme">
            <ThemedSelect
              value={s.themeMode}
              onChange={(v) => set({ themeMode: v as ThemeMode })}
              options={[
                ['dark', 'Dark'],
                ['amoled', 'OLED'],
                ['light', 'Light']
              ]}
            />
          </Row>
          <Row label="Accent color">
            <div className="flex items-center gap-3">
              <input
                type="color"
                className="h-8 w-10 cursor-pointer rounded border border-surface-4 bg-surface-2"
                value={s.accentColor ?? '#7c3aed'}
                onChange={(e) => set({ accentColor: e.target.value })}
              />
              <Toggle checked={s.accentFromArtwork} onChange={(v) => set({ accentFromArtwork: v })} label="From artwork" />
            </div>
          </Row>
          <Row label="Reduce motion">
            <Toggle checked={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
          </Row>
        </Section>

        <Section title="Audio">
          <Row label="Replay gain">
            <ThemedSelect
              value={s.replayGainMode}
              onChange={(v) => set({ replayGainMode: v as AppSettings['replayGainMode'] })}
              options={[
                ['off', 'Off'],
                ['track', 'Track'],
                ['album', 'Album']
              ]}
            />
          </Row>
          <Row label="Crossfade (seconds)">
            <NumberInput value={s.crossfadeSeconds} min={0} max={12} step={0.5} onChange={(v) => set({ crossfadeSeconds: v })} />
          </Row>
          <Row label="Playback speed">
            <NumberInput value={s.playbackSpeed} min={0.5} max={2} step={0.05} onChange={(v) => set({ playbackSpeed: v })} />
          </Row>
          <Row label="Preserve pitch when speeding up">
            <Toggle checked={s.preservePitch} onChange={(v) => set({ preservePitch: v })} />
          </Row>
          <Row label="Shuffle default">
            <Toggle checked={s.shuffle} onChange={(v) => set({ shuffle: v })} />
          </Row>
          <Row label="Repeat default">
            <ThemedSelect
              value={s.repeat}
              onChange={(v) => set({ repeat: v as RepeatMode })}
              options={[
                ['off', 'Off'],
                ['queue', 'Queue'],
                ['one', 'One']
              ]}
            />
          </Row>
        </Section>

        <Section title="Behavior">
          <ToggleRow label="Resume playback on launch" checked={s.resumeOnLaunch} onChange={(v) => set({ resumeOnLaunch: v })} />
          <ToggleRow label="Scan library on launch" checked={s.scanOnLaunch} onChange={(v) => set({ scanOnLaunch: v })} />
          <ToggleRow label="Watch folders for changes" checked={s.watchFolders} onChange={(v) => set({ watchFolders: v })} />
          <ToggleRow label="Minimize to tray" checked={s.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} />
          <ToggleRow label="Close to tray" checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} />
          <ToggleRow label="Show tray icon" checked={s.showTrayIcon} onChange={(v) => set({ showTrayIcon: v })} />
          <ToggleRow label="System media keys" checked={s.mediaKeysEnabled} onChange={(v) => set({ mediaKeysEnabled: v })} />
          <ToggleRow label="Taskbar progress" checked={s.taskbarProgressEnabled} onChange={(v) => set({ taskbarProgressEnabled: v })} />
          <ToggleRow label="Desktop notifications" checked={s.notificationsEnabled} onChange={(v) => set({ notificationsEnabled: v })} />
          <ToggleRow label="Online lyrics" checked={s.lyricsOnline === 'enabled'} onChange={(v) => set({ lyricsOnline: v ? 'enabled' : 'disabled' })} />
          <ToggleRow label="Mini player always on top" checked={s.miniPlayerAlwaysOnTop} onChange={(v) => set({ miniPlayerAlwaysOnTop: v })} />
          <ToggleRow label="Mini player in taskbar" checked={s.miniPlayerTaskbar} onChange={(v) => set({ miniPlayerTaskbar: v })} />
        </Section>

        <Section title="Provider keys">
          <Row label="Spotify Client ID">
            <SecretInput
              ref={spotifyIdRef}
              defaultValue={s.spotifyClientId}
              show={showSecret}
              placeholder="client id"
            />
          </Row>
          <Row label="Spotify Client Secret">
            <SecretInput
              ref={spotifySecretRef}
              defaultValue={s.spotifyClientSecret}
              show={showSecret}
              placeholder="client secret"
            />
          </Row>
          <Row label="YouTube API key">
            <SecretInput
              ref={youtubeKeyRef}
              defaultValue={s.youtubeApiKey}
              show={showSecret}
              placeholder="api key"
            />
          </Row>
          <Row label="AcoustID API key">
            <SecretInput
              ref={acoustidKeyRef}
              defaultValue={s.acoustidApiKey ?? ''}
              show={showSecret}
              placeholder="fingerprint fallback (acoustid.org)"
            />
          </Row>
          <Row label="">
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
                onClick={() => void saveKeys()}
              >
                {savedKeys && <Check size={13} />} Save keys
              </button>
              <button
                className="flex items-center gap-1.5 rounded-lg border border-surface-4 px-3 py-1.5 text-[12px] text-ink-2 hover:text-ink-0"
                onClick={() => setShowSecret((v) => !v)}
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                {showSecret ? 'Hide' : 'Show'}
              </button>
              <ProviderStatus />
            </div>
          </Row>
        </Section>

        <Section title="Downloads">
          <Row label="Songs prepared ahead (1-5)">
            <NumberInput
              value={s.songsAhead}
              min={1}
              max={5}
              step={1}
              onChange={(v) => set({ songsAhead: v })}
            />
          </Row>
          <div className="text-[12px] text-ink-3">
            While one song downloads, the next songs' metadata (cover, artist, album, genre) is
            resolved in advance so each one starts instantly. Needs the Spotify keys above for
            best matches; falls back to the iTunes catalog when not configured.
          </div>
          <Row label="Simultaneous YouTube downloads (1-3)">
            <NumberInput
              value={s.ytConcurrency}
              min={1}
              max={3}
              step={1}
              onChange={(v) => set({ ytConcurrency: v })}
            />
          </Row>
          <div className="text-[12px] text-ink-3">
            YouTube downloads normally run one at a time — running several yt-dlp processes at
            once can trip YouTube's bot check and fail them all. Only raise this if you
            regularly queue many songs and rarely see failures.
          </div>
        </Section>

        <Section title="Backup & restore">
          <BackupSection />
        </Section>

        <Section title="About & updates">
          <Row label="Version">
            <div className="text-[13px] text-ink-2">{appInfo.data?.version ?? '…'}</div>
          </Row>
          <Row label="Runtime">
            <div className="text-[12px] text-ink-3">
              {appInfo.data
                ? `Electron ${appInfo.data.electron} · Chromium ${appInfo.data.chrome} · Node ${appInfo.data.node}`
                : '…'}
            </div>
          </Row>
          <Row label="">
            <UpdateButton />
          </Row>
        </Section>
      </div>
    </div>
  )
}

function ProviderStatus(): React.JSX.Element {  const providers = useQuery({ queryKey: ['providers'], queryFn: () => isProviderConfigured() })
  const data = providers.data
  if (!data) return <span className="text-[11.5px] text-ink-3">checking…</span>
  const set = new Set<string>()
  if (data.spotify) set.add('Spotify')
  if (data.youtube) set.add('YouTube')
  return (
    <span className="text-[11.5px] text-ink-3">
      {set.size > 0 ? `${[...set].join(', ')} configured` : 'No providers configured'}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-edge bg-surface-1 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide text-ink-2">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function LibrarySection(): React.JSX.Element {
  const queryClient = useQueryClient()
  const foldersQuery = useQuery({ queryKey: ['library-folders'], queryFn: getLibraryFolders })
  const [scan, setScan] = useState<ScanProgress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getScanState().then(setScan)
    const unsubProgress = on<ScanProgress>(IPC.onScanProgress, setScan)
    const unsubChanged = on(IPC.onLibraryChanged, () => {
      void queryClient.invalidateQueries({ queryKey: ['library-folders'] })
    })
    return () => {
      unsubProgress()
      unsubChanged()
    }
  }, [queryClient])

  const showMsg = (m: string): void => {
    setMsg(m)
    setTimeout(() => setMsg(''), 3000)
  }

  const doAdd = async (): Promise<void> => {
    setBusy('add')
    try {
      const added = await addLibraryFolder()
      if (added && added.length > 0) showMsg(`Added ${added.length} folder${added.length === 1 ? '' : 's'}`)
    } finally {
      setBusy(null)
      void queryClient.invalidateQueries({ queryKey: ['library-folders'] })
    }
  }

  const doRemove = async (id: string): Promise<void> => {
    await removeLibraryFolder(id)
    void queryClient.invalidateQueries({ queryKey: ['library-folders'] })
  }

  const doRescan = async (): Promise<void> => {
    await rescanLibrary(false)
  }

  const scanning = scan !== null && scan.phase !== 'idle' && scan.phase !== 'finished' && scan.phase !== 'error'
  const pct =
    scan && scan.filesFound > 0 ? Math.min(100, Math.round((scan.filesProcessed / scan.filesFound) * 100)) : 0
  const folders = foldersQuery.data

  return (
    <>
      <Row label="Music folders">
        <button
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void doAdd()}
        >
          {busy === 'add' ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
          Add folders
        </button>
      </Row>

      {foldersQuery.isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : !folders || folders.length === 0 ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <FolderOpen size={14} />
          No folders added yet. Click “Add folders” and pick your music directory.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {folders.map((folder) => (
            <div
              key={folder.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-surface-4 bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-ink-0" title={folder.path}>
                  {folder.path}
                </div>
                <div className="text-[11px] text-ink-3">
                  {formatCount(folder.trackCount)} songs
                  {folder.totalSize > 0 ? ` · ${formatFileSize(folder.totalSize)}` : ''}
                </div>
              </div>
              <button
                className="shrink-0 rounded-lg border border-surface-4 p-1.5 text-ink-3 transition-colors hover:border-red-400 hover:text-red-400"
                title="Remove folder"
                onClick={() => void doRemove(folder.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {scanning && (
        <div className="flex flex-col gap-2 rounded-lg border border-surface-4 bg-surface-2 p-3">
          <div className="flex items-center justify-between text-[11.5px] text-ink-2">
            <span className="flex items-center gap-1.5">
              <ScanLine size={12} className="animate-pulse" />
              {scan.phase === 'discovering' ? 'Discovering files…' : 'Indexing library…'}
              {scan.filesFound > 0 && (
                <span className="text-ink-3">
                  {scan.filesProcessed}/{scan.filesFound}
                </span>
              )}
            </span>
            <button
              className="flex items-center gap-1 rounded-md border border-surface-4 px-2 py-0.5 text-[11px] text-ink-3 hover:text-ink-0"
              onClick={() => void cancelScan()}
            >
              <X size={11} /> Cancel
            </button>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-4">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          {scan.currentFile && <div className="truncate text-[10.5px] text-ink-3">{scan.currentFile}</div>}
        </div>
      )}

      <Row label="Rescan folders">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg border border-surface-4 px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent disabled:opacity-50"
            disabled={scanning}
            onClick={() => void doRescan()}
          >
            <RefreshCw size={13} />
            Rescan now
          </button>
          <span className="text-[11.5px] text-ink-3">{msg}</span>
        </div>
      </Row>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-ink-1">{label}</span>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <Row label={label}>
      <Toggle checked={checked} onChange={onChange} />
    </Row>
  )
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
        checked ? 'border-accent bg-accent' : 'border-surface-4 bg-surface-2'
      )}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label ?? (checked ? 'On' : 'Off')}
    >
      <span
        className={cn(
          'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white transition-all',
          checked ? 'right-0.5' : 'left-0.5'
        )}
      />
    </button>
  )
}

function NumberInput({
  value,
  min,
  max,
  step,
  onChange
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <input
      type="number"
      className="w-24 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-right text-[12.5px] text-ink-0 outline-none focus:border-accent"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!Number.isNaN(v)) onChange(v)
      }}
    />
  )
}

const SecretInput = forwardRef<HTMLInputElement, {
  defaultValue: string
  show: boolean
  placeholder: string
}>(function SecretInput({ defaultValue, show, placeholder }, ref): React.JSX.Element {
  return (
    <input
      ref={ref}
      type={show ? 'text' : 'password'}
      className="w-64 rounded-lg border border-surface-4 bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-ink-0 outline-none focus:border-accent"
      defaultValue={defaultValue}
      placeholder={placeholder}
    />
  )
})

function BackupSection(): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void listBackups().then((l) => setCount(l.length))
  }, [])

  const doCreate = async (): Promise<void> => {
    setBusy('create')
    await createBackup()
    setBusy(null)
    void listBackups().then((l) => setCount(l.length))
    setMsg('Backup created')
    setTimeout(() => setMsg(''), 2000)
  }

  const doRestore = async (): Promise<void> => {
    setBusy('restore')
    const ok = await restoreBackup()
    setBusy(null)
    setMsg(ok ? 'Restored (restart may be needed)' : 'Restore failed')
    setTimeout(() => setMsg(''), 3000)
  }

  return (
    <>
      <Row label="Data backups">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void doCreate()}
          >
            {busy === 'create' ? <Loader2 size={13} className="animate-spin" /> : <DatabaseBackup size={13} />}
            Create backup
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg border border-surface-4 px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void doRestore()}
          >
            {busy === 'restore' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Restore latest
          </button>
        </div>
      </Row>
      {count !== null && (
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-ink-3">
            {count} backup{count === 1 ? '' : 's'} stored
          </span>
          <span className="text-[11.5px] text-ink-3">{msg}</span>
        </div>
      )}
    </>
  )
}

function UpdateButton(): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [text, setText] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setChecking(true)
    const r = await checkForUpdates(true)
    setChecking(false)
    if (r.error) setText(r.error)
    else if (r.updateAvailable) setText(`Update available: ${r.latestVersion}`)
    else setText('Up to date')
  }

  return (
    <button
      className="flex items-center gap-1.5 rounded-lg border border-surface-4 px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent disabled:opacity-50"
      disabled={checking}
      onClick={() => void check()}
    >
      {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      Check for updates
      {text && <span className="ml-1 text-ink-3">{text}</span>}
    </button>
  )
}