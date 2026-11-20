import { type DragEvent, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import Markdown from "markdown-to-jsx"
import { Bold, Check, ChevronRight, ChevronsLeftRight, ChevronsRightLeft, Cloud, CloudOff, Code, Download, Eye, FileText, Folder, Heading1, Heading2, Heading3, Italic, Link, List, LogOut, Moon, MoreHorizontal, Pencil, Plus, Search, Settings as SettingsIcon, Sun, Trash2, TriangleAlert, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type Status = { passwordless: boolean; authed: boolean; backup: { on: boolean; last: string | null; error: string | null } }
type Note = { content: string; updated: string; by: string }
type Hit = { path: string; matches: { line: number; text: string }[] }
type ConnectedApp = { id: string; name: string; host: string; created: number; used: number }
type TreeNode = { [name: string]: TreeNode | string }
// One dialog serves every confirmation, and every prompt when `input` is set.
type Ask = { title: string; text?: string; action: string; destructive?: boolean; input?: string; run: (value: string) => unknown }
type Ops = {
  current: string
  open: (path: string) => void
  create: (folder: string) => void
  rename: (path: string, folder: boolean) => void
  remove: (path: string, folder: boolean) => void
  drag: { current: string }
  over: string | null
  setOver: (folder: string | null) => void
  move: (from: string, toFolder: string) => void
}

// 44px touch targets on phones, compact on desktop.
const TAP = "h-11 md:h-8"
const TAP_ICON = "size-11 md:size-8"
const ROW = "h-11 md:h-8 group-hover/row:bg-sidebar-accent group-hover/row:text-sidebar-accent-foreground group-has-data-popup-open/row:bg-sidebar-accent"
// Row controls show only on the hovered, focused or open row.
const ACTION =
  "top-1/2! right-0.5 size-9 -translate-y-1/2 hover:bg-foreground/15! data-popup-open:bg-foreground/15! opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-has-data-active/row:opacity-100 group-has-data-popup-open/row:opacity-100 md:size-7"
const widthClass = (full: boolean) => `mx-auto transition-[max-width] duration-300 ease-in-out motion-reduce:transition-none ${full ? "max-w-full" : "max-w-3xl"}`
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/")
const canDrop = (from: string, folder: string) => !!from && from !== folder && parentOf(from) !== folder && !`${folder}/`.startsWith(`${from}/`)

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data as T
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const file = (path: string) => `file?path=${encodeURIComponent(path)}`
const clean = (path: string) => path.trim().replace(/^\/+|\/+$/g, "")
const hashPath = () => {
  try {
    return decodeURIComponent(location.hash.slice(1))
  } catch {
    return ""
  }
}
const asNote = (path: string) => (path.endsWith(".md") ? path : `${path}.md`)

function ago(iso: string | number) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

function toTree(paths: string[]) {
  const root: TreeNode = {}
  for (const path of paths) {
    const parts = path.split("/")
    let node = root
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = path
      else node = (node[part] ??= {}) as TreeNode
    })
  }
  return root
}

const Err = ({ children }: { children: string }) => children && <p role="alert" className="text-sm break-words text-destructive">{children}</p>

function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// Follows the system theme until the other one is picked; picking the system's theme again follows it once more.
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = () => {
    const next = !dark
    if (next === matchMedia("(prefers-color-scheme: dark)").matches) localStorage.removeItem("theme")
    else localStorage.setItem("theme", next ? "dark" : "light")
    document.documentElement.classList.toggle("dark", next)
    setDark(next)
  }
  return (
    <Tip label="Theme">
      <Button className={TAP_ICON} variant="ghost" size="icon" aria-label="Theme" onClick={toggle}>
        {dark ? <Sun /> : <Moon />}
      </Button>
    </Tip>
  )
}

function ItemMenu({ label, onRename, onDelete }: { label: string; onRename: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <Tip label="More">
        <DropdownMenuTrigger render={<SidebarMenuAction className={ACTION} aria-label={`Actions for ${label}`} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem className={TAP} onClick={onRename}>
          <Pencil /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem className={TAP} variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Tree({ node, prefix, ops }: { node: TreeNode; prefix: string; ops: Ops }) {
  const entries = Object.entries(node).sort(([a, x], [b, y]) => Number(typeof x === "string") - Number(typeof y === "string") || a.localeCompare(b))
  const dragSource = (path: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => ((ops.drag.current = path), e.dataTransfer.setData("text/plain", path), (e.dataTransfer.effectAllowed = "move")),
    onDragEnd: () => ((ops.drag.current = ""), ops.setOver(null)),
  })
  return entries.map(([name, value]) => {
    if (typeof value === "string")
      return (
        <SidebarMenuItem key={name}>
          <div className="group/row relative" {...dragSource(value)}>
            <SidebarMenuButton className={`${ROW} pr-10 md:pr-8`} isActive={value === ops.current} onClick={() => ops.open(value)}>
              <FileText />
              <span>{name.replace(/\.md$/, "")}</span>
            </SidebarMenuButton>
            <ItemMenu label={name} onRename={() => ops.rename(value, false)} onDelete={() => ops.remove(value, false)} />
          </div>
        </SidebarMenuItem>
      )
    const folder = prefix + name
    return (
      <SidebarMenuItem key={name} {...dropTarget(folder, ops)} className={ops.over === folder ? "rounded-md bg-sidebar-accent/60 ring-1 ring-sidebar-ring" : ""}>
        <Collapsible defaultOpen>
          <div className="group/row relative" {...dragSource(folder)}>
            <CollapsibleTrigger render={<SidebarMenuButton className={`${ROW} pr-20 md:pr-16 [&[data-panel-open]>svg:first-child]:rotate-90`} />}>
              <ChevronRight className="transition-transform" />
              <Folder />
              <span>{name}</span>
            </CollapsibleTrigger>
            <Tip label="New note">
              <SidebarMenuAction className={`${ACTION} right-10 md:right-8`} aria-label={`New note in ${name}`} onClick={() => ops.create(folder)}>
                <Plus />
              </SidebarMenuAction>
            </Tip>
            <ItemMenu label={name} onRename={() => ops.rename(folder, true)} onDelete={() => ops.remove(folder, true)} />
          </div>
          <CollapsibleContent>
            <SidebarMenuSub className="mr-0 pr-0">
              <Tree node={value} prefix={`${folder}/`} ops={ops} />
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuItem>
    )
  })
}

// Dropping anywhere on a folder, its notes included, moves the dragged item into it.
function dropTarget(folder: string, ops: Ops) {
  return {
    onDragOver: (e: DragEvent) => {
      e.stopPropagation()
      if (!canDrop(ops.drag.current, folder)) return ops.setOver(null)
      e.preventDefault()
      ops.setOver(folder)
    },
    onDrop: (e: DragEvent) => {
      e.stopPropagation()
      e.preventDefault()
      if (canDrop(ops.drag.current, folder)) ops.move(ops.drag.current, folder)
      ops.setOver(null)
    },
  }
}

function Prompt({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [value, setValue] = useState(ask.input ?? "")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await ask.run(value)
      onClose()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="break-words">{ask.title}</DialogTitle>
            {ask.text && <DialogDescription>{ask.text}</DialogDescription>}
          </DialogHeader>
          {ask.input !== undefined && <Input className={TAP} autoFocus aria-label="Path" placeholder="folder/name" value={value} onChange={(e) => setValue(e.target.value)} />}
          <Err>{error}</Err>
          <DialogFooter>
            <Button className={TAP} type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button className={TAP} type="submit" variant={ask.destructive ? "destructive" : "default"} disabled={busy || (ask.input !== undefined && !clean(value))}>{ask.action}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Md({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <Markdown options={{ disableParsingRawHTML: true }}>{children}</Markdown>
    </div>
  )
}

// Edits go through the browser's own editing command so undo and redo keep working.
function edit(el: HTMLTextAreaElement, text: string, start = el.selectionStart, end = el.selectionEnd) {
  el.focus()
  el.setSelectionRange(start, end)
  if (text ? document.execCommand("insertText", false, text) : start === end || document.execCommand("delete")) return
  el.setRangeText(text, start, end, "end")
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

const FORMATS = [
  { label: "Bold", icon: Bold, wrap: ["**", "**"] },
  { label: "Italic", icon: Italic, wrap: ["_", "_"] },
  { label: "List", icon: List, line: "- " },
  { label: "Link", icon: Link, wrap: ["[", "](url)"] },
  { label: "Code", icon: Code, wrap: ["`", "`"] },
] as const

// With preview on, desktop shows the note beside the text and a phone shows it instead of the text.
function Editor({ value, dirty, preview, onChange, onSave, onCancel }: { value: string; dirty: boolean; preview: boolean; onChange: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  const { isMobile } = useSidebar()
  const area = useRef<HTMLTextAreaElement>(null)

  const format = (f: (typeof FORMATS)[number]) => {
    const el = area.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e, value: v } = el
    const lineStart = v.lastIndexOf("\n", s - 1) + 1
    if ("line" in f) return edit(el, f.line, lineStart, lineStart)
    const inner = v.slice(s, e) || "text"
    edit(el, f.wrap[0] + inner + f.wrap[1], s, e)
    el.setSelectionRange(s + f.wrap[0].length, s + f.wrap[0].length + inner.length)
  }
  const heading = (level: number) => {
    const el = area.current
    if (!el) return
    const lineStart = el.value.lastIndexOf("\n", el.selectionStart - 1) + 1
    const old = el.value.slice(lineStart).match(/^#{1,6} +/)?.[0].length ?? 0
    edit(el, `${"#".repeat(level)} `, lineStart, lineStart + old)
  }
  const tool = (label: string, Icon: typeof Bold, run: () => void) => (
    <Tip key={label} label={label}>
      <Button className="h-11 w-auto min-w-0 flex-1 md:size-8 md:flex-none" variant="ghost" size="icon" aria-label={label} disabled={preview && isMobile} onClick={run}>
        <Icon />
      </Button>
    </Tip>
  )
  const onKeys = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === "s") e.preventDefault(), dirty && onSave()
    else if (mod && e.key.toLowerCase() === "b") e.preventDefault(), format(FORMATS[0])
    else if (mod && e.key.toLowerCase() === "i") e.preventDefault(), format(FORMATS[1])
    else if (e.key === "Escape") e.preventDefault(), onCancel()
  }
  const onTyping = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const { selectionStart: s, selectionEnd: end, value: v } = el
    const lineStart = v.lastIndexOf("\n", s - 1) + 1
    if (e.key === "Tab") {
      // Tab indents here; Esc is the keyboard way out of the editor.
      e.preventDefault()
      if (!e.shiftKey) return edit(el, "  ")
      const spaces = v.slice(lineStart).match(/^ {1,2}/)?.[0].length ?? 0
      if (!spaces) return
      edit(el, "", lineStart, lineStart + spaces)
      el.setSelectionRange(Math.max(lineStart, s - spaces), Math.max(lineStart, end - spaces))
    } else if (e.key === "Enter" && !e.shiftKey && s === end && !e.nativeEvent.isComposing) {
      // Enter continues a list; Enter on an empty item ends it.
      const m = v.slice(lineStart, s).match(/^(\s*)([-*+]|(\d+)\.)(\s+)(\[[ xX]\]\s+)?(.*)$/)
      if (!m) return
      e.preventDefault()
      if (!m[6]) edit(el, "", lineStart, s)
      else edit(el, `\n${m[1]}${m[3] ? `${Number(m[3]) + 1}.` : m[2]}${m[4]}${m[5] ? "[ ] " : ""}`)
    }
  }

  return (
    <div className={`${widthClass(preview && !isMobile)} flex h-full flex-col gap-2`} onKeyDown={onKeys}>
      <div className="flex items-center">
        {FORMATS.map((f) => tool(f.label, f.icon, () => format(f)))}
        <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-center" />
        {[Heading1, Heading2, Heading3].map((Icon, i) => tool(`Heading ${i + 1}`, Icon, () => heading(i + 1)))}
      </div>
      <div className={`grid min-h-0 flex-1 gap-2 ${preview ? "md:grid-cols-2" : ""}`}>
        <Textarea ref={area} className={`h-full min-h-0 resize-none font-mono ${preview ? "hidden md:block" : ""}`} aria-label="Note content" autoFocus value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onTyping} />
        {preview && <Md className="min-h-0 overflow-auto rounded-md border p-3">{value}</Md>}
      </div>
      <div className="flex gap-2">
        <Button className={TAP} disabled={!dirty} onClick={onSave}><Check /> Save</Button>
        <Button className={TAP} variant="outline" onClick={onCancel}><X /> Cancel</Button>
      </div>
    </div>
  )
}

function Centered({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  const submit = (e: FormEvent) => (e.preventDefault(), onSubmit())
  return (
    <form onSubmit={submit} className="m-auto flex w-full max-w-sm flex-col gap-3 p-4">
      {children}
    </form>
  )
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const submit = () => api("login", post({ password })).then(onDone, (e) => setError(message(e)))
  return (
    <Centered onSubmit={submit}>
      <h1 className="text-lg font-medium">Memory Vault</h1>
      <Input className={TAP} type="password" autoFocus autoComplete="current-password" aria-label="Password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Err>{error}</Err>
      <Button className={TAP} type="submit">Unlock</Button>
    </Centered>
  )
}

function Consent({ passwordless }: { passwordless: boolean }) {
  const [request] = useState(() => Object.fromEntries(new URLSearchParams(location.search)))
  const [app, setApp] = useState<{ name: string; host: string } | null>(null)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    api<{ name: string; host: string }>(`authorize?client_id=${encodeURIComponent(request.client_id ?? "")}&redirect_uri=${encodeURIComponent(request.redirect_uri ?? "")}`).then(setApp, (e) => setError(message(e)))
  }, [request])
  const answer = (allow: boolean) =>
    api<{ redirect: string }>("authorize", post({ ...request, password, allow })).then((r) => location.assign(r.redirect), (e) => setError(message(e)))
  return (
    <Centered onSubmit={() => answer(true)}>
      {app && (
        <>
          <h1 className="text-lg font-medium break-words">Connect {app.name}?</h1>
          <p className="text-sm text-muted-foreground">
            It can read and change every note. Returns to <span className="font-medium break-all text-foreground">{app.host}</span>
          </p>
          {!passwordless && <Input className={TAP} type="password" autoFocus autoComplete="current-password" aria-label="Vault password" placeholder="Vault password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </>
      )}
      <Err>{error}</Err>
      {app && (
        <div className="flex gap-2">
          <Button className={`${TAP} flex-1`} type="submit"><Check /> Allow</Button>
          <Button className={`${TAP} flex-1`} type="button" variant="outline" onClick={() => answer(false)}><X /> Deny</Button>
        </div>
      )}
    </Centered>
  )
}

function Settings({ status, onImported, onLogout, onClose }: { status: Status; onImported: () => void; onLogout: () => void; onClose: () => void }) {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [apps, setApps] = useState<ConnectedApp[] | null>(null)
  const [error, setError] = useState("")
  const upload = useRef<HTMLInputElement>(null)
  const load = useCallback(() => api<ConnectedApp[]>("apps").then(setApps, (e) => setError(message(e))), [])
  useEffect(() => void load(), [load])
  const revoke = (app: ConnectedApp) =>
    setAsk({ title: `Revoke ${app.name}?`, text: "It loses access until it is connected again.", action: "Revoke", destructive: true, run: () => api(`apps?id=${encodeURIComponent(app.id)}`, { method: "DELETE" }).then(load) })
  const importZip = (zip: File | undefined) =>
    zip &&
    setAsk({
      title: `Import ${zip.name}?`,
      text: "Notes with the same path are overwritten. Nothing is deleted.",
      action: "Import",
      run: () => api("import", { method: "POST", headers: { "content-type": "application/zip" }, body: zip }).then(onImported),
    })
  const { backup } = status
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-6">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Connect your AI tools and keep your notes safe.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm font-medium">
          MCP URL
          <Input className={`${TAP} font-normal`} readOnly value={`${location.origin}/mcp`} onFocus={(e) => e.target.select()} />
        </label>
        <Separator />
        <div className="grid gap-2 text-sm">
          <span className="font-medium">Backup</span>
          <p className={`break-words ${backup.error ? "text-destructive" : "text-muted-foreground"}`} role={backup.error ? "alert" : undefined}>
            {!backup.on ? "Off. Set BACKUP_REPO and BACKUP_TOKEN." : backup.error ? backup.error : backup.last ? `Last pushed ${ago(backup.last)}` : "Pending"}
          </p>
        </div>
        <Separator />
        <div className="grid gap-2 text-sm">
          <span className="font-medium">Data</span>
          <div className="flex gap-2">
            <Button className={`${TAP} flex-1`} variant="outline" onClick={() => location.assign("/api/export")}><Download /> Export</Button>
            <Button className={`${TAP} flex-1`} variant="outline" onClick={() => upload.current?.click()}><Upload /> Import</Button>
            <input ref={upload} type="file" accept=".zip,application/zip" hidden onChange={(e) => (importZip(e.target.files?.[0]), (e.target.value = ""))} />
          </div>
        </div>
        <Separator />
        <div className="grid gap-2 text-sm">
          <span className="font-medium">Connected apps</span>
          <Err>{error}</Err>
          {apps?.length === 0 && <p className="text-muted-foreground">None</p>}
          <ul className="max-h-56 overflow-auto">
            {apps?.map((app) => (
              <li key={app.id} className="flex items-center gap-3 border-b py-3 first:pt-0 last:border-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{app.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{app.host} · used {app.used ? ago(app.used) : "never"}</div>
                </div>
                <Button className={TAP} variant="outline" onClick={() => revoke(app)}><X /> Revoke</Button>
              </li>
            ))}
          </ul>
        </div>
        {!status.passwordless && (
          <DialogFooter>
            <Button className={TAP} variant="outline" onClick={onLogout}><LogOut /> Log out</Button>
          </DialogFooter>
        )}
        {/* Nested here so that answering it does not dismiss Settings. */}
        {ask && <Prompt ask={ask} onClose={() => setAsk(null)} />}
      </DialogContent>
    </Dialog>
  )
}

function Welcome({ className, onNew, onSettings, onBrowse }: { className: string; onNew: () => void; onSettings: () => void; onBrowse?: () => void }) {
  return (
    <div className={`${className} grid gap-4 py-4 text-sm`}>
      <h1 className="text-2xl font-semibold">Memory Vault</h1>
      <p className="text-muted-foreground">One memory for all your AI tools.</p>
      <ol className="grid list-decimal gap-2 pl-5">
        <li>
          Add this URL to your AI tool as an MCP server or connector, then press Allow:
          <Input className={`${TAP} mt-1 font-mono`} readOnly aria-label="MCP URL" value={`${location.origin}/mcp`} onFocus={(e) => e.target.select()} />
        </li>
        <li>Your AI saves and recalls notes here. You can browse, search and edit them.</li>
        <li>Keep a copy. Export from Settings, or turn on Git backup.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        {onBrowse && <Button className={TAP} variant="outline" onClick={onBrowse}><Folder /> Browse notes</Button>}
        <Button className={TAP} variant="outline" onClick={onNew}><Plus /> New note</Button>
        <Button className={TAP} variant="outline" onClick={onSettings}><SettingsIcon /> Settings</Button>
      </div>
    </div>
  )
}

function Vault({ status, refresh, banner }: { status: Status; refresh: () => void; banner: ReactNode }) {
  const { isMobile, setOpenMobile } = useSidebar()
  const [files, setFiles] = useState<string[]>([])
  const [path, setPath] = useState(hashPath)
  const [note, setNote] = useState<Note | null>(null)
  const [draft, setDraft] = useState<string | null>(null) // non-null while editing
  const [preview, setPreview] = useState(() => matchMedia("(min-width: 768px)").matches) // off by default on phones
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<Hit[] | null>(null) // null until results for the current search arrive
  const wanted = useRef(path) // answers for any other note are dropped
  const [error, setError] = useState("")
  const [settings, setSettings] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [wide, setWide] = useState(() => localStorage.getItem("wide") === "1")
  const toggleWide = () => (localStorage.setItem("wide", wide ? "0" : "1"), setWide(!wide))
  const width = widthClass(wide)
  const drag = useRef("")
  const dirty = draft !== null && draft !== note?.content

  const fail = (e: unknown) => setError(message(e))
  const loadFiles = useCallback(() => api<string[]>("files").then(setFiles, fail), [])
  // The view switches only once the note has arrived, and all at once, so navigating never flashes.
  const loadNote = useCallback((p: string) => {
    wanted.current = p
    const show = (n: Note | null, e?: unknown) => {
      if (wanted.current !== p) return
      setNote(n)
      setDraft(n?.content === "" ? "" : null) // an empty note opens in the editor
      setQuery("")
      setHits(null)
      setError(e ? message(e) : "")
    }
    if (!p) return show(null)
    return api<Note>(file(p)).then(show, (e) => show(null, e))
  }, [])

  useEffect(() => void loadFiles(), [loadFiles])
  useEffect(() => void loadNote(path), [path, loadNote])
  useEffect(() => {
    const onHash = () => setPath(hashPath())
    addEventListener("hashchange", onHash)
    return () => removeEventListener("hashchange", onHash)
  }, [])
  useEffect(() => {
    if (!query.trim()) return setHits(null)
    let current = true
    const t = setTimeout(() => api<Hit[]>(`search?q=${encodeURIComponent(query)}`).then((h) => current && setHits(h), fail), 200)
    return () => ((current = false), clearTimeout(t))
  }, [query])

  const changed = () => (loadFiles(), refresh())
  const go = (p: string) => {
    setOpenMobile(false)
    if (p === path) loadNote(p)
    else location.hash = p
  }
  // Runs `then` straight away, or after a confirmation when there are unsaved edits.
  const discard = (then: () => void) => (dirty ? setAsk({ title: "Discard unsaved changes?", text: "Your edits to this note will be lost.", action: "Discard", destructive: true, run: then }) : then())
  const open = (p: string) => discard(() => go(p))
  const save = () => api(file(path), { method: "PUT", body: draft ?? "" }).then(() => (changed(), loadNote(path)), fail)
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener("beforeunload", warn)
    return () => removeEventListener("beforeunload", warn)
  }, [dirty])
  const create = (folder: string) =>
    setAsk({
      title: "New note",
      text: "Use slashes to put it in a folder. Folders are created as needed.",
      input: folder ? `${folder}/` : "",
      action: "Create",
      run: async (value) => {
        const p = asNote(clean(value))
        if (!files.includes(p)) await api(file(p), { method: "PUT", body: "" })
        changed()
        go(p)
      },
    })
  const moveTo = async (from: string, to: string) => {
    if (to === from) return
    await api("move", post({ from, to }))
    changed()
    // Follow the open note if it, or a folder above it, moved.
    if (path === from) go(to)
    else if (path.startsWith(`${from}/`)) go(to + path.slice(from.length))
  }
  const move = (from: string, toFolder: string) => moveTo(from, [toFolder, from.split("/").pop()].filter(Boolean).join("/")).catch(fail)
  const rename = (from: string, folder: boolean) =>
    setAsk({ title: "Rename", text: folder ? "Everything inside moves with the folder." : "Change the path to move the note to another folder.", input: from, action: "Save", run: (value) => moveTo(from, folder ? clean(value) : asNote(clean(value))) })
  const remove = (target: string, folder: boolean) =>
    setAsk({
      title: `Delete ${target}?`,
      text: [folder ? "Every note in this folder is deleted." : "The note is removed from the vault.", status.backup.on && "It will remain in your backup repo's Git history."].filter(Boolean).join(" "),
      action: "Delete",
      destructive: true,
      run: async () => {
        await api(file(target), { method: "DELETE" })
        changed()
        if (path === target || path.startsWith(`${target}/`)) go("")
      },
    })
  const logout = () => api("logout", { method: "POST" }).then(refresh, fail)

  const ops: Ops = { current: path, open, create, rename, remove, drag, over, setOver, move }
  const { backup } = status
  const BackupIcon = !backup.on ? CloudOff : backup.error ? TriangleAlert : Cloud
  const backupLabel = !backup.on ? "backup: off" : backup.error ? "backup: failed" : backup.last ? `backup: ${ago(backup.last)}` : "backup: pending"

  return (
    <>
      <Sidebar>
        <SidebarHeader className="flex-row items-center justify-between">
          <a href="#" className="px-2 py-1 font-medium" onClick={(e) => (e.preventDefault(), open(""))}>Memory Vault</a>
          <ThemeToggle />
        </SidebarHeader>
        <SidebarContent {...dropTarget("", ops)} className={over === "" ? "bg-sidebar-accent/40" : ""}>
          <SidebarGroup>
            <SidebarGroupLabel>Notes</SidebarGroupLabel>
            <Tip label="New note">
              <SidebarGroupAction aria-label="New note" onClick={() => create("")}>
                <Plus />
              </SidebarGroupAction>
            </Tip>
            <SidebarGroupContent>
              <SidebarMenu>
                <Tree node={toTree(files)} prefix="" ops={ops} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="h-dvh min-w-0">
        {banner}
        <header className="flex items-center gap-2 border-b p-2">
          <Tip label="Notes">
            <SidebarTrigger className={TAP_ICON} aria-label="Notes" />
          </Tip>
          <div className="relative min-w-0 flex-1 md:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className={`${TAP} pl-8`} type="search" aria-label="Search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="hidden flex-1 md:block" />
          <Tip label="New note">
            <Button className={TAP_ICON} variant="ghost" size="icon" aria-label="New note" onClick={() => create("")}>
              <Plus />
            </Button>
          </Tip>
          {draft !== null ? (
            <Tip label="Preview">
              <Toggle className={TAP_ICON} aria-label="Preview" pressed={preview} onPressedChange={setPreview}>
                <Eye />
              </Toggle>
            </Tip>
          ) : (
            <Tip label="Width">
              <Toggle className="hidden size-8 md:inline-flex" aria-label="Width" pressed={wide} onPressedChange={toggleWide}>
                {wide ? <ChevronsRightLeft /> : <ChevronsLeftRight />}
              </Toggle>
            </Tip>
          )}
          <Tip label="Settings">
            <Button className={TAP_ICON} variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettings(true)}>
              <SettingsIcon />
            </Button>
          </Tip>
        </header>

        <div className="flex items-center justify-between gap-4 border-b px-4 py-1 text-xs text-muted-foreground">
          <span className="truncate">{hits ? `${hits.length} results` : path}{!hits && dirty && " · unsaved"}</span>
          <Tip label="Backup">
            <button className={`flex shrink-0 items-center gap-1 ${backup.error ? "text-destructive" : ""}`} onClick={() => setSettings(true)}>
              <BackupIcon className="size-3.5" /> {backupLabel}
            </button>
          </Tip>
        </div>
        {error && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{error}</p>}

        <main className="min-h-0 flex-1 overflow-auto p-4">
          {hits ? (
            <ul className={`${width} text-sm`}>
              {hits.map((hit) => (
                <li key={hit.path}>
                  <button className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted" onClick={() => open(hit.path)}>
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium break-all">{hit.path}</span>
                      {hit.matches.map((m) => (
                        <span key={m.line} className="block truncate text-muted-foreground">{m.text}</span>
                      ))}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ) : !note ? (
            !path && <Welcome className={width} onNew={() => create("")} onSettings={() => setSettings(true)} onBrowse={isMobile ? () => setOpenMobile(true) : undefined} />
          ) : draft !== null ? (
            <Editor value={draft} dirty={dirty} preview={preview} onChange={setDraft} onSave={save} onCancel={() => discard(() => setDraft(null))} />
          ) : (
            <article className={width}>
              <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{note.updated && `${ago(note.updated)} · ${note.by}`}</span>
                <Button className={TAP} variant="outline" onClick={() => setDraft(note.content)}><Pencil /> Edit</Button>
                <Button className={TAP} variant="outline" onClick={() => remove(path, false)}><Trash2 /> Delete</Button>
              </div>
              <Md>{note.content}</Md>
            </article>
          )}
        </main>
      </SidebarInset>

      {settings && <Settings status={status} onImported={() => (changed(), loadNote(path))} onLogout={logout} onClose={() => setSettings(false)} />}
      {ask && <Prompt ask={ask} onClose={() => setAsk(null)} />}
    </>
  )
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState("")
  const refresh = useCallback(() => api<Status>("status").then(setStatus, (e) => setError(message(e))), [])
  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 15_000) // the backup status changes a few seconds after each edit
    return () => clearInterval(t)
  }, [refresh])

  if (!status) return error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : null
  const banner = status.passwordless && (
    <div role="alert" className="flex items-center justify-center gap-2 bg-red-700 px-3 py-1.5 text-xs font-medium text-white sm:px-4 sm:py-2 sm:text-sm">
      <TriangleAlert className="hidden size-4 shrink-0 sm:block" />
      <span className="sm:hidden">No password. Anyone with the URL has full access.</span>
      <span className="hidden sm:inline">No password set. Anyone with this URL can read and change this vault. Set VAULT_PASSWORD.</span>
    </div>
  )
  if (location.pathname !== "/authorize" && status.authed)
    return (
      <SidebarProvider>
        <Vault status={status} refresh={refresh} banner={banner} />
      </SidebarProvider>
    )
  return (
    <div className="flex h-dvh flex-col">
      {banner}
      {location.pathname === "/authorize" ? <Consent passwordless={status.passwordless} /> : <Login onDone={refresh} />}
    </div>
  )
}
