import { z } from "zod"

/**
 * Le vocabulaire fermé des étapes de déploiement.
 *
 * Un plan est une donnée, pas un script : l'agent choisit quelles étapes, dans quel ordre
 * et avec quelles valeurs, mais il ne peut pas en inventer une. C'est ce qui borne une
 * injection de prompt trouvée dans le dépôt d'un client — le pire résultat devient un plan
 * légitime et mauvais, affiché en clair à un humain qui doit l'approuver, jamais
 * l'exécution de code arbitraire en root.
 *
 * Neuf types, pas douze : `compose.up`, `proxy.internal_port` et `db.container`
 * appartiennent aux jalons 4 et 5. Les ajouter plus tard est un changement délibéré et
 * versionné, pas un oubli à combler ici.
 */

/**
 * `.strict()` sur chaque étape : Zod supprime par défaut les clés inconnues, et un champ
 * en trop passerait donc en silence. C'est exactement la forme d'une tentative — glisser
 * `commande` à côté d'un type légitime en espérant qu'un exécuteur futur le lise.
 */
const HostPrepare = z
  .object({
    type: z.literal("host.prepare"),
    swap_mo: z.number().int().min(0).max(8192),
  })
  .strict()

const HostInstallDocker = z
  .object({
    type: z.literal("host.install_docker"),
  })
  .strict()

const ProxyCaddyInstall = z
  .object({
    type: z.literal("proxy.caddy.install"),
  })
  .strict()

const BuildGenerateDockerfile = z
  .object({
    type: z.literal("build.generate_dockerfile"),
    /**
     * Trois familles, pas cinq : la spec §5.4 ne prévoit de gabarit que pour Node, Python
     * et le statique pur. `pickTemplate` (tâche 3) rend `null` pour PHP et Go, et cette
     * étape n'existe que lorsqu'un gabarit a été choisi — y admettre `"php"` ou `"go"`
     * déclarerait un cas que rien ne peut produire. Ne pas « compléter » cette liste sans
     * qu'un gabarit correspondant existe réellement.
     */
    famille: z.enum(["node", "python", "static"]),
    version: z.string().min(1).max(20),
    /** Mêmes valeurs que `ProjectFacts.runtime.packageManager` (`project-analyze.ts`), `null` inclus : un dépôt sans fichier de verrouillage n'en a pas. */
    gestionnaire: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
    /** `OutputMode` (`project-analyze.ts`) moins `"inconnu"` : un mode non déterminé ne peut pas produire de gabarit. */
    sortie: z.enum(["server", "standalone", "static"]),
    port: z.number().int().min(1).max(65535),
  })
  .strict()

/**
 * `source` distingue d'où vient l'image à construire. Un seul cas connu pour l'instant —
 * une racine de projet locale déjà constatée par le jalon 2 — laissant `build.image`
 * dépendant d'un `source.type` fermé lui aussi, pour la même raison que le reste.
 */
const BuildImageSource = z
  .object({
    type: z.literal("local"),
    path: z.string().min(1).max(500),
  })
  .strict()

const BuildImage = z
  .object({
    type: z.literal("build.image"),
    source: BuildImageSource,
    tag: z.string().min(1).max(200),
  })
  .strict()

const EnvWrite = z
  .object({
    type: z.literal("env.write"),
    depuis: z.string().min(1).max(500),
  })
  .strict()

const AppRun = z
  .object({
    type: z.literal("app.run"),
    port_interne: z.number().int().min(1).max(65535),
    reseau: z.string().min(1).max(100),
  })
  .strict()

const ProxyCaddySite = z
  .object({
    type: z.literal("proxy.caddy.site"),
    domaine: z.string().min(1).max(253),
  })
  .strict()

const StateRecord = z
  .object({
    type: z.literal("state.record"),
  })
  .strict()

/**
 * Une union discriminée sur `type` : Zod n'essaie pas les neuf branches et ne rend pas
 * neuf erreurs, il lit `type` et rapporte l'écart dans la bonne branche. Un `z.union()`
 * ordinaire produirait un message illisible pour un agent.
 */
const StepSchema = z.discriminatedUnion("type", [
  HostPrepare,
  HostInstallDocker,
  ProxyCaddyInstall,
  BuildGenerateDockerfile,
  BuildImage,
  EnvWrite,
  AppRun,
  ProxyCaddySite,
  StateRecord,
])

export type StepType =
  | "host.prepare"
  | "host.install_docker"
  | "proxy.caddy.install"
  | "build.generate_dockerfile"
  | "build.image"
  | "env.write"
  | "app.run"
  | "proxy.caddy.site"
  | "state.record"

export type PlanStep = z.infer<typeof StepSchema>

/**
 * `regime` n'accepte que les trois régimes exécutables. Un plan pour un `panneau` ou un
 * `occupe` n'existe pas : le jalon 2 y rend un refus, pas une proposition. L'interdire au
 * niveau du type évite d'avoir à le refuser plus tard, dans un endroit qu'on pourrait
 * oublier.
 */
export const PlanSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^plan_[A-Za-z0-9]{4,32}$/),
    /** Un identifiant d'instance est un UUID ; 64 bornent large sans laisser passer une chaîne arbitraire. */
    serveur: z.string().regex(/^[A-Za-z0-9_-]+$/).max(64),
    regime: z.enum(["vierge", "docker", "skynode"]),
    empreinte_etat: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    application: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    resume: z.string().min(1).max(500),
    etapes: z.array(StepSchema).min(1).max(30),
    hors_perimetre: z.array(z.string().max(200)).max(20),
    reversible: z.boolean(),
  })
  .strict()

export type Plan = z.infer<typeof PlanSchema>

/** Distingue un plan mal formé (fautif) d'un bogue de ce module. */
export class PlanFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanFormatError"
  }
}

/**
 * Vérifie qu'aucun objet de l'arbre ne porte de clé **propre** nommée `__proto__`, avant
 * de confier l'entrée à Zod.
 *
 * `.strict()` teste l'appartenance d'une clé au schéma via `key in shape`, et
 * `'__proto__' in {}` vaut toujours `true` — c'est l'accesseur hérité d'`Object.prototype`,
 * pas une clé du schéma. Zod ne voit donc jamais `__proto__` comme une clé en trop : elle
 * est supprimée en silence au lieu d'être refusée. Rien n'en fuit ici — un `JSON.parse` ne
 * pollue jamais le vrai `Object.prototype` — mais l'invariant du jalon est de refuser,
 * jamais d'assainir sans le dire : un plan accepté amputé d'une clé que l'agent ne
 * retrouve nulle part dans le message est indiscernable d'un plan correct.
 *
 * `Object.getOwnPropertyNames` voit la clé propre là où `in` ne la distinguerait pas de
 * l'héritée ; on parcourt nous-mêmes l'arbre plutôt que de faire confiance au schéma.
 */
function findOwnProtoKey(value: unknown, path: PropertyKey[]): PropertyKey[] | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findOwnProtoKey(value[index], [...path, index])
      if (found) return found
    }
    return null
  }
  if (value === null || typeof value !== "object") return null

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__") return [...path, key]
    const found = findOwnProtoKey((value as Record<string, unknown>)[key], [...path, key])
    if (found) return found
  }
  return null
}

/** Lit une valeur au bout d'un chemin Zod (`["etapes", 0, "type"]`) dans l'entrée d'origine. */
function readAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

/** Chemin lisible par un agent : `etapes[0].port_interne`, ou `(racine)` s'il est vide. */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(racine)"
  let out = ""
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`
    }
  }
  return out
}

/**
 * Décrit une valeur fournie pour un message d'erreur, sans jamais la coercer en chaîne :
 * `String(["app.run"])` vaut `"app.run"`, ce qui ferait dire au message qu'une valeur
 * appartient au vocabulaire fermé alors qu'elle n'est même pas une chaîne. Un agent qui
 * lit ça en conclurait que le validateur est cassé, pas que son plan l'est.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return "absent"
  if (value === null) return "null"
  if (Array.isArray(value)) return "un tableau"
  if (typeof value === "number") return "un nombre"
  if (typeof value === "boolean") return "un booléen"
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "object") return "un objet"
  return "une valeur non prise en charge"
}

/**
 * Traduit une `ZodError` en un message français, un par ligne, que l'agent qui a produit
 * le plan peut lire pour le corriger. Ne jamais laisser passer le message anglais de Zod :
 * « Invalid input » l'enverrait tout réécrire au hasard.
 *
 * Deux cas où le rendu par défaut de Zod est insuffisant pour cet usage, vérifiés par
 * exécution sur Zod 4.4.3 :
 *
 * - Discriminant inconnu (`code: "invalid_union"`, `path: ["type"]`) : Zod ne nomme que
 *   les types attendus, jamais celui fourni. On relit `entree` au même chemin pour
 *   l'ajouter — c'est ce qui rend `shell.run` visible dans le message.
 * - Champ en trop (`code: "unrecognized_keys"`) : le nom fautif est dans `issue.keys`, pas
 *   dans `issue.path` — qui pointe vers l'objet contenant, pas vers la clé de trop.
 */
function formatIssue(issue: z.core.$ZodIssue, entree: unknown): string {
  const chemin = formatPath(issue.path)

  if (issue.code === "unrecognized_keys") {
    return `${chemin} : champ(s) en trop non reconnu(s) — ${issue.keys.join(", ")}`
  }

  if (issue.code === "invalid_union" && issue.path[issue.path.length - 1] === "type") {
    const fourni = readAtPath(entree, issue.path)
    return `${chemin} : type d'étape inconnu — ${describeValue(fourni)} ne fait pas partie du vocabulaire fermé`
  }

  if (issue.code === "too_small" && issue.path.length === 1 && issue.path[0] === "etapes") {
    return `${chemin} : un plan doit contenir au moins une étape`
  }

  switch (issue.code) {
    case "invalid_type":
      return `${chemin} : valeur manquante ou de mauvais type`
    case "too_small":
      return `${chemin} : valeur trop courte, trop petite ou tableau vide`
    case "too_big":
      return `${chemin} : valeur trop longue ou trop grande`
    case "invalid_format":
      return `${chemin} : format invalide`
    default:
      return `${chemin} : valeur invalide`
  }
}

/**
 * Analyse une valeur quelconque en `Plan` typé, ou lève `PlanFormatError` avec un message
 * français exploitable par l'agent qui a produit le plan.
 */
export function parsePlan(value: unknown): Plan {
  const protoPath = findOwnProtoKey(value, [])
  if (protoPath) {
    throw new PlanFormatError(
      `plan invalide :\n${formatPath(protoPath)} : clé "__proto__" interdite`
    )
  }

  const result = PlanSchema.safeParse(value)
  if (result.success) return result.data

  const messages = result.error.issues.map((issue) => formatIssue(issue, value))
  throw new PlanFormatError(`plan invalide :\n${messages.join("\n")}`)
}
