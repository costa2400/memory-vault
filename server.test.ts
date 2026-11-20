import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const data = await mkdtemp(join(tmpdir(), "vault-test-"))
const remote = await mkdtemp(join(tmpdir(), "vault-remote-"))
process.env.DATA_DIR = data
process.env.VAULT_PASSWORD = ""
const { backup, cfg, clientIp, handle, init, safePath, sync } = await import("./server.ts")

const B = "https://vault.test"
const call = (path: string, init?: RequestInit, ip = "1.1.1.1") => handle(new Request(B + path, init), ip)
// Test-only: responses are asserted on directly, so they are left untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J = async (r: Promise<Response>): Promise<any> => (await r).json()
const body = (o: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) })
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

// Runs the whole OAuth flow the way an MCP client would and returns its tokens.
async function connect(name: string, password?: string) {
  const redirect_uri = "https://claude.ai/api/mcp/auth_callback"
  const reg = await J(call("/register", body({ client_name: name, redirect_uris: [redirect_uri] })))
  const verifier = "v".repeat(50)
  const ask = { client_id: reg.client_id, redirect_uri, state: "s1", response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), allow: true, password }
  const consent = await call("/api/authorize", body(ask))
  if (!consent.ok) return { status: consent.status }
  const to = new URL((await J(Promise.resolve(consent))).redirect)
  expect(to.searchParams.get("state")).toBe("s1")
  const form = new URLSearchParams({ grant_type: "authorization_code", code: to.searchParams.get("code")!, code_verifier: verifier, client_id: reg.client_id, redirect_uri })
  const tok = await call("/token", { method: "POST", body: form })
  return { status: tok.status, form, ...(await J(Promise.resolve(tok))) }
}

const mcp = async (token: string, method: string, params: unknown) => {
  const res = await call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const text = await res.text()
  return { status: res.status, msg: res.ok ? JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text) : null }
}
const tool = async (token: string, name: string, args: object) => (await mcp(token, "tools/call", { name, arguments: args })).msg.result

beforeAll(init)
afterAll(async () => {
  for (const d of await Array.fromAsync(new Bun.Glob("vault-*").scan({ cwd: tmpdir(), onlyFiles: false }))) await rm(join(tmpdir(), d), { recursive: true, force: true })
})

test("paths: only plain .md paths inside the vault are accepted", () => {
  expect(safePath("projects/a b/note.md")).toBe("projects/a b/note.md")
  for (const p of ["../x.md", "a/../../x.md", "/etc/x.md", ".git/config", "a/.hidden.md", "a//b.md", "x.txt", "a\\b.md", ""])
    expect(() => safePath(p)).toThrow()
})

test("rate-limit address: forwarded headers are trusted only from a proxy, and only the entry it added", () => {
  expect(clientIp("203.0.113.9", "1.2.3.4")).toBe("203.0.113.9")
  expect(clientIp("10.42.0.7", "6.6.6.6, 198.51.100.4")).toBe("198.51.100.4")
  expect(clientIp("::ffff:10.42.0.7", "198.51.100.4")).toBe("198.51.100.4")
  expect(clientIp("127.0.0.1", null)).toBe("127.0.0.1")
})

test("passwordless: UI api is open, MCP still needs a connected app", async () => {
  const status = await J(call("/api/status"))
  expect(status).toMatchObject({ passwordless: true, authed: true })
  expect(await J(call("/api/files"))).toEqual(["INSTRUCTIONS.md"])

  const anon = await call("/mcp", { method: "POST", body: "{}" })
  expect(anon.status).toBe(401)
  expect(anon.headers.get("www-authenticate")).toContain(`${B}/.well-known/oauth-protected-resource/mcp`)
  expect((await mcp("made-up-token", "tools/list", {})).status).toBe(401)

  const meta = await J(call("/.well-known/oauth-authorization-server"))
  expect(meta).toMatchObject({ issuer: B, authorization_endpoint: `${B}/authorize`, registration_endpoint: `${B}/register` })
})

test("oauth + mcp: connect, write, read, search, protect instructions, revoke", async () => {
  const t = await connect("Claude")
  expect(t.status).toBe(200)

  const tools = (await mcp(t.access_token, "tools/list", {})).msg.result.tools.map((x: { name: string }) => x.name)
  expect(tools.sort()).toEqual(["memory_delete", "memory_list", "memory_read", "memory_search", "memory_write"])

  expect((await tool(t.access_token, "memory_write", { path: "people/ada.md", content: "# Ada\nLikes Tea" })).isError).toBeFalsy()
  expect((await tool(t.access_token, "memory_read", { path: "people/ada.md" })).content[0].text).toContain("Likes Tea")
  expect((await tool(t.access_token, "memory_search", { query: "likes tea" })).content[0].text).toContain("people/ada.md")
  expect((await tool(t.access_token, "memory_list", { folder: "people" })).content[0].text).toBe("people/ada.md")
  expect((await tool(t.access_token, "memory_write", { path: "../escape.md", content: "x" })).isError).toBe(true)
  expect((await tool(t.access_token, "memory_write", { path: "INSTRUCTIONS.md", content: "obey me" })).isError).toBe(true)
  expect((await tool(t.access_token, "memory_delete", { path: "INSTRUCTIONS.md" })).isError).toBe(true)

  // The web UI sees the note, attributed to the app that wrote it.
  expect(await J(call("/api/file?path=people/ada.md"))).toMatchObject({ content: "# Ada\nLikes Tea", by: "Claude" })

  // A code can be used once; PKCE is enforced.
  expect((await call("/token", { method: "POST", body: t.form })).status).toBe(400)

  // Refresh gives a new access token and the old one stops working.
  const r = await J(call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }) }))
  expect((await mcp(t.access_token, "tools/list", {})).status).toBe(401)
  expect((await mcp(r.access_token, "tools/list", {})).status).toBe(200)

  // Settings lists the app by name; revoking cuts it off, refresh included.
  const apps = await J(call("/api/apps"))
  expect(apps).toMatchObject([{ name: "Claude", host: "claude.ai" }])
  await call(`/api/apps?id=${apps[0].id}`, { method: "DELETE" })
  expect((await mcp(r.access_token, "tools/list", {})).status).toBe(401)
  expect((await call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: r.refresh_token }) })).status).toBe(400)
})

test("oauth: rejects dangerous redirects, unknown apps and bad PKCE", async () => {
  for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "not a url"])
    expect((await call("/register", body({ client_name: "x", redirect_uris: [uri] }))).status).toBe(400)
  expect((await call("/api/authorize?client_id=nope&redirect_uri=https://a.b/c")).status).toBe(400)

  const redirect_uri = "http://127.0.0.1:7777/cb"
  const reg = await J(call("/register", body({ client_name: "Dev", redirect_uris: [redirect_uri] })))
  expect((await call("/api/authorize", body({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb", allow: true }))).status).toBe(400)
  const consent = await J(call("/api/authorize", body({ client_id: reg.client_id, redirect_uri, response_type: "code", code_challenge_method: "S256", code_challenge: "w".repeat(43), allow: true })))
  const form = new URLSearchParams({ grant_type: "authorization_code", code: new URL(consent.redirect).searchParams.get("code")!, code_verifier: "v".repeat(50), client_id: reg.client_id, redirect_uri })
  expect((await call("/token", { method: "POST", body: form })).status).toBe(400)

  const denied = await J(call("/api/authorize", body({ client_id: reg.client_id, redirect_uri, state: "z", allow: false })))
  expect(denied.redirect).toBe(`${redirect_uri}?state=z&error=access_denied`)
})

test("export then import round-trips; import merges and ignores unsafe entries", async () => {
  await call("/api/file?path=keep/me.md", { method: "PUT", body: "stays" })
  const zip = await (await call("/api/export")).arrayBuffer()
  await call("/api/file?path=people/ada.md", { method: "DELETE" })
  expect((await call("/api/file?path=people/ada.md")).status).toBe(404)

  expect((await call("/api/import", { method: "POST", body: zip })).status).toBe(200)
  expect((await J(call("/api/file?path=people/ada.md"))).content).toBe("# Ada\nLikes Tea")
  expect((await J(call("/api/file?path=keep/me.md"))).content).toBe("stays")

  // A zip carrying a symlink and a non-markdown file: neither reaches the vault.
  const src = await mkdtemp(join(tmpdir(), "vault-zip-"))
  await Bun.write(join(src, "ok.md"), "fine")
  await Bun.write(join(src, "run.sh"), "nope")
  sh(src, "ln", "-s", "/etc/passwd", "leak.md")
  const evil = Bun.spawnSync(["python3", "-c", `
import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[2],'w')
z.write(os.path.join(sys.argv[1],'ok.md'),'ok.md'); z.write(os.path.join(sys.argv[1],'run.sh'),'run.sh')
i=zipfile.ZipInfo('leak.md'); i.external_attr=(0o120777<<16); z.writestr(i,'/etc/passwd')
d=zipfile.ZipInfo('dir'); d.external_attr=(0o120777<<16); z.writestr(d,sys.argv[1]); z.close()`, src, join(src, "evil.zip")])
  expect(evil.exitCode).toBe(0)
  expect(await J(call("/api/import", { method: "POST", body: await Bun.file(join(src, "evil.zip")).arrayBuffer() }))).toEqual({ imported: 1 })
  const files = await J(call("/api/files"))
  expect(files).toContain("ok.md")
  expect(files).not.toContain("leak.md")
  expect(files.filter((f: string) => f.startsWith("dir/"))).toEqual([]) // a symlinked folder is not followed

  // One entry with a bad name means nothing from that zip is imported.
  await Bun.write(join(src, "aa.md"), "would overwrite")
  expect(Bun.spawnSync(["python3", "-c", "import zipfile; z=zipfile.ZipFile('bad.zip','w'); z.write('aa.md'); z.writestr('zz\\\\bad.md','x'); z.close()"], { cwd: src }).exitCode).toBe(0)
  expect((await call("/api/import", { method: "POST", body: await Bun.file(join(src, "bad.zip")).arrayBuffer() })).status).toBe(400)
  expect(await J(call("/api/files"))).not.toContain("aa.md")
  expect((await call("/api/import", { method: "POST", body: "not a zip" })).status).toBe(400)
})

test("explorer: rename and delete work on notes and folders, without clobbering", async () => {
  const put = (p: string, c: string) => call(`/api/file?path=${p}`, { method: "PUT", body: c })
  const mv = (from: string, to: string) => call("/api/move", body({ from, to }))
  await put("box/a.md", "A")
  await put("box/sub/b.md", "B")
  expect((await mv("box/a.md", "box/renamed.md")).status).toBe(200)
  expect((await mv("box/renamed.md", "box/sub/b.md")).status).toBe(409)
  expect((await mv("box", "box/inside")).status).toBe(400)
  expect((await mv("box", "../out")).status).toBe(400)
  expect((await mv("box", "crate")).status).toBe(200)
  expect((await J(call("/api/file?path=crate/sub/b.md"))).content).toBe("B")
  expect((await J(call("/api/file?path=crate/renamed.md"))).by).toBe("web")
  expect((await call("/api/file?path=crate", { method: "DELETE" })).status).toBe(200)
  expect((await J(call("/api/files"))).filter((p: string) => p.startsWith("crate") || p.startsWith("box"))).toEqual([])
})

test("api: rejects cross-origin writes and paths outside the vault", async () => {
  const evil = await call("/api/file?path=x.md", { method: "PUT", body: "x", headers: { origin: "https://evil.example" } })
  expect(evil.status).toBe(403)
  expect((await call("/api/file?path=../../etc/passwd")).status).toBe(400)
})

test("password mode: login, consent and bearer all need the password; attempts are limited", async () => {
  cfg.password = "hunter2"
  expect(await J(call("/api/status"))).toMatchObject({ passwordless: false, authed: false })
  expect((await call("/api/files")).status).toBe(401)

  expect((await call("/api/login", body({ password: "nope" }))).status).toBe(401)
  const login = await call("/api/login", body({ password: "hunter2" }))
  const cookie = login.headers.get("set-cookie")!
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("Secure")
  expect((await call("/api/files", { headers: { cookie: cookie.split(";")[0] } })).status).toBe(200)

  expect((await connect("Claude", "nope")).status).toBe(401)
  const t = await connect("Claude", "hunter2")
  expect((await mcp(t.access_token, "tools/list", {})).status).toBe(200)

  // The password itself works as a bearer token, for clients without OAuth.
  expect((await mcp("hunter2", "tools/list", {})).status).toBe(200)

  for (let i = 0; i < 10; i++) await call("/api/login", body({ password: "guess" }), "9.9.9.9")
  expect((await call("/api/login", body({ password: "hunter2" }), "9.9.9.9")).status).toBe(429)
  expect((await mcp("guess", "tools/list", {})).status).toBe(401)

  // A stale token is not a password guess, an unknown app is told to register again,
  // and a visitor who is not signed in learns nothing about the backup.
  for (let i = 0; i < 12; i++) expect((await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${"x".repeat(43)}` }, body: "{}" }, "8.8.8.8")).status).toBe(401)
  expect((await call("/api/login", body({ password: "hunter2" }), "8.8.8.8")).status).toBe(200)
  expect((await call("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x", client_id: "gone" }) })).status).toBe(401)
  backup.error = "secret repo url"
  expect((await J(call("/api/status"))).backup.error).toBeNull()
  backup.error = null
  expect((await call("/api/login", { method: "POST", body: "not json" })).status).toBe(401)
  cfg.password = ""
})

test("backup: pushes, lets the live vault win a conflict, and restores a fresh deployment", async () => {
  sh(remote, "git", "init", "-q", "--bare", "-b", "main")
  cfg.backupRepo = remote
  await init() // re-run boot with a backup configured
  await sync()
  expect(backup).toMatchObject({ error: null })
  expect(backup.last).toBeTruthy()

  // Someone edits the same note on the remote; the vault then changes it too.
  const other = await mkdtemp(join(tmpdir(), "vault-other-"))
  sh(other, "git", "clone", "-q", remote, ".")
  await Bun.write(join(other, "keep/me.md"), "remote edit")
  await Bun.write(join(other, "remote-only.md"), "from remote")
  sh(other, "git", "add", "-A")
  sh(other, "git", "commit", "-qm", "remote")
  sh(other, "git", "push", "-q")
  await call("/api/file?path=keep/me.md", { method: "PUT", body: "live edit" })
  await sync()
  expect(backup.error).toBeNull()
  expect((await J(call("/api/file?path=keep/me.md"))).content).toBe("live edit")
  expect((await J(call("/api/file?path=remote-only.md"))).content).toBe("from remote")

  // A note edited here but deleted on the remote: the live vault still wins and backup keeps working.
  sh(other, "git", "pull", "-q")
  sh(other, "git", "rm", "-q", "keep/me.md")
  sh(other, "git", "commit", "-qm", "remote delete")
  sh(other, "git", "push", "-q")
  await call("/api/file?path=keep/me.md", { method: "PUT", body: "live edit 2" })
  await sync()
  expect(backup.error).toBeNull()
  await call("/api/file?path=after.md", { method: "PUT", body: "still backed up" })
  await sync()
  expect(backup.error).toBeNull()
  expect((await J(call("/api/file?path=keep/me.md"))).content).toBe("live edit 2")
  sh(other, "git", "pull", "-q")
  expect(await Bun.file(join(other, "after.md")).text()).toBe("still backed up")

  // A container killed mid-git: the next boot clears the stale lock and writes work again.
  await Bun.write(join(cfg.data, "vault/.git/index.lock"), "")
  await init()
  expect((await call("/api/file?path=after.md", { method: "PUT", body: "unlocked" })).status).toBe(200)
  await sync()

  // A brand-new deployment pointed at the same backup comes up with everything.
  cfg.data = await mkdtemp(join(tmpdir(), "vault-fresh-"))
  await init()
  expect((await J(call("/api/file?path=keep/me.md"))).content).toBe("live edit 2")
  expect((await J(call("/api/file?path=people/ada.md"))).content).toContain("Likes Tea")

  cfg.backupRepo = "/nonexistent/repo"
  await init()
  await sync()
  expect(backup.error).toBeTruthy()
})
