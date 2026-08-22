import type { Dirent, Stats } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

/**
 * Parcours borné d'un dépôt local, avant tout déploiement dessus.
 *
 * Le contrat central : rien de ce qui transite par cet instantané n'est un secret. Un
 * `.env` ou un `docker-compose.yml` peut en contenir ; ce module en extrait la forme
 * (des clés, des noms de service, des ports) et jette le reste avant qu'il n'existe
 * ailleurs que sur la ligne qui l'a produit — pas après coup, en aval, sur l'objet
 * assemblé.
 */

/** Ce qui n'est jamais transféré, donc jamais compté ni parcouru. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  "dist",
  "build",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "target",
  ".cache",
  ".pnpm-store",
  "coverage",
  ".svelte-kit",
  ".astro",
])

/**
 * Le vocabulaire fixe des marqueurs. Un fichier hors de cette liste n'apparaît dans
 * aucune réponse : c'est ce qui empêche `inspect_project` de servir à cartographier le
 * disque du développeur si son chemin venait d'un texte lu dans un dépôt.
 */
const MARKERS = new Set([
  "Dockerfile",
  "dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "astro.config.mjs",
  "svelte.config.js",
  "angular.json",
  "remix.config.js",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "poetry.lock",
  "manage.py",
  "composer.json",
  "artisan",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "index.html",
  "Procfile",
  "nixpacks.toml",
  "railway.json",
  "railway.toml",
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "app.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
  "nx.json",
  ".gitignore",
  "alembic.ini",
])

/**
 * `prisma/schema.prisma` et `drizzle.config.ts` se reconnaissent à leur chemin relatif
 * complet : leur nom de base seul (`schema.prisma`, `drizzle.config.ts`) est trop
 * générique pour entrer dans le vocabulaire fixe sans faux positifs ailleurs dans
 * l'arborescence.
 */
const PATH_MARKERS = new Set(["prisma/schema.prisma", "drizzle.config.ts"])

/** Sûrs à lire en entier : ni valeurs d'environnement, ni définitions de services. */
const READABLE = new Set([
  "package.json",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "pyproject.toml",
  "requirements.txt",
  "composer.json",
  "go.mod",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".gitignore",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "astro.config.mjs",
  "fly.toml",
  "vercel.json",
  "netlify.toml",
  "Procfile",
  "nixpacks.toml",
])

const MAX_CONTENT_BYTES = 262_144
const MAX_ENTRIES = 20_000
const MAX_DEPTH = 5

/** Distingue un refus attendu (chemin absent, pas un répertoire) d'un bogue de ce module. */
export class ScanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScanError"
  }
}

export interface ProjectSnapshot {
  /** Racine résolue en absolu. */
  root: string
  /** Chemins relatifs (séparateur "/") des fichiers du vocabulaire de marqueurs. */
  markers: string[]
  /** Contenu des fichiers sûrs uniquement, tronqué. Jamais un .env, jamais un compose. */
  contents: Record<string, string>
  /** Noms de clés lus dans les fichiers .env*. Les valeurs ne sont jamais conservées. */
  envKeys: Record<string, string[]>
  /** Services et ports publiés lus dans les fichiers de composition. Rien d'autre. */
  composeServices: Record<string, { name: string; ports: string[] }[]>
  /** Ports EXPOSE et images de base lus dans les Dockerfile. Rien d'autre. */
  dockerfileHints: Record<string, { expose: number[]; from: string[] }>
  /** Ce qui serait transféré, exclusions appliquées. */
  weight: { files: number; bytes: number; tronque: boolean }
  /** Répertoires exclus rencontrés, pour les avertissements. */
  excluded: string[]
}

interface QueueEntry {
  absolute: string
  relative: string
  depth: number
}

export async function scanProject(root: string): Promise<ProjectSnapshot> {
  const resolvedRoot = resolve(root)

  let rootStat: Stats

  try {
    rootStat = await stat(resolvedRoot)
  } catch {
    throw new ScanError(`« ${resolvedRoot} » n'existe pas.`)
  }

  if (!rootStat.isDirectory()) {
    throw new ScanError(`« ${resolvedRoot} » n'est pas un répertoire.`)
  }

  const snapshot: ProjectSnapshot = {
    root: resolvedRoot,
    markers: [],
    contents: {},
    envKeys: {},
    composeServices: {},
    dockerfileHints: {},
    weight: { files: 0, bytes: 0, tronque: false },
    excluded: [],
  }

  const excludedSeen = new Set<string>()

  // Parcours en largeur : la profondeur maximale se compare simplement au niveau de la
  // file, sans reconstruire de pile d'appels récursive.
  const queue: QueueEntry[] = [{ absolute: resolvedRoot, relative: "", depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()

    if (!current) break

    if (snapshot.weight.files >= MAX_ENTRIES) {
      snapshot.weight.tronque = true
      break
    }

    let entries: Dirent[]

    try {
      entries = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      // Un répertoire devenu illisible entre le readdir parent et celui-ci (permissions,
      // suppression concurrente) ne doit pas faire échouer tout l'instantané.
      continue
    }

    for (const entry of entries) {
      if (snapshot.weight.files >= MAX_ENTRIES) {
        snapshot.weight.tronque = true
        break
      }

      // Les liens symboliques ne sont jamais suivis : une boucle ferait tourner le
      // parcours indéfiniment, et un lien vers "/" sortirait du projet.
      if (entry.isSymbolicLink()) continue

      const entryAbsolute = join(current.absolute, entry.name)
      const entryRelative = current.relative ? `${current.relative}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          if (!excludedSeen.has(entry.name)) {
            excludedSeen.add(entry.name)
            snapshot.excluded.push(entry.name)
          }
          continue
        }

        if (current.depth + 1 > MAX_DEPTH) continue

        queue.push({ absolute: entryAbsolute, relative: entryRelative, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue

      snapshot.weight.files += 1

      let fileStat: Stats

      try {
        fileStat = await stat(entryAbsolute)
      } catch {
        continue
      }

      snapshot.weight.bytes += fileStat.size

      await handleFile(entryAbsolute, entryRelative, snapshot)
    }
  }

  return snapshot
}

async function handleFile(
  absolutePath: string,
  relativePath: string,
  snapshot: ProjectSnapshot
): Promise<void> {
  const base = basename(relativePath)
  const isMarker = MARKERS.has(base) || PATH_MARKERS.has(relativePath)

  if (isMarker) {
    snapshot.markers.push(relativePath)
  }

  if (base.startsWith(".env")) {
    const keys = await extractEnvKeys(absolutePath)
    if (keys) snapshot.envKeys[relativePath] = keys
    return
  }

  const isCompose =
    base === "docker-compose.yml" ||
    base === "docker-compose.yaml" ||
    base === "compose.yml" ||
    base === "compose.yaml"

  if (isCompose) {
    const services = await extractComposeServices(absolutePath)
    if (services) snapshot.composeServices[relativePath] = services
    return
  }

  if (base === "Dockerfile" || base === "dockerfile") {
    const hints = await extractDockerfileHints(absolutePath)
    if (hints) snapshot.dockerfileHints[relativePath] = hints
    return
  }

  if (isMarker && READABLE.has(base)) {
    const content = await readTruncated(absolutePath, snapshot)
    if (content !== undefined) snapshot.contents[relativePath] = content
  }
}

async function readTruncated(
  absolutePath: string,
  snapshot: ProjectSnapshot
): Promise<string | undefined> {
  try {
    const buffer = await readFile(absolutePath)

    if (buffer.byteLength > MAX_CONTENT_BYTES) {
      snapshot.weight.tronque = true
      return buffer.subarray(0, MAX_CONTENT_BYTES).toString("utf8")
    }

    return buffer.toString("utf8")
  } catch {
    return undefined
  }
}

/** Retire un préfixe "export ", ne touche jamais à ce qui suit le premier "=". */
function extractKeyFromEnvLine(line: string): string | undefined {
  const trimmed = line.trim()

  if (!trimmed || trimmed.startsWith("#")) return undefined

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed

  const equalsIndex = withoutExport.indexOf("=")
  if (equalsIndex === -1) return undefined

  const key = withoutExport.slice(0, equalsIndex).trim()

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined

  return key
}

async function extractEnvKeys(absolutePath: string): Promise<string[] | undefined> {
  let raw: string

  try {
    raw = await readFile(absolutePath, "utf8")
  } catch {
    return undefined
  }

  const keys: string[] = []

  for (const line of raw.split("\n")) {
    const key = extractKeyFromEnvLine(line)
    if (key) keys.push(key)
  }

  return keys
}

/**
 * Analyse par indentation, sans dépendance YAML : une bibliothèque tenterait de tout
 * désérialiser, secrets compris, jusque dans l'objet qu'elle rendrait.
 */
async function extractComposeServices(
  absolutePath: string
): Promise<{ name: string; ports: string[] }[] | undefined> {
  let raw: string

  try {
    raw = await readFile(absolutePath, "utf8")
  } catch {
    return undefined
  }

  const lines = raw.split("\n")
  const services: { name: string; ports: string[] }[] = []

  let servicesIndent: number | undefined
  let serviceIndent: number | undefined
  let currentService: { name: string; ports: string[] } | undefined
  let inPorts = false
  let portsIndent: number | undefined

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue

    const indent = rawLine.length - rawLine.trimStart().length
    const content = rawLine.trim()

    if (servicesIndent === undefined) {
      if (content === "services:") {
        servicesIndent = indent
      }
      continue
    }

    // Retour au niveau de "services:" ou moins profond : la section est terminée.
    if (indent <= servicesIndent) {
      break
    }

    // Premier niveau sous "services:" : le nom du service.
    if (serviceIndent === undefined || indent <= serviceIndent) {
      const match = /^([^\s:]+):/.exec(content)
      if (!match) continue

      serviceIndent = indent
      currentService = { name: match[1] ?? "", ports: [] }
      services.push(currentService)
      inPorts = false
      portsIndent = undefined
      continue
    }

    if (!currentService) continue

    // Sous le service courant, seule la clé "ports:" nous intéresse.
    if (content === "ports:") {
      inPorts = true
      portsIndent = indent
      continue
    }

    if (inPorts && portsIndent !== undefined) {
      if (indent <= portsIndent) {
        inPorts = false
        portsIndent = undefined
      } else if (content.startsWith("-")) {
        const value = content.slice(1).trim().replace(/^["']|["']$/g, "")
        currentService.ports.push(value)
        continue
      } else {
        inPorts = false
        portsIndent = undefined
      }
    }
  }

  return services
}

async function extractDockerfileHints(
  absolutePath: string
): Promise<{ expose: number[]; from: string[] } | undefined> {
  let raw: string

  try {
    raw = await readFile(absolutePath, "utf8")
  } catch {
    return undefined
  }

  const expose: number[] = []
  const from: string[] = []

  for (const line of raw.split("\n")) {
    const exposeMatch = /^\s*EXPOSE\s+(\d+)/i.exec(line)
    if (exposeMatch?.[1]) {
      expose.push(Number.parseInt(exposeMatch[1], 10))
      continue
    }

    const fromMatch = /^\s*FROM\s+(\S+)/i.exec(line)
    if (fromMatch?.[1]) {
      from.push(fromMatch[1])
    }
  }

  return { expose, from }
}
