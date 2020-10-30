import * as path from 'https://deno.land/std@0.75.0/path/mod.ts'
import * as fs from 'https://deno.land/std@0.75.0/fs/mod.ts'
import * as yaml from 'https://deno.land/std@0.75.0/encoding/yaml.ts'
import * as semver from 'https://deno.land/x/semver@v1.0.0/mod.ts'
import { pipe } from 'https://deno.land/x/compose@1.3.2/index.js'

async function execute(...cmd: string[]) {
  const { success, code, signal } = await Deno.run({
    cmd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).status()

  if (!success) {
    console.info(`::error::Status Code: ${code}; Signal: ${signal}`)
    Deno.exit(code)
  }
}

interface PackageIndexItem {
  readonly vers: string
}

class Package {
  #indexTextContent?: string

  constructor(
    public readonly crate: string,
    public readonly binaries: readonly string[],
  ) {}

  public indexPath(): readonly string[] {
    const { crate } = this
    switch (crate.length) {
      case 0:
        throw new Error('Crate name cannot be empty')
      case 1:
        return ['1', crate]
      case 2:
        return ['2', crate]
      case 3:
        return ['3', crate[0], crate]
      default:
        return [crate.slice(0, 2), crate.slice(2, 4), crate]
    }
  }

  public indexUrl(): string {
    const path = this.indexPath().join('/')
    return `https://github.com/rust-lang/crates.io-index/raw/master/${path}`
  }

  public async loadIndexText(): Promise<string> {
    if (typeof this.#indexTextContent === 'string') {
      return this.#indexTextContent
    }

    const response = await fetch(this.indexUrl())
    if (!response.ok) {
      throw new Error(
        `Failed to load index text of crate ${this.crate}: HTTP ${response.status} ${response.statusText}`,
      )
    }

    const content = await response.text()
    this.#indexTextContent = content
    return content
  }

  public async *loadIndexJson(): AsyncGenerator<PackageIndexItem> {
    const text = await this.loadIndexText()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      yield JSON.parse(line)
    }
  }

  public async *loadVersions(): AsyncGenerator<semver.SemVer> {
    for await (const item of this.loadIndexJson()) {
      yield semver.parse(item.vers)!
    }
  }

  public async latestVersion(): Promise<string> {
    let latest: string = '0.0.0'
    for await (const current of this.loadIndexJson()) {
      const cmp = semver.compare(latest, current.vers)
      if (cmp === -1 || cmp === 0) {
        latest = current.vers
      }
    }
    return latest
  }
}

type PackageDict = Record<string, readonly string[] | null>

function* iteratePackageDict(packageDict: PackageDict): Generator<Package> {
  for (const [key, value] of Object.entries(packageDict)) {
    if (value === null) {
      yield new Package(key, [key])
      continue
    }
    if (Array.isArray(value)) {
      yield new Package(key, value)
      continue
    }
    throw new Error(`Unexpected type of value: ${Deno.inspect(value)}`)
  }
}

const __dirname = pipe(
  import.meta.url,
  path.fromFileUrl,
  path.dirname,
)

const packages = await pipe(
  path.join(__dirname, 'packages.yaml'),
  Deno.readTextFileSync,
  yaml.parse,
  dict => dict as PackageDict,
  iteratePackageDict,
  iter => [...iter],
  pkgs =>
    pkgs.map(async pkg => {
      await pkg.loadIndexText()
      return pkg
    }),
  x => Promise.all(x),
)

async function createBuildDirectory(pkg: Package, version: string) {
  const content = Deno.readTextFileSync(path.join(__dirname, 'template', 'PKGBUILD'))
    .replaceAll('CRATE', pkg.crate)
    .replaceAll('VERSION', version)
    .replaceAll('BINARIES', pkg.binaries.join(' '))
  const buildDirectory = path.join(__dirname, 'build', pkg.crate)
  if (!fs.existsSync(buildDirectory)) {
    Deno.mkdirSync(buildDirectory)
  }
  Deno.writeTextFileSync(path.join(buildDirectory, 'PKGBUILD'), content)
}

for (const pkg of packages) {
  const latestVersion = await pkg.latestVersion()
  console.info('📦', pkg.crate, latestVersion)
  createBuildDirectory(pkg, latestVersion)
}
