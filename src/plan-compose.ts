import { createHash } from "node:crypto"

import type { Instance } from "./api.js"
import { pickTemplate } from "./dockerfile.js"
import { computeFingerprint } from "./fingerprint.js"
import type { Plan, PlanStep } from "./plan-types.js"
import type { ProjectFacts } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"

/**
 * Composition d'un plan de déploiement à partir des deux constats du jalon 2.
 *
 * `plan_deployment` (spec §5.3) : déterministe — mêmes faits, même plan, à l'octet
 * près — et court sur les règles, volontairement. Aucune I/O ici : ni disque, ni
 * réseau, ni horloge. Une fonction qui écrirait, ou qui daterait sa sortie, romprait le
 * seul contrat qui permet au jalon 3b de reconnaître un redéploiement identique et de ne
 * pas redemander une approbation à chaque appel.
 */

export interface ComposeOptions {
  application: string
  domaine?: string
  /** Fichier d'environnement du dépôt à transférer, chemin relatif à la racine. */
  envFile?: string
}

export type ComposeResult = { ok: true; plan: Plan } | { ok: false; because: string; guidance: string[] }

/** Même règle que `PlanSchema.application` (`plan-types.ts`) : la reproduire ici évite un
 * plan qui échouerait sa propre validation après coup, pour une raison que ce module
 * aurait pu écarter avant même de composer quoi que ce soit. */
const APPLICATION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Une étiquette DNS : lettres, chiffres, tiret interne, jamais en tête ni en queue. */
const DOMAIN_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

/** Le réseau Docker que `proxy.caddy.install` crée. Le seul que `app.run` utilise —
 * jamais `host`, qui donnerait au conteneur la pile réseau de la machine. */
const APP_NETWORK = "skynode"

/** Nom du conteneur posé par `proxy.caddy.install`, repris tel quel de `fingerprint.ts`. */
const CADDY_CONTAINER = "skynode-caddy"

/**
 * `staticSite()` (`dockerfile.ts`) n'utilise jamais `params.version` — le gabarit sert
 * des fichiers déjà construits, sans étape de compilation à étiqueter. Mais
 * `generateDockerfile()` valide ce champ avant même de regarder la famille : une chaîne
 * vide romprait la génération au jalon 3b pour une raison sans rapport avec le site
 * statique lui-même. Ce n'est pas une supposition sur un runtime — un site statique n'en
 * a pas — juste une valeur qui satisfait un champ que le schéma exige de toute façon.
 */
const STATIC_PLACEHOLDER_VERSION = "1"

/** Un domaine simple : au moins deux étiquettes, aucun schéma, aucun chemin. */
function isValidDomain(domaine: string): boolean {
  if (domaine.length === 0 || domaine.length > 253) return false

  const labels = domaine.split(".")
  if (labels.length < 2) return false

  return labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
}

function refuse(because: string, guidance: string[]): ComposeResult {
  return { ok: false, because, guidance }
}

function swapMo(server: ServerFacts): number {
  return server.resources.memoryMb < 4096 && server.resources.swapMb === 0 ? 2048 : 0
}

/** Vrai quand Caddy tourne déjà sous le nom que `proxy.caddy.install` lui donne — le
 * cas d'une machine déjà gérée par SkyNode, où le réinstaller écraserait sa config. */
function caddyAlreadyInstalled(server: ServerFacts): boolean {
  return server.docker.containers.some((c) => c.name === CADDY_CONTAINER)
}

export function composePlan(
  instance: Instance,
  project: ProjectFacts,
  server: ServerFacts,
  classification: Classification,
  options: ComposeOptions
): ComposeResult {
  if (!APPLICATION_PATTERN.test(options.application)) {
    return refuse(
      `« ${options.application} » n'est pas un nom d'application valide : minuscules, chiffres ` +
        "et tirets uniquement, doit commencer par une lettre, 32 caractères au maximum.",
      ["Choisissez un nom conforme, par exemple « boutique » ou « api-interne »."]
    )
  }

  if (options.domaine !== undefined && !isValidDomain(options.domaine)) {
    return refuse(`« ${options.domaine} » n'est pas un nom de domaine valide.`, [
      "Indiquez un domaine simple, par exemple « boutique.exemple.ci », sans schéma ni chemin.",
    ])
  }

  // Régime non exécutable : le jalon 2 a déjà formulé le refus, on ne le réécrit pas
  // (spec §5.3, première règle de composition).
  if (!classification.executable) {
    return refuse(classification.because, classification.guidance)
  }

  // `app.run` en a besoin quel que soit le chemin choisi ensuite (Dockerfile fourni ou
  // généré) : un seul contrôle, commun aux deux, plutôt que répété dans chaque branche.
  if (project.port.value === null) {
    return refuse(`Le port d'écoute de l'application n'a pas pu être déduit (${project.port.source}).`, [
      "Indiquez le port sur lequel l'application écoute (variable PORT dans le code, ou EXPOSE " +
        "dans un Dockerfile), puis relancez inspect_project.",
    ])
  }
  const port = project.port.value

  // Le dépôt qui se déclare l'emporte sur toute déduction (spec §5.3) : un Dockerfile
  // fourni saute directement à `build.image`, sans étape de génération.
  const dockerfileProvided = project.declared.dockerfiles.length > 0

  let generatedStep: Extract<PlanStep, { type: "build.generate_dockerfile" }> | null = null

  if (!dockerfileProvided) {
    if (project.declared.composeFiles.length > 0) {
      return refuse(
        "Le dépôt contient un docker-compose.yml : le reprendre tel quel (compose.up) est prévu " +
          "pour le jalon 4, pas celui-ci — composer un plan qui l'ignorerait serait pire que refuser.",
        [
          "Décrivez le service unique à exposer et son port : SkyNode peut composer un plan par " +
            "Dockerfile pour ce seul service en attendant compose.up.",
          "Sinon, patientez jusqu'au jalon 4, qui reprendra ce docker-compose.yml tel quel.",
        ]
      )
    }

    const sortie = pickTemplate(project.runtime.family, project.output.mode)

    if (sortie === null) {
      return refuse(
        `Aucun gabarit ne convient à ce dépôt (famille « ${project.runtime.family} », sortie « ` +
          `${project.output.mode} ») : SkyNode ne sait générer un Dockerfile que pour Node, Python ` +
          "(ASGI) et le statique pur.",
        [
          "Ajoutez un Dockerfile à la racine du dépôt qui construit et démarre l'application sur " +
            "le port attendu ; le prochain inspect_project le détectera et plan_deployment le " +
            "reprendra directement, sans génération.",
        ]
      )
    }

    // `pickTemplate` ne rend une sortie non nulle que pour ces trois familles : la même
    // liste que `BuildGenerateDockerfile.famille` (`plan-types.ts`), pas une coïncidence.
    const famille = project.runtime.family as "node" | "python" | "static"

    let version: string
    if (famille === "static") {
      version = STATIC_PLACEHOLDER_VERSION
    } else if (project.runtime.version === null) {
      return refuse(
        `La version de ${famille} n'a pas pu être déduite du dépôt : SkyNode ne devine jamais une ` +
          "version de runtime, elle déterminerait l'image de base du Dockerfile généré.",
        [
          famille === "node"
            ? "Ajoutez un .nvmrc, un .node-version, ou un champ engines.node dans package.json."
            : "Ajoutez un .python-version, ou un champ requires-python dans pyproject.toml.",
          "Sinon, fournissez un Dockerfile : le prochain plan le reprendra tel quel.",
        ]
      )
    } else {
      version = project.runtime.version
    }

    generatedStep = {
      type: "build.generate_dockerfile",
      famille,
      version,
      gestionnaire: project.runtime.packageManager,
      sortie,
      port,
    }
  }

  // Régime vierge → les étapes d'équipement précèdent. Régime docker → on s'installe sur
  // le Docker existant, on n'en réinstalle pas. Régime skynode → rien d'autre que
  // construire, démarrer, router (spec §5.3, §5.5) : la machine est déjà équipée, et
  // Caddy y tourne déjà sous le nom que `proxy.caddy.install` lui aurait donné.
  const etapes: PlanStep[] = []

  if (classification.regime !== "skynode") {
    etapes.push({ type: "host.prepare", swap_mo: swapMo(server) })

    if (classification.regime === "vierge") {
      etapes.push({ type: "host.install_docker" })
    }

    if (!caddyAlreadyInstalled(server)) {
      etapes.push({ type: "proxy.caddy.install" })
    }
  }

  if (generatedStep) etapes.push(generatedStep)

  etapes.push({
    type: "build.image",
    source: { type: "local", path: "." },
    tag: `skynode/${options.application}`,
  })

  if (options.envFile !== undefined) {
    etapes.push({ type: "env.write", depuis: options.envFile })
  }

  etapes.push({ type: "app.run", port_interne: port, reseau: APP_NETWORK })

  if (options.domaine !== undefined) {
    etapes.push({ type: "proxy.caddy.site", domaine: options.domaine })
  }

  etapes.push({ type: "state.record" })

  const empreinte_etat = computeFingerprint(server, classification)
  const id = derivePlanId(empreinte_etat, options.application, etapes)

  const horsPerimetre = ["aucune sauvegarde n'est configurée"]
  if (options.domaine === undefined) {
    horsPerimetre.push(
      "aucun domaine fourni : pas de bloc HTTPS ajouté au Caddyfile, l'application reste " +
        "joignable seulement depuis le réseau interne"
    )
  }

  return {
    ok: true,
    plan: {
      version: 1,
      id,
      serveur: instance.id,
      // `classify()` (`regime.ts`) ne rend `executable: true` que pour ces trois régimes ;
      // le refus au-dessus a déjà écarté les trois autres (`panneau`, `inconnu`, `occupe`).
      regime: classification.regime as "vierge" | "docker" | "skynode",
      empreinte_etat,
      application: options.application,
      resume: buildResume(classification.regime, dockerfileProvided, generatedStep, project, options),
      etapes,
      hors_perimetre: horsPerimetre,
      reversible: true,
    },
  }
}

/**
 * `plan_` suivi des douze premiers caractères d'un sha256 de l'empreinte d'état, du nom
 * d'application et des étapes sérialisées — jamais un `randomUUID()`, qui casserait le
 * test des mille compositions et, surtout, empêcherait le jalon 3b de reconnaître un
 * redéploiement identique à celui déjà approuvé.
 */
function derivePlanId(empreinte_etat: string, application: string, etapes: PlanStep[]): string {
  const source = `${empreinte_etat}|${application}|${JSON.stringify(etapes)}`
  const digest = createHash("sha256").update(source).digest("hex")

  return `plan_${digest.slice(0, 12)}`
}

/**
 * Un résumé en français, pour l'humain qui approuve — jamais de date, jamais d'horloge :
 * le même plan doit produire le même texte, à chaque composition.
 */
function buildResume(
  regime: Classification["regime"],
  dockerfileProvided: boolean,
  generatedStep: Extract<PlanStep, { type: "build.generate_dockerfile" }> | null,
  project: ProjectFacts,
  options: ComposeOptions
): string {
  const parts: string[] = []

  if (regime === "vierge") {
    parts.push("installer Docker et Caddy")
  } else if (regime === "docker") {
    parts.push("installer Caddy sur le Docker déjà présent")
  }

  if (dockerfileProvided) {
    parts.push("construire l'image depuis le Dockerfile du dépôt")
  } else if (generatedStep) {
    const cadre = project.framework ?? generatedStep.famille
    const gestionnaire = generatedStep.gestionnaire ?? "sans gestionnaire de paquets détecté"
    parts.push(
      `construire l'image depuis un Dockerfile généré (${cadre}, sortie ${generatedStep.sortie}, ` +
        `${gestionnaire}, ${generatedStep.famille} ${generatedStep.version})`
    )
  }

  parts.push("démarrer le conteneur")

  if (options.domaine !== undefined) {
    parts.push(`publier sur https://${options.domaine}`)
  }

  const phrase = parts.join(", ")

  return phrase.charAt(0).toUpperCase() + phrase.slice(1) + "."
}
