import * as yaml from 'https://deno.land/std@0.75.0/encoding/yaml.ts'
import * as fs from 'https://deno.land/std@0.75.0/fs/mod.ts'
import * as path from 'https://deno.land/std@0.75.0/path/mod.ts'
import { pipe } from 'https://deno.land/x/compose@1.3.2/index.js'
import shellEscape from 'https://deno.land/x/shell_escape@1.0.0/single-argument.ts'

interface Payload {
  readonly crate: Crate
  readonly versions: readonly Version[]
}

export interface Crate {
  readonly max_stable_version: string
  readonly description: string | null
  readonly homepage: string | null
  readonly repository: string | null
  readonly documentation: string | null
}

export interface Version {
  readonly num: string
  readonly license: string
}

class Package {
  #content?: Payload

  constructor(
    public readonly crate: string,
    public readonly binaries: readonly string[],
  ) {}

  public indexUrl(): string {
    return `https://crates.io/api/v1/crates/${this.crate}`
  }

  public async load(): Promise<Payload> {
    if (this.#content) {
      return this.#content
    }

    const response = await fetch(this.indexUrl())
    if (!response.ok) {
      throw new Error(
        `Failed to load index text of crate ${this.crate}: HTTP ${response.status} ${response.statusText}`,
      )
    }

    const content = JSON.parse(await response.text())
    this.#content = content
    return content
  }

  public async latestVersion(): Promise<string> {
    return (await this.load()).crate.max_stable_version
  }

  public async license(): Promise<string[]> {
    const latestVersion = await this.latestVersion()
    const payload = await this.load()
    const licenseString = payload.versions.find(x => x.num === latestVersion)?.license

    if (!licenseString) return []

    function detectSingleLicense(license: string) {
      switch (license) {
        case 'MIT':
        case 'Apache':
        case 'Apache-1.0':
        case 'Apache-2.0':
        case 'ISC':
        case 'MPL':
        case 'MPL-1.0':
        case 'MPL-1.1':
        case 'MPL-2.0':
        case 'GPL':
        case 'GPL-2.0':
        case 'GPL-3.0':
          return license
        default:
          return false
      }
    }

    function detectMultipleLicense(licenses: readonly string[]) {
      const detected = []
      for (const candidate of licenses) {
        const singleLicense = detectSingleLicense(candidate)
        if (!singleLicense) return false
        detected.push(singleLicense)
      }
      return detected
    }

    // 'MIT OR Apache-2.0' → ('MIT' 'Apache-2.0')
    const licenseChoices = detectMultipleLicense(licenseString.split(/\s+or\s+/i))
    if (licenseChoices) return licenseChoices

    // 'MIT/Apache-2.0' → ('MIT' 'Apache-2.0')
    const dualLicense = detectMultipleLicense(licenseString.split('/'))
    if (dualLicense) return dualLicense

    // 'MIT AND Apache-2.0' → ('custom:MIT AND Apache-2.0')
    // 'proprietary' → ('custom:proprietary')
    const singleLicense = detectSingleLicense(licenseString)
    return singleLicense ? [singleLicense] : [`custom:${licenseString}`]
  }

  public async latestInfo() {
    const { crate } = await this.load()
    const { description, homepage, repository, documentation } = crate
    return {
      description,
      homepage,
      repository,
      documentation,
      url: homepage || repository || documentation || '',
      version: await this.latestVersion(),
      license: await this.license(),
    } as const
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
      await pkg.load()
      return pkg
    }),
  x => Promise.all(x),
)

async function createBuildDirectory(pkg: Package) {
  const { description, url, license, version } = await pkg.latestInfo()
  const content = Deno.readTextFileSync(path.join(__dirname, 'template', 'PKGBUILD'))
    .replaceAll('CRATE', shellEscape(pkg.crate))
    .replaceAll('VERSION', shellEscape(version))
    .replaceAll('BINARIES', pkg.binaries.map(shellEscape).join(' '))
    .replaceAll('DESCRIPTION', shellEscape(description || ''))
    .replaceAll('URL', shellEscape(url))
    .replaceAll('LICENSE', license.map(shellEscape).join(' '))
  const buildDirectory = path.join(__dirname, 'build', pkg.crate)
  if (!fs.existsSync(buildDirectory)) {
    Deno.mkdirSync(buildDirectory)
  }
  Deno.writeTextFileSync(path.join(buildDirectory, 'PKGBUILD'), content)
}

for (const pkg of packages) {
  const latestVersion = await pkg.latestVersion()
  console.info('📦', pkg.crate, latestVersion)
  createBuildDirectory(pkg)
}
