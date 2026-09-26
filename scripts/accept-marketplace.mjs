import { build } from 'esbuild'
import { createHash } from 'crypto'
import { createServer } from 'http'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { crc32 } from 'zlib'
import { create as createTar } from 'tar'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC = join(ROOT, 'src', 'main')
const PLUGIN_GIT_MISSING = join(tmpdir(), 'flex-accept-no-such-git-binary')

let passed = 0
let failed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push({ name, detail })
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(name, a === b, `expected ${b}, got ${a}`)
}

async function expectCode(name, fn, code) {
  try {
    const result = await fn()
    failed += 1
    failures.push({ name, detail: `expected ${code}, resolved ${JSON.stringify(result)}` })
    console.log(`  FAIL  ${name} — expected ${code}, resolved`)
    return undefined
  } catch (error) {
    const actual = error && typeof error === 'object' ? error.code : undefined
    if (actual === code) {
      passed += 1
      console.log(`  PASS  ${name}`)
      return error
    }
    failed += 1
    failures.push({ name, detail: `expected ${code}, got ${actual ?? error}` })
    console.log(`  FAIL  ${name} — expected ${code}, got ${actual ?? String(error)}`)
    return error
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writePlugin(root, name, version, extra = {}) {
  writeJson(join(root, 'plugin.json'), {
    name,
    version,
    description: `${name} accept fixture`,
    ...extra
  })
  mkdirSync(join(root, 'commands'), { recursive: true })
  writeFileSync(
    join(root, 'commands', 'hello.md'),
    `# hello\n\nFixture command for ${name}.\n`,
    'utf8'
  )
}

function buildStoredZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const nameEncoder = new TextEncoder()
  for (const entry of entries) {
    const nameBytes = nameEncoder.encode(entry.name)
    const data = entry.data ?? new Uint8Array(0)
    const crc = (crc32(data) >>> 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(data.byteLength, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(entry.externalAttributes ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)
    offset += 30 + nameBytes.byteLength + data.byteLength
  }
  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralBuffer, eocd])
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

class MockRegistry {
  constructor() {
    this.map = new Map()
  }
  list() {
    return [...this.map.values()]
  }
  get(id) {
    return this.map.get(id)
  }
  require(id) {
    const rec = this.map.get(id)
    if (!rec) throw new Error(`missing ${id}`)
    return rec
  }
  add(rec) {
    if (this.map.has(rec.id)) throw new Error(`duplicate ${rec.id}`)
    this.map.set(rec.id, rec)
  }
  remove(id) {
    this.map.delete(id)
  }
}

async function bundleMarketplace() {
  const work = mkdtempSync(join(tmpdir(), 'flex-accept-mkt-'))
  const entry = join(work, 'entry.mjs')
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(join(SRC, 'pluginMarketplace.ts'))}`,
      `export * from ${JSON.stringify(join(SRC, 'marketplaceTemplate.ts'))}`,
      ''
    ].join('\n'),
    'utf8'
  )
  const outfile = join(work, 'marketplace.bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)
  return { mod, work }
}

function createService(mod, storageRoot, options = {}) {
  const registry = options.registry ?? new MockRegistry()
  const events = []
  const counters = { notify: 0, reload: 0 }
  const service = new mod.MarketplaceService({
    registry,
    storageRoot,
    notify: () => {
      counters.notify += 1
    },
    reloadKernel: async () => {
      counters.reload += 1
    },
    onProgress: (event) => {
      events.push(event)
      if (options.onProgress) options.onProgress(event)
    }
  })
  return { service, registry, events, counters }
}

async function main() {
  console.log('accept-marketplace: start')
  const { mod } = await bundleMarketplace()
  const fixtures = mkdtempSync(join(tmpdir(), 'flex-accept-fix-'))
  const storageRoot = mkdtempSync(join(tmpdir(), 'flex-accept-store-'))

  const pluginDir = join(fixtures, 'plugin-local')
  writePlugin(pluginDir, 'local-demo', '1.0.0')

  const pluginDirV2 = join(fixtures, 'plugin-local-v2')
  writePlugin(pluginDirV2, 'local-demo', '2.0.0')

  const noManifestDir = join(fixtures, 'no-manifest')
  mkdirSync(noManifestDir, { recursive: true })
  writeFileSync(join(noManifestDir, 'readme.txt'), 'not a plugin\n', 'utf8')

  {
    const s = createService(mod, storageRoot)
    const summary = await s.service.installFromMarketplace({
      source: { kind: 'path', path: pluginDir }
    })
    eq('path install id', summary.id, 'local-demo@marketplace')
    eq('path install version', summary.version, '1.0.0')
    eq('path install source kind', summary.source.kind, 'marketplace')
    eq('path install source label', summary.source.label, 'Marketplace')
    const rec = s.registry.get('local-demo@marketplace')
    ok('path install registry record', Boolean(rec && rec.rootPath))
    ok(
      'path install findManifestPath',
      Boolean(rec && existsSync(join(rec.rootPath, 'plugin.json'))),
      rec && rec.rootPath
    )
    ok('path install notified', s.counters.notify >= 1)
    ok('path install reloaded kernel', s.counters.reload >= 1)
    ok(
      'path install progress done',
      s.events.some((e) => e.phase === 'done' && e.pluginId === 'local-demo@marketplace')
    )

    await expectCode(
      'duplicate install rejects',
      () => s.service.installFromMarketplace({ source: { kind: 'path', path: pluginDir } }),
      'PLUGIN_ALREADY_INSTALLED'
    )

    const overwritten = await s.service.installFromMarketplace({
      source: { kind: 'path', path: pluginDirV2 },
      overwrite: true
    })
    eq('overwrite bumps version', overwritten.version, '2.0.0')

    await expectCode(
      'missing path rejects',
      () =>
        s.service.installFromMarketplace({
          source: { kind: 'path', path: join(fixtures, 'does-not-exist') }
        }),
      'PLUGIN_PATH_INVALID'
    )

    await expectCode(
      'path without manifest rejects',
      () =>
        s.service.installFromMarketplace({
          source: { kind: 'path', path: noManifestDir }
        }),
      'PLUGIN_MANIFEST_INVALID'
    )
  }

  {
    const zipBytes = buildStoredZip([
      { name: 'zip-plugin/plugin.json', data: Buffer.from(JSON.stringify({ name: 'zip-demo', version: '1.2.3' })) },
      { name: 'zip-plugin/commands/ping.md', data: Buffer.from('# ping\n') }
    ])
    const zipPath = join(fixtures, 'zip-demo.zip')
    writeFileSync(zipPath, zipBytes)
    const s = createService(mod, storageRoot)
    const summary = await s.service.installFromMarketplace({
      source: { kind: 'path', path: zipPath }
    })
    eq('local zip install id', summary.id, 'zip-demo@marketplace')
    eq('local zip install version', summary.version, '1.2.3')

    const evilZip = buildStoredZip([
      { name: '../evil.txt', data: Buffer.from('escape') }
    ])
    const evilPath = join(fixtures, 'evil.zip')
    writeFileSync(evilPath, evilZip)
    await expectCode(
      'zip path traversal rejects',
      () => s.service.installFromMarketplace({ source: { kind: 'path', path: evilPath } }),
      'PLUGIN_DOWNLOAD_FAILED'
    )

    const encryptedZip = buildStoredZip([
      {
        name: 'enc/plugin.json',
        data: Buffer.from('{"name":"enc","version":"1.0.0"}'),
        flags: 1
      }
    ])
    const encryptedPath = join(fixtures, 'encrypted.zip')
    writeFileSync(encryptedPath, encryptedZip)
    await expectCode(
      'encrypted zip rejects',
      () => s.service.installFromMarketplace({ source: { kind: 'path', path: encryptedPath } }),
      'PLUGIN_DOWNLOAD_FAILED'
    )

    const symlinkMode = (0o120000 | 0o777) << 16
    const symlinkZip = buildStoredZip([
      {
        name: 'link/plugin.json',
        data: Buffer.from('/tmp/target'),
        externalAttributes: symlinkMode >>> 0
      }
    ])
    const symlinkPath = join(fixtures, 'symlink.zip')
    writeFileSync(symlinkPath, symlinkZip)
    await expectCode(
      'symlink zip rejects',
      () => s.service.installFromMarketplace({ source: { kind: 'path', path: symlinkPath } }),
      'PLUGIN_DOWNLOAD_FAILED'
    )
  }

  {
    const httpPlugin = join(fixtures, 'http-plugin')
    writePlugin(httpPlugin, 'http-demo', '3.0.0')
    const httpZipBytes = buildStoredZip([
      { name: 'http-demo/plugin.json', data: readFileSync(join(httpPlugin, 'plugin.json')) },
      { name: 'http-demo/commands/hello.md', data: readFileSync(join(httpPlugin, 'commands', 'hello.md')) }
    ])
    const httpZipSha = sha256Hex(httpZipBytes)
    const server = createServer((req, res) => {
      const pathOnly = (req.url ?? '').split('?')[0]
      if (pathOnly === '/redirect.zip') {
        res.writeHead(302, { Location: '/plugin.zip' })
        res.end()
        return
      }
      if (pathOnly === '/plugin.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip' })
        res.end(httpZipBytes)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const port = server.address().port
    const s = createService(mod, storageRoot)
    try {
      const url = `http://127.0.0.1:${port}/redirect.zip?sha256=${httpZipSha}`
      const summary = await s.service.installFromMarketplace({ source: { kind: 'url', url } })
      eq('http zip redirect install id', summary.id, 'http-demo@marketplace')
      eq('http zip redirect install version', summary.version, '3.0.0')

      const badSha = 'a'.repeat(64)
      await expectCode(
        'http zip sha256 mismatch rejects',
        () =>
          s.service.installFromMarketplace({
            source: {
              kind: 'url',
              url: `http://127.0.0.1:${port}/plugin.zip?sha256=${badSha}`
            }
          }),
        'PLUGIN_DOWNLOAD_FAILED'
      )

      await expectCode(
        'http zip 404 rejects',
        () =>
          s.service.installFromMarketplace({
            source: { kind: 'url', url: `http://127.0.0.1:${port}/missing.zip` }
          }),
        'PLUGIN_DOWNLOAD_FAILED'
      )
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }

  {
    // npm/npx source (issue 24): a local registry server hands out a real tgz
    // built from a plugin fixture, so resolve → download → verify → extract →
    // atomic activation all run against realistic bytes.
    const npmPlugin = join(fixtures, 'npm-demo')
    writePlugin(npmPlugin, 'npm-demo', '2.5.0')
    const pkgStage = join(fixtures, 'npm-stage', 'package')
    mkdirSync(join(pkgStage, 'commands'), { recursive: true })
    writeJson(join(pkgStage, 'plugin.json'), {
      name: 'npm-demo',
      version: '2.5.0',
      description: 'npm source accept fixture'
    })
    writeFileSync(join(pkgStage, 'commands', 'hello.md'), '# hello\n', 'utf8')
    const tgzPath = join(fixtures, 'npm-demo-2.5.0.tgz')
    await createTar({ cwd: join(fixtures, 'npm-stage'), file: tgzPath, gzip: true, portable: true }, [
      'package'
    ])
    const tgzBytes = readFileSync(tgzPath)
    const npmIntegrity = `sha512-${createHash('sha512').update(tgzBytes).digest('base64')}`
    const badIntegrity = `sha512-${createHash('sha512').update(Buffer.from('not-the-tarball')).digest('base64')}`

    let npmPort = 0
    const npmServer = createServer((req, res) => {
      const pathOnly = (req.url ?? '').split('?')[0]
      if (pathOnly === '/npm-demo') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            'dist-tags': { latest: '2.5.0' },
            versions: {
              '2.5.0': {
                dist: {
                  tarball: `http://127.0.0.1:${npmPort}/npm-demo-2.5.0.tgz`,
                  integrity: npmIntegrity
                }
              },
              '9.9.9': {
                dist: {
                  tarball: `http://127.0.0.1:${npmPort}/npm-demo-2.5.0.tgz`,
                  integrity: badIntegrity
                }
              }
            }
          })
        )
        return
      }
      if (pathOnly === '/npm-demo-2.5.0.tgz') {
        res.writeHead(200, { 'Content-Type': 'application/x-tar' })
        res.end(tgzBytes)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolveListen) => npmServer.listen(0, '127.0.0.1', resolveListen))
    npmPort = npmServer.address().port
    const previousRegistry = process.env.FLEXAGENT_NPM_REGISTRY
    process.env.FLEXAGENT_NPM_REGISTRY = `http://127.0.0.1:${npmPort}`

    const npmMktRoot = join(fixtures, 'npm-marketplace')
    writeJson(join(npmMktRoot, '.flex-plugin', 'marketplace.json'), {
      name: 'npmmkt',
      plugins: [
        { name: 'npm-demo', source: { source: 'npm', package: 'npm-demo' } },
        { name: 'npm-demo-pinned', source: { source: 'npx', package: 'npm-demo@2.5.0' } },
        { name: 'npm-demo-bad', source: { source: 'npm', package: 'npm-demo', version: '9.9.9' } },
        { name: 'npm-missing', source: { source: 'npm', package: 'no-such-pkg-here' } }
      ],
      raw: {}
    })

    const s2 = createService(mod, storageRoot)
    try {
      await s2.service.addMarketplace({ source: npmMktRoot })
      const summary = await s2.service.installFromMarketplace({
        source: { kind: 'entry', marketplace: 'npmmkt', name: 'npm-demo' }
      })
      eq('npm install id', summary.id, 'npm-demo@npmmkt')
      eq('npm install version', summary.version, '2.5.0')
      ok(
        'npm install registry record',
        Boolean(s2.registry.get('npm-demo@npmmkt')?.rootPath)
      )

      const pinned = await s2.service.installFromMarketplace({
        source: { kind: 'entry', marketplace: 'npmmkt', name: 'npm-demo-pinned' },
        overwrite: true
      })
      eq('npx alias install id', pinned.id, 'npm-demo-pinned@npmmkt')

      await expectCode(
        'npm integrity mismatch rejects',
        () =>
          s2.service.installFromMarketplace({
            source: { kind: 'entry', marketplace: 'npmmkt', name: 'npm-demo-bad' }
          }),
        'PLUGIN_DOWNLOAD_FAILED'
      )
      await expectCode(
        'npm package 404 rejects',
        () =>
          s2.service.installFromMarketplace({
            source: { kind: 'entry', marketplace: 'npmmkt', name: 'npm-missing' }
          }),
        'PLUGIN_NOT_FOUND'
      )
    } finally {
      if (previousRegistry === undefined) delete process.env.FLEXAGENT_NPM_REGISTRY
      else process.env.FLEXAGENT_NPM_REGISTRY = previousRegistry
      await new Promise((resolveClose) => npmServer.close(resolveClose))
    }
  }

  {
    eq(
      'parse github https url',
      await mod.parseMarketplaceSourceInput('https://github.com/acme/widgets'),
      { source: 'git', url: 'https://github.com/acme/widgets.git' }
    )
    eq(
      'parse github url with ref',
      await mod.parseMarketplaceSourceInput('https://github.com/acme/widgets#v1.2.3'),
      { source: 'git', url: 'https://github.com/acme/widgets.git', ref: 'v1.2.3' }
    )
    eq(
      'parse github shorthand with ref',
      await mod.parseMarketplaceSourceInput('acme/widgets#main'),
      { source: 'github', repo: 'acme/widgets', ref: 'main' }
    )
    eq(
      'parse non-github http as url source',
      await mod.parseMarketplaceSourceInput('https://cdn.example.com/marketplace.json'),
      { source: 'url', url: 'https://cdn.example.com/marketplace.json' }
    )
    await expectCode('empty source rejects', () => mod.parseMarketplaceSourceInput('   '), 'PLUGIN_SOURCE_INVALID')
    await expectCode(
      'npm source rejects',
      () => mod.parseMarketplaceSourceInput('npm:some-package'),
      'PLUGIN_SOURCE_INVALID'
    )
  }

  {
    const mktRoot = join(fixtures, 'accept-mkt')
    writePlugin(join(mktRoot, 'plugins', 'alpha'), 'alpha', '1.0.0')
    writePlugin(join(mktRoot, 'plugins', 'beta'), 'beta', '1.0.0')
    writePlugin(join(mktRoot, 'plugins', 'cycle-a'), 'cycle-a', '1.0.0')
    writePlugin(join(mktRoot, 'plugins', 'cycle-b'), 'cycle-b', '1.0.0')
    writeJson(join(mktRoot, '.flex-plugin', 'marketplace.json'), {
      name: 'acceptmkt',
      description: 'accept marketplace fixture',
      plugins: [
        { name: 'alpha', source: './plugins/alpha', version: '1.0.0', description: 'alpha fixture', tags: ['fixture'] },
        { name: 'beta', source: './plugins/beta', version: '1.0.0', dependencies: ['alpha'] },
        { name: 'cycle-a', source: './plugins/cycle-a', version: '1.0.0', dependencies: ['cycle-b'] },
        { name: 'cycle-b', source: './plugins/cycle-b', version: '1.0.0', dependencies: ['cycle-a'] }
      ]
    })

    const otherRoot = join(fixtures, 'other-mkt')
    writePlugin(join(otherRoot, 'plugins', 'remote'), 'remote', '1.0.0')
    writeJson(join(otherRoot, 'marketplace.json'), {
      name: 'othermkt',
      plugins: [{ name: 'remote', source: './plugins/remote', version: '1.0.0' }]
    })

    const mktStorage = join(fixtures, 'store-mkt')
    mkdirSync(mktStorage, { recursive: true })
    const s = createService(mod, mktStorage)

    const info = await s.service.addMarketplace({ source: mktRoot })
    eq('add marketplace id', info.id, 'acceptmkt')
    eq('add marketplace pluginCount', info.pluginCount, 4)

    const otherInfo = await s.service.addMarketplace({ source: otherRoot })
    eq('add second marketplace id', otherInfo.id, 'othermkt')

    const listed = s.service.list()
    eq('list marketplaces count', listed.length, 2)
    ok(
      'list marketplaces ids',
      listed.some((m) => m.id === 'acceptmkt') && listed.some((m) => m.id === 'othermkt')
    )

    const all = s.service.search({})
    ok('search empty query lists entries', all.some((r) => r.name === 'alpha' && r.marketplace === 'acceptmkt'))

    const filtered = s.service.search({ query: 'alp' })
    ok('search query filters', filtered.length >= 1 && filtered.every((r) => r.name.includes('alp') || (r.description ?? '').toLowerCase().includes('alp')))

    const restricted = s.service.search({ marketplace: 'othermkt' })
    ok('search marketplace filter', restricted.every((r) => r.marketplace === 'othermkt'))

    const betaSummary = await s.service.installFromMarketplace({
      source: { kind: 'entry', marketplace: 'acceptmkt', name: 'beta' }
    })
    eq('entry install id', betaSummary.id, 'beta@acceptmkt')
    ok('dependency alpha installed', Boolean(s.registry.get('alpha@acceptmkt')))
    ok('entry install source label', betaSummary.source.label === 'acceptmkt')

    const searchAfter = s.service.search({ query: 'beta' })
    const betaRow = searchAfter.find((r) => r.name === 'beta')
    ok('search marks installed', Boolean(betaRow && betaRow.installed))

    await expectCode(
      'dependency cycle rejects',
      () =>
        s.service.installFromMarketplace({
          source: { kind: 'entry', marketplace: 'acceptmkt', name: 'cycle-a' }
        }),
      'PLUGIN_SOURCE_INVALID'
    )
    ok(
      'cycle rollback left no cycle-a record',
      !s.registry.get('cycle-a@acceptmkt') && !s.registry.get('cycle-b@acceptmkt')
    )

    await expectCode(
      'cross-marketplace dependency blocked',
      async () => {
        const crossStorage = join(fixtures, 'store-cross')
        mkdirSync(crossStorage, { recursive: true })
        const cs = createService(mod, crossStorage)
        await cs.service.addMarketplace({ source: mktRoot })
        await cs.service.addMarketplace({ source: otherRoot })
        const mktManifestPath = join(crossStorage, 'marketplaces', 'acceptmkt', 'marketplace.json')
        const manifest = JSON.parse(readFileSync(mktManifestPath, 'utf8'))
        manifest.plugins.push({
          name: 'needs-remote',
          source: './plugins/alpha',
          version: '1.0.0',
          dependencies: ['remote@othermkt']
        })
        writeFileSync(mktManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        return cs.service.installFromMarketplace({
          source: { kind: 'entry', marketplace: 'acceptmkt', name: 'needs-remote' }
        })
      },
      'PLUGIN_SOURCE_INVALID'
    )

    await expectCode(
      'unknown entry rejects',
      () =>
        s.service.installFromMarketplace({
          source: { kind: 'entry', marketplace: 'acceptmkt', name: 'nope' }
        }),
      'PLUGIN_NOT_FOUND'
    )

    await expectCode(
      'unknown marketplace entry rejects',
      () =>
        s.service.installFromMarketplace({
          source: { kind: 'entry', marketplace: 'ghostmkt', name: 'alpha' }
        }),
      'PLUGIN_NOT_FOUND'
    )

    await expectCode(
      'invalid add source rejects',
      () => s.service.addMarketplace({ source: '' }),
      'PLUGIN_SOURCE_INVALID'
    )
  }

  {
    const context = {
      dataPath: '/tmp/flex-data',
      env: { FLEX_API_TOKEN: 'secret-token', MY_TOKEN: 'literal' },
      rootPath: '/opt/flex-plugin',
      options: { endpoint: 'https://api.example.com' },
      userConfig: {
        endpoint: { default: 'https://default.example.com' },
        apiKey: { default: 'fallback-key', sensitive: true }
      },
      workingDirectory: '/work/project'
    }

    eq(
      'template resolves user_config default',
      mod.resolveTemplate(
        '${user_config.endpoint}/v1',
        { ...context, options: {} },
        { allowSensitive: false }
      ),
      'https://default.example.com/v1'
    )
    eq(
      'template resolves configured option',
      mod.resolveTemplate('${user_config.endpoint}', { ...context, options: { endpoint: 'https://configured.example.com' } }, { allowSensitive: false }),
      'https://configured.example.com'
    )
    eq(
      'template resolves plugin roots',
      mod.resolveTemplate('${FLEX_PLUGIN_ROOT}/bin ${FLEX_PLUGIN_DATA}', context, { allowSensitive: false }),
      '/opt/flex-plugin/bin /tmp/flex-data'
    )
    eq(
      'template resolves FLEX env',
      mod.resolveTemplate('Bearer ${FLEX_API_TOKEN}', context, { allowSensitive: false }),
      'Bearer secret-token'
    )
    eq(
      'unknown template variable stays literal',
      mod.resolveTemplate('keep ${MY_TOKEN} as-is', context, { allowSensitive: false }),
      'keep ${MY_TOKEN} as-is'
    )
    try {
      mod.resolveTemplate('${user_config.apiKey}', context, { allowSensitive: false })
      ok('sensitive without allowSensitive throws', false)
    } catch (error) {
      ok('sensitive without allowSensitive throws', error instanceof mod.PluginVariableError)
    }
    eq(
      'sensitive allowed when permitted',
      mod.resolveTemplate('${user_config.apiKey}', context, { allowSensitive: true }),
      'fallback-key'
    )
    eq(
      'user config defaults helper',
      mod.getUserConfigDefaults(context.userConfig),
      { endpoint: 'https://default.example.com', apiKey: 'fallback-key' }
    )
  }

  {
    const prevGit = process.env.PLUGIN_GIT_BINARY
    process.env.PLUGIN_GIT_BINARY = PLUGIN_GIT_MISSING
    try {
      const gitStorage = join(fixtures, 'store-git')
      mkdirSync(gitStorage, { recursive: true })
      const s = createService(mod, gitStorage)
      await expectCode(
        'git unavailable reports PLUGIN_SOURCE_INVALID',
        () => s.service.addMarketplace({ source: 'https://example.com/acme/repo.git' }),
        'PLUGIN_SOURCE_INVALID'
      )
    } finally {
      if (prevGit === undefined) delete process.env.PLUGIN_GIT_BINARY
      else process.env.PLUGIN_GIT_BINARY = prevGit
    }
  }

  if (process.env.FLEX_ACCEPT_NETWORK === '1') {
    console.log('  network cases enabled (FLEX_ACCEPT_NETWORK=1)')
    const netStorage = join(fixtures, 'store-net')
    mkdirSync(netStorage, { recursive: true })
    const s = createService(mod, netStorage)
    try {
      const info = await s.service.addMarketplace({ source: 'https://github.com/zai-org/ZCode' })
      ok('network github marketplace add', Boolean(info && info.id))
      passed += 1
    } catch (error) {
      ok('network github marketplace add', false, String(error))
    }
  } else {
    console.log('  network cases skipped (set FLEX_ACCEPT_NETWORK=1 to enable)')
  }

  try {
    rmSync(fixtures, { recursive: true, force: true })
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
  }

  const total = passed + failed
  if (failed > 0) {
    console.error(`accept-marketplace: FAIL (${failed} failed / ${total})`)
    for (const item of failures) {
      console.error(`  - ${item.name}: ${item.detail ?? ''}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`accept-marketplace: PASS (${passed}/${total})`)
}

main().catch((error) => {
  console.error('accept-marketplace: FAIL (unhandled)')
  console.error(error)
  process.exitCode = 1
})
