import type { ProjectSnapshot } from "./project-scan.js"

/**
 * Déduction du runtime, du framework, du port et de la base de données d'un dépôt, à
 * partir de son instantané.
 *
 * Le principe directeur (spec §5.3) : ce que le dépôt déclare de lui-même — Dockerfile,
 * fichier de composition — l'emporte sur toute déduction. Le développeur a exprimé un
 * choix ; le proposer à nouveau serait ignorer ce qu'il a écrit. Le reste (runtime,
 * framework, port par défaut) n'est qu'une hypothèse, à confirmer avant tout
 * déploiement, jamais une certitude — d'où le refus explicite dès que l'indice manque
 * plutôt qu'un choix par défaut qui se révélerait faux en production.
 */

export type RuntimeFamily = "node" | "python" | "php" | "go" | "static" | "inconnu"
export type OutputMode = "server" | "standalone" | "static" | "inconnu"

export interface ProjectFacts {
  root: string
  /** Ce que le dépôt déclare de lui-même. Prime sur toute déduction. */
  declared: {
    dockerfiles: string[]
    composeFiles: string[]
    services: { name: string; ports: string[] }[]
  }
  runtime: {
    family: RuntimeFamily
    /** Les fichiers qui ont conduit à cette conclusion. Rendus à l'agent. */
    evidence: string[]
    version: string | null
    packageManager: "pnpm" | "npm" | "yarn" | "bun" | null
  }
  framework: string | null
  output: { mode: OutputMode; directory: string | null }
  port: { value: number | null; source: string }
  env: { keys: string[]; files: string[]; hasLocalSecrets: boolean }
  data: { engines: string[]; migrations: string | null }
  weight: ProjectSnapshot["weight"]
  /** Ce qui bloquerait un déploiement, ou mérite d'être dit avant. */
  warnings: string[]
  /** Vrai quand plusieurs paquets coexistent : l'agent doit demander lequel déployer. */
  monorepo: { detected: boolean; packages: string[] }
}

/** Un défaut par framework — jamais 80, jamais deviné en l'absence d'indice (§7). */
const FRAMEWORK_DEFAULT_PORT: Record<string, { value: number; source: string }> = {
  next: { value: 3000, source: "port par défaut de Next.js" },
  nuxt: { value: 3000, source: "port par défaut de Nuxt" },
  vite: { value: 4173, source: "port par défaut de Vite" },
  nestjs: { value: 3000, source: "port par défaut de NestJS" },
  django: { value: 8000, source: "port par défaut de Django" },
  fastapi: { value: 8000, source: "port par défaut d'Uvicorn" },
}

/** Marqueurs racine (pas de "/") qui font conclure à chaque famille, dans l'ordre §5.3. */
const PYTHON_MARKERS = ["requirements.txt", "pyproject.toml", "manage.py"]
const PHP_MARKERS = ["composer.json", "artisan"]

/** Dépendances Node qui font conclure au framework, une seule réponse, premier trouvé. */
const NODE_FRAMEWORKS: [dependency: string, framework: string][] = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["astro", "astro"],
  ["@nestjs/core", "nestjs"],
  ["express", "express"],
  ["vite", "vite"],
]

/** Mêmes règles côté Python, lues dans requirements.txt plutôt que dans des dépendances structurées. */
const PYTHON_FRAMEWORKS = ["fastapi", "django", "flask"]

/** Fichiers qui, présents à un niveau imbriqué, signalent un paquet distinct de la racine. */
const PACKAGE_INDICATORS = new Set([
  "package.json",
  "requirements.txt",
  "composer.json",
  "go.mod",
  "pyproject.toml",
])

export function analyzeProject(snapshot: ProjectSnapshot): ProjectFacts {
  const warnings: string[] = []

  const declared = declareFrom(snapshot)
  const pkg = parsePackageJson(snapshot, warnings)

  const runtime = detectRuntime(snapshot, pkg, warnings)
  const framework = detectFramework(pkg, snapshot.contents["requirements.txt"])
  const output = detectOutput(snapshot, pkg, runtime.family)
  const port = detectPort(snapshot, declared.dockerfiles, framework, runtime.family, output.mode)
  const data = detectData(pkg, snapshot)
  const env = detectEnv(snapshot, warnings)
  const monorepo = detectMonorepo(snapshot.markers, warnings)

  checkWeight(snapshot.weight, warnings)

  return {
    root: snapshot.root,
    declared,
    runtime,
    framework,
    output,
    port,
    env,
    data,
    weight: snapshot.weight,
    warnings,
    monorepo,
  }
}

function declareFrom(snapshot: ProjectSnapshot): ProjectFacts["declared"] {
  return {
    dockerfiles: Object.keys(snapshot.dockerfileHints),
    composeFiles: Object.keys(snapshot.composeServices),
    services: Object.values(snapshot.composeServices).flat(),
  }
}

/**
 * Un `package.json` cassé ne doit pas faire échouer toute l'analyse : c'est souvent
 * précisément l'objet de la réparation que l'agent est en train de faire. On dégrade en
 * avertissement, et tout ce qui dépend du contenu (framework, version, sortie) se
 * contente d'une absence d'indice plutôt que de propager une exception.
 */
function parsePackageJson(
  snapshot: ProjectSnapshot,
  warnings: string[]
): Record<string, unknown> | undefined {
  const raw = snapshot.contents["package.json"]
  if (raw === undefined) return undefined

  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    warnings.push(
      "« package.json » n'a pas pu être lu (JSON invalide) : les dépendances qu'il déclare sont ignorées."
    )
    return undefined
  }
}

function detectRuntime(
  snapshot: ProjectSnapshot,
  pkg: Record<string, unknown> | undefined,
  warnings: string[]
): ProjectFacts["runtime"] {
  const { markers } = snapshot

  if (markers.includes("package.json")) {
    return {
      family: "node",
      evidence: ["package.json"],
      version: nodeVersion(snapshot, pkg),
      packageManager: packageManagerFrom(markers),
    }
  }

  const pythonEvidence = PYTHON_MARKERS.filter((marker) => markers.includes(marker))
  if (pythonEvidence.length > 0) {
    return {
      family: "python",
      evidence: pythonEvidence,
      version: pythonVersion(snapshot),
      packageManager: null,
    }
  }

  const phpEvidence = PHP_MARKERS.filter((marker) => markers.includes(marker))
  if (phpEvidence.length > 0) {
    return { family: "php", evidence: phpEvidence, version: null, packageManager: null }
  }

  if (markers.includes("go.mod")) {
    return { family: "go", evidence: ["go.mod"], version: null, packageManager: null }
  }

  if (markers.includes("index.html")) {
    return { family: "static", evidence: ["index.html"], version: null, packageManager: null }
  }

  warnings.push(
    "Aucun indice de runtime trouvé (ni package.json, ni requirements.txt, ni composer.json, " +
      "ni go.mod, ni index.html). Ajoutez un Dockerfile pour dire explicitement comment " +
      "déployer ce projet."
  )
  return { family: "inconnu", evidence: [], version: null, packageManager: null }
}

/** `.nvmrc`/`.node-version` d'abord, `engines.node` réduit à son entier majeur ensuite. */
function nodeVersion(
  snapshot: ProjectSnapshot,
  pkg: Record<string, unknown> | undefined
): string | null {
  const fromFile = snapshot.contents[".nvmrc"] ?? snapshot.contents[".node-version"]
  if (fromFile !== undefined) {
    const major = fromFile.trim().split(".")[0]
    return major && major.length > 0 ? major : null
  }

  const engines = pkg?.engines as Record<string, string> | undefined
  const raw = engines?.node
  if (raw) {
    const major = /\d+/.exec(raw)?.[0]
    if (major) return major
  }

  return null
}

/** `.python-version` d'abord, `requires-python` du `pyproject.toml` ensuite. */
function pythonVersion(snapshot: ProjectSnapshot): string | null {
  const fromFile = snapshot.contents[".python-version"]
  if (fromFile !== undefined) return fromFile.trim()

  const pyproject = snapshot.contents["pyproject.toml"]
  if (pyproject !== undefined) {
    const match = /requires-python\s*=\s*"([^"]+)"/.exec(pyproject)?.[1]
    if (match) return match.trim()
  }

  return null
}

/** Jamais le champ `packageManager` du `package.json` : il ment sur un dépôt migré. */
function packageManagerFrom(markers: string[]): "pnpm" | "npm" | "yarn" | "bun" | null {
  if (markers.includes("pnpm-lock.yaml")) return "pnpm"
  if (markers.includes("yarn.lock")) return "yarn"
  if (markers.includes("package-lock.json")) return "npm"
  if (markers.includes("bun.lockb") || markers.includes("bun.lock")) return "bun"
  return null
}

function detectFramework(
  pkg: Record<string, unknown> | undefined,
  requirementsTxt: string | undefined
): string | null {
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    }

    for (const [dependency, framework] of NODE_FRAMEWORKS) {
      if (dependency in deps) return framework
    }
  }

  if (requirementsTxt !== undefined) {
    const packages = requirementsTxt
      .split("\n")
      .map((line) => /^([A-Za-z0-9_.-]+)/.exec(line.trim())?.[1]?.toLowerCase())

    for (const name of PYTHON_FRAMEWORKS) {
      if (packages.includes(name)) return name
    }
  }

  return null
}

function detectOutput(
  snapshot: ProjectSnapshot,
  pkg: Record<string, unknown> | undefined,
  family: RuntimeFamily
): ProjectFacts["output"] {
  const nextConfig =
    snapshot.contents["next.config.ts"] ??
    snapshot.contents["next.config.js"] ??
    snapshot.contents["next.config.mjs"]

  if (nextConfig !== undefined && /output\s*:\s*["']standalone["']/.test(nextConfig)) {
    return { mode: "standalone", directory: ".next/standalone" }
  }

  const scripts = pkg?.scripts as Record<string, string> | undefined
  if (scripts) {
    if ("start" in scripts) return { mode: "server", directory: null }
    if ("build" in scripts) return { mode: "static", directory: "dist" }
  }

  if (family === "static") return { mode: "static", directory: null }

  return { mode: "inconnu", directory: null }
}

/**
 * §7 : l'EXPOSE d'un Dockerfile déclaré prime sur tout défaut de framework — c'est
 * l'application du principe général « déclaré avant déduit ». Sans aucun des deux, le
 * port reste `null` : deviner 80 romprait la promesse faite au développeur de ne
 * jamais fabriquer une donnée qu'il n'a pas fournie.
 *
 * Une sortie statique n'écoute sur aucun port applicatif en production, quel que soit
 * le framework qui l'a produite : lui prêter un défaut serait présenter une supposition
 * comme un fait, ce que la spec interdit même quand la règle du port ne le redit pas
 * explicitement. Un Dockerfile déclaré reste prioritaire — un choix exprimé par le
 * développeur n'est jamais contredit.
 */
function detectPort(
  snapshot: ProjectSnapshot,
  dockerfiles: string[],
  framework: string | null,
  family: RuntimeFamily,
  outputMode: OutputMode
): ProjectFacts["port"] {
  for (const dockerfile of dockerfiles) {
    const expose = snapshot.dockerfileHints[dockerfile]?.expose[0]
    if (expose !== undefined) {
      return { value: expose, source: "EXPOSE dans Dockerfile" }
    }
  }

  if (outputMode === "static") {
    return {
      value: null,
      source: "site statique : servi comme des fichiers, sans port applicatif",
    }
  }

  if (framework && framework in FRAMEWORK_DEFAULT_PORT) {
    // Copie défensive : l'objet du dictionnaire est partagé entre tous les appels,
    // et ne doit jamais être rendu par référence à un appelant qui pourrait le muter.
    return { ...(FRAMEWORK_DEFAULT_PORT[framework] as { value: number; source: string }) }
  }

  if (family === "php") {
    return { value: 8000, source: "port par défaut de PHP" }
  }

  return { value: null, source: "à confirmer avec le développeur" }
}

function detectData(
  pkg: Record<string, unknown> | undefined,
  snapshot: ProjectSnapshot
): ProjectFacts["data"] {
  const deps = pkg
    ? {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      }
    : undefined
  const requirementsTxt = snapshot.contents["requirements.txt"]

  const hasNodeDep = (name: string) => !!deps && name in deps
  const hasPythonDep = (name: string) =>
    requirementsTxt !== undefined && new RegExp(`^${name}\\b`, "im").test(requirementsTxt)

  const engines: string[] = []
  if (hasNodeDep("pg") || hasNodeDep("postgres") || hasPythonDep("psycopg2")) {
    engines.push("postgres")
  }
  if (hasNodeDep("mysql2") || hasPythonDep("mysqlclient")) {
    engines.push("mysql")
  }
  if (hasNodeDep("mongoose") || hasPythonDep("pymongo")) {
    engines.push("mongo")
  }

  return {
    engines,
    migrations: snapshot.markers.includes("prisma/schema.prisma") ? "prisma" : null,
  }
}

/**
 * Un fichier `.env.example` ou `.env.sample` est un gabarit, distribué à dessein : il ne
 * porte pas de valeur réelle. Seul un `.env*` qui n'est pas un gabarit justifie
 * l'avertissement — et seulement s'il n'est pas couvert par le `.gitignore`, sans quoi
 * il ne quittera jamais le poste du développeur.
 */
function detectEnv(snapshot: ProjectSnapshot, warnings: string[]): ProjectFacts["env"] {
  const files = Object.keys(snapshot.envKeys)
  const keys = [...new Set(Object.values(snapshot.envKeys).flat())]
  const realFiles = files.filter((file) => !/example|sample|template/i.test(file))

  const gitignore = snapshot.contents[".gitignore"]
  const gitignorePatterns = parseGitignorePatterns(gitignore)

  for (const file of realFiles) {
    if (!isCoveredByGitignore(file, gitignorePatterns)) {
      warnings.push(
        `« ${file} » contient des valeurs d'environnement réelles et n'est pas couvert par ` +
          "le .gitignore : vérifiez qu'il ne sera jamais committé."
      )
    }
  }

  return { keys, files, hasLocalSecrets: realFiles.length > 0 }
}

/**
 * Une ligne vide ou un commentaire (`#`) ne désigne aucun fichier : une recherche de
 * sous-chaîne sur le fichier brut se laisserait tromper par un `.gitignore` qui se
 * contente de *mentionner* `.env` dans un commentaire, et déclarerait couvert un secret
 * qui ne l'est pas — la conclusion la plus dangereuse que ce module puisse rendre.
 */
function parseGitignorePatterns(gitignore: string | undefined): string[] {
  if (gitignore === undefined) return []

  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/**
 * Pas une implémentation complète de la syntaxe `.gitignore` (pas de répertoires, pas de
 * négation, pas de `**`) : juste assez pour reconnaître qu'un motif comme `.env`,
 * `.env*`, `*.env` ou `.env.production` désigne le fichier donné.
 */
function isCoveredByGitignore(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`).test(file)
  })
}

/**
 * Un paquet imbriqué (`apps/site/package.json`) signale un dépôt qui héberge plusieurs
 * projets déployables. Choisir pour le développeur reviendrait à parier sur celui qu'il
 * visait ; le signal est rendu, la décision lui revient (§5.3).
 */
function detectMonorepo(markers: string[], warnings: string[]): ProjectFacts["monorepo"] {
  const directories = new Set<string>()

  for (const marker of markers) {
    const segments = marker.split("/")
    if (segments.length < 2) continue

    const base = segments[segments.length - 1]
    if (base && PACKAGE_INDICATORS.has(base)) {
      directories.add(segments.slice(0, -1).join("/"))
    }
  }

  const packages = [...directories].sort()
  const detected = packages.length >= 2

  if (detected) {
    warnings.push(
      "Plusieurs paquets coexistent dans ce dépôt : précisez quel paquet déployer."
    )
  }

  return { detected, packages }
}

/** Au-delà de 100 Mio, le transfert vers le serveur cible devient un facteur à part entière. */
function checkWeight(weight: ProjectSnapshot["weight"], warnings: string[]): void {
  const threshold = 100 * 1024 * 1024

  if (weight.bytes > threshold) {
    warnings.push(`L'arborescence pèse ${formatWeight(weight.bytes)} : le transfert prendra du temps.`)
  }

  if (weight.tronque) {
    warnings.push(
      "L'instantané a été tronqué (trop de fichiers ou de contenu) : certains indices ont pu être manqués."
    )
  }
}

function formatWeight(bytes: number): string {
  const mio = bytes / (1024 * 1024)
  if (mio < 1024) return `${Math.round(mio)} Mio`

  const gio = bytes / (1024 * 1024 * 1024)
  return `${gio.toFixed(1)} Gio`
}
