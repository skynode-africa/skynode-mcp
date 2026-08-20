import type { Instance } from "./api.js"
import type { ProjectFacts, RuntimeFamily } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"

/**
 * Mise en forme des deux constats à destination d'un agent de code.
 *
 * Le raisonnement de `src/format.ts` s'applique tel quel : chaque jeton dépensé à
 * décoder un vidage de données est un jeton de moins pour la tâche du développeur. Trois
 * règles, dans cet ordre de priorité : la conclusion en première ligne, les blocages et
 * la marche à suivre juste après, et rien qui ne serve pas à décider — le noyau, les
 * services systemd, les réseaux Docker ne sortent jamais d'ici ; ils restent dans les
 * faits que le jalon 3 lira.
 */

/** Dix conteneurs listés, puis un repli : une machine chargée ne doit pas noyer le reste. */
const MAX_CONTAINERS = 10

/** Même repli pour les clés d'environnement : leur nombre n'est pas borné côté dépôt. */
const MAX_ENV_KEYS = 30

/** Nom présentable d'un framework détecté ; la clé technique sert de repli si absente. */
const FRAMEWORK_LABELS: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  astro: "Astro",
  nestjs: "NestJS",
  express: "Express",
  vite: "Vite",
  fastapi: "FastAPI",
  django: "Django",
  flask: "Flask",
}

const RUNTIME_LABELS: Record<RuntimeFamily, string> = {
  node: "Node.js",
  python: "Python",
  php: "PHP",
  go: "Go",
  static: "site statique",
  inconnu: "runtime inconnu",
}

// ---------------------------------------------------------------------------
// Constat projet
// ---------------------------------------------------------------------------

export function formatProjectReport(facts: ProjectFacts): string {
  const lines: string[] = [projectHeadline(facts), "", dockerfileLine(facts)]

  if (facts.warnings.length > 0) {
    lines.push("", "Avertissements :", ...facts.warnings.map((w) => `- ${w}`))
  }

  if (facts.env.keys.length > 0) {
    lines.push("", envLine(facts.env))
  }

  lines.push("", ...projectDetailLines(facts))

  return lines.join("\n")
}

function projectHeadline(facts: ProjectFacts): string {
  if (facts.framework) {
    const label = FRAMEWORK_LABELS[facts.framework] ?? facts.framework
    return `${label} détecté (${RUNTIME_LABELS[facts.runtime.family]}).`
  }

  if (facts.runtime.family === "inconnu") {
    return "Runtime inconnu : aucun indice de langage trouvé dans ce dépôt."
  }

  return `Projet ${RUNTIME_LABELS[facts.runtime.family]} détecté.`
}

/**
 * §5.3 : le dépôt qui se déclare l'emporte sur toute déduction. Cette ligne vient donc
 * juste après la conclusion, avant tout autre détail — c'est le fait le plus décisif du
 * rapport après la famille de runtime elle-même.
 */
function dockerfileLine(facts: ProjectFacts): string {
  if (facts.declared.dockerfiles.length > 0) {
    return (
      `Dockerfile fourni (${facts.declared.dockerfiles.join(", ")}) : ` +
      "il sera utilisé tel quel, sans être régénéré."
    )
  }

  if (facts.runtime.family === "inconnu") {
    return (
      "Aucun Dockerfile, et aucun indice de runtime : ajoutez-en un pour dire " +
      "explicitement comment déployer ce projet."
    )
  }

  return "Aucun Dockerfile : un Dockerfile standard sera généré au déploiement, d'après le runtime détecté."
}

/** Les noms des clés seulement — jamais leur valeur, et le rapport le dit explicitement. */
function envLine(env: ProjectFacts["env"]): string {
  const shown = env.keys.slice(0, MAX_ENV_KEYS)
  const rest = env.keys.length - shown.length
  const list = shown.join(", ") + (rest > 0 ? `, et ${rest} autres` : "")

  return `Variables d'environnement (noms uniquement, les valeurs ne sont jamais lues) : ${list}`
}

function projectDetailLines(facts: ProjectFacts): string[] {
  const lines: string[] = []

  const version = facts.runtime.version ? ` ${facts.runtime.version}` : ""
  const packageManager = facts.runtime.packageManager ? `, ${facts.runtime.packageManager}` : ""
  const evidence = facts.runtime.evidence.length > 0 ? facts.runtime.evidence.join(", ") : "aucun"
  lines.push(`Runtime : ${RUNTIME_LABELS[facts.runtime.family]}${version}${packageManager} (indices : ${evidence})`)

  const directory = facts.output.directory ? ` (${facts.output.directory})` : ""
  lines.push(`Sortie : ${facts.output.mode}${directory}`)

  lines.push(`Port : ${facts.port.value ?? "non déterminé"} — ${facts.port.source}`)

  if (facts.data.engines.length > 0 || facts.data.migrations) {
    const migrations = facts.data.migrations ? `, migrations ${facts.data.migrations}` : ""
    lines.push(`Données : ${facts.data.engines.join(", ") || "aucun moteur détecté"}${migrations}`)
  }

  if (facts.monorepo.detected) {
    lines.push(`Paquets du monorepo : ${facts.monorepo.packages.join(", ")}`)
  }

  if (facts.weight.tronque) {
    lines.push("Instantané tronqué (trop de fichiers ou de contenu) : certains indices ont pu être manqués.")
  }

  return lines
}

// ---------------------------------------------------------------------------
// Constat serveur
// ---------------------------------------------------------------------------

export function formatServerReport(
  instance: Instance,
  facts: ServerFacts,
  classification: Classification
): string {
  const lines: string[] = [serverHeadline(classification), "", `Constat : ${classification.because}`]

  // Un refus se lit comme un constat, jamais comme une panne : la marche à suivre
  // vient tout de suite après, avant le premier détail de la machine.
  if (!classification.executable && classification.guidance.length > 0) {
    lines.push("", "Marche à suivre :", ...classification.guidance.map((g, i) => `${i + 1}. ${g}`))
  }

  if (classification.blockers.length > 0) {
    lines.push("", "Points de vigilance :", ...classification.blockers.map((b) => `- ${b}`))
  }

  lines.push("", ...serverDetailLines(instance, facts))

  return lines.join("\n")
}

function serverHeadline(classification: Classification): string {
  const outcome = classification.executable
    ? "le déploiement est possible"
    : "SkyNode ne déploiera pas ici sans y être invité"

  return `Régime ${classification.regime} : ${outcome}.`
}

function serverDetailLines(instance: Instance, facts: ServerFacts): string[] {
  const lines: string[] = []

  const system = facts.host.osName || `${facts.host.osId} ${facts.host.osVersion}`.trim()
  lines.push(`Machine : ${instance.hostname ?? instance.id} — ${system} (${facts.host.arch})`)
  lines.push(`Accès : ${facts.access.elevate}`)
  lines.push(
    `Ressources : ${facts.resources.cpu} vCPU, ${facts.resources.memoryMb} Mio RAM, ` +
      `swap ${facts.resources.swapMb} Mio, disque à ${facts.resources.diskUsePercent} %`
  )

  if (facts.binaries.length > 0) {
    lines.push(`Outils présents : ${facts.binaries.join(", ")}`)
  }

  if (facts.docker.present) {
    lines.push(...dockerLines(facts.docker))
  }

  return lines
}

/**
 * Les conteneurs servent à décider ; les réseaux Docker et les services systemd non —
 * ils restent dans `ServerFacts` pour le jalon 3, jamais rendus ici.
 */
function dockerLines(docker: ServerFacts["docker"]): string[] {
  const state = docker.usable ? "utilisable" : "présent mais non joignable pour cet utilisateur"
  const version = docker.version ? ` (${docker.version})` : ""
  const lines: string[] = [`Docker : ${state}${version}`]

  if (docker.containers.length === 0) {
    lines.push("Aucun conteneur en cours.")
    return lines
  }

  const shown = docker.containers.slice(0, MAX_CONTAINERS)
  const rest = docker.containers.length - shown.length

  lines.push(`${docker.containers.length} conteneurs :`)
  lines.push(...shown.map((c) => `- ${c.name} (${c.image}) — ${c.state}`))

  if (rest > 0) {
    lines.push(`… et ${rest} autres`)
  }

  return lines
}
