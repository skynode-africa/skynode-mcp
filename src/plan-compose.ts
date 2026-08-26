import { createHash } from "node:crypto"

import type { Instance } from "./api.js"
import { pickTemplate } from "./dockerfile.js"
import { computeFingerprint } from "./fingerprint.js"
import type { Plan, PlanStep } from "./plan-types.js"
import { ALLOWED_NETWORK, APPLICATION_PATTERN, CADDY_CONTAINER, DOMAIN_PATTERN, pathEscapes } from "./plan-rules.js"
import type { ProjectFacts } from "./project-analyze.js"
import type { ServerFacts } from "./probe.js"
import type { Classification } from "./regime.js"
import { BLOCAGE_DOCKER_INJOIGNABLE } from "./regime.js"

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

/**
 * `staticSite()` (`dockerfile.ts`) n'utilise jamais `params.version` — le gabarit sert
 * des fichiers déjà construits, sans étape de compilation à étiqueter. Mais
 * `generateDockerfile()` valide ce champ avant même de regarder la famille : une chaîne
 * vide romprait la génération au jalon 3b pour une raison sans rapport avec le site
 * statique lui-même. Ce n'est pas une supposition sur un runtime — un site statique n'en
 * a pas — juste une valeur qui satisfait un champ que le schéma exige de toute façon.
 */
const STATIC_PLACEHOLDER_VERSION = "1"

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

  // Motif du validateur (`plan-rules.ts`) : minuscules seules, dernière étiquette
  // purement alphabétique. Le composeur doit refuser lui-même ce que le validateur
  // refuserait de toute façon — sinon un domaine en majuscules ou à TLD numérique
  // franchit la composition et échoue plus loin, avec un message qui accuse SkyNode
  // au lieu du domaine.
  if (options.domaine !== undefined && !DOMAIN_PATTERN.test(options.domaine)) {
    return refuse(`« ${options.domaine} » n'est pas un nom de domaine valide.`, [
      "Indiquez un domaine simple, en minuscules, par exemple « boutique.exemple.ci », sans " +
        "schéma ni chemin.",
    ])
  }

  // Même motif que `build.image.source.path` et `env.write.depuis` côté validateur
  // (`plan-rules.ts`) : un chemin absolu, un segment « .. », un espace ou un saut de
  // ligne échoueraient la validation après coup — le refuser ici, avant même de
  // composer quoi que ce soit, avec un message qui parle du chemin, pas de SkyNode.
  if (options.envFile !== undefined && pathEscapes(options.envFile)) {
    return refuse(`« ${options.envFile} » n'est pas un chemin de fichier valide.`, [
      "Indiquez un chemin relatif à la racine du projet, sans chemin absolu ni segment « .. », " +
        "sans espace ni saut de ligne — par exemple « .env » ou « config/.env.production ».",
    ])
  }

  // Régime non exécutable : le jalon 2 a déjà formulé le refus, on ne le réécrit pas
  // (spec §5.3, première règle de composition).
  if (!classification.executable) {
    return refuse(classification.because, classification.guidance)
  }

  // Axe B de la jointure composeur/validateur : `classify()` accorde `executable: true`
  // à des états où Docker existe mais ne peut pas servir à construire une image — un
  // démon arrêté, un utilisateur hors du groupe `docker`. Aucune étape du vocabulaire
  // ne répare un démon injoignable : le plan doit refuser ici, avec le blocage que
  // `classify()` a déjà formulé (`regime.ts`), plutôt que composer une suite d'étapes
  // que `validatePlan` rejettera de toute façon.
  if (server.docker.present && !server.docker.usable) {
    const blocage = classification.blockers.find((b) => b === BLOCAGE_DOCKER_INJOIGNABLE)
    return refuse(
      blocage ?? "Le démon Docker n'est pas joignable sur cette machine : aucune image ne peut y être construite.",
      [
        "Vérifiez que le service Docker tourne sur la machine (`systemctl status docker`) et que " +
          "l'utilisateur SSH appartient au groupe `docker`.",
        "Relancez inspect_server une fois corrigé, puis recomposez le plan.",
      ]
    )
  }

  // Un état SkyNode existant (`skynode.present`) suppose une machine déjà équipée — mais
  // rien n'empêche Docker d'avoir disparu depuis (désinstallation manuelle). `classify()`
  // ne le détecte pas comme un blocage (il ne teste que « présent mais inutilisable ») :
  // ce contrôle est propre au composeur, qui a besoin de Docker pour construire l'image.
  if (classification.regime === "skynode" && !server.docker.present) {
    return refuse(
      "Docker n'est pas installé sur cette machine, alors qu'elle porte déjà un état SkyNode " +
        "(/etc/skynode/state.json) : c'est un état incohérent, aucune image ne peut y être construite.",
      [
        "Vérifiez l'état de la machine directement : Docker a pu être désinstallé après le premier " +
          "déploiement SkyNode.",
        "Réinstallez Docker à la main, puis relancez inspect_server.",
      ]
    )
  }

  // Le dépôt qui se déclare l'emporte sur toute déduction (spec §5.3) : un Dockerfile
  // fourni saute directement à `build.image`, sans étape de génération.
  const dockerfileProvided = project.declared.dockerfiles.length > 0

  let generatedStep: Extract<PlanStep, { type: "build.generate_dockerfile" }> | null = null
  let port: number

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

    // Testé après le gabarit, pas avant (spec §5.3) : un dépôt sans gabarit disponible
    // doit être refusé pour ce motif immédiatement, pas pour un port manquant qu'ajouter
    // ne ferait que révéler l'absence de gabarit à la relance suivante.
    if (project.port.value === null) {
      return refuse(`Le port d'écoute de l'application n'a pas pu être déduit (${project.port.source}).`, [
        "Indiquez le port sur lequel l'application écoute (variable PORT dans le code, ou EXPOSE " +
          "dans un Dockerfile), puis relancez inspect_project.",
      ])
    }
    port = project.port.value

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
  } else {
    // Aucun gabarit à choisir ici : le Dockerfile fourni fait foi, seul le port reste à
    // connaître pour `app.run`.
    if (project.port.value === null) {
      return refuse(`Le port d'écoute de l'application n'a pas pu être déduit (${project.port.source}).`, [
        "Indiquez le port sur lequel l'application écoute (variable PORT dans le code, ou EXPOSE " +
          "dans un Dockerfile), puis relancez inspect_project.",
      ])
    }
    port = project.port.value
  }

  // Régime vierge → les étapes d'équipement précèdent. Régime docker → on s'installe sur
  // le Docker existant, on n'en réinstalle pas. Régime skynode → construire, démarrer,
  // router (spec §5.3, §5.5) : la machine est déjà équipée — sauf le cas où le conteneur
  // Caddy qu'un premier déploiement SkyNode y avait posé a été supprimé depuis. Ce cas se
  // répare : une étape d'équipement suffit, pas un refus (axe B de la jointure
  // composeur/validateur). `host.prepare` et `host.install_docker` restent hors de ce
  // régime : Docker, lui, est requis en amont (contrôlé plus haut) et ne se réinstalle pas.
  const etapes: PlanStep[] = []
  const caddyMissing = !caddyAlreadyInstalled(server)

  if (classification.regime !== "skynode") {
    etapes.push({ type: "host.prepare", swap_mo: swapMo(server) })

    if (classification.regime === "vierge") {
      etapes.push({ type: "host.install_docker" })
    }
  }

  if (caddyMissing) {
    etapes.push({ type: "proxy.caddy.install" })
  }

  if (generatedStep) etapes.push(generatedStep)

  etapes.push({
    type: "build.image",
    source: { type: "local", path: "." },
    tag: `skynode/${options.application}`,
  })

  // `options.envFile` a déjà passé `pathEscapes()` à l'entrée de cette fonction, sur le
  // même motif que `plan-validate.ts`. C'est `apply_plan` (spec §6.1.6, tâche 5) qui
  // revalide `depuis` avant toute écriture — un plan peut être modifié et resoumis entre
  // les deux (spec §5.1) — mais rien ici ne compose plus un chemin que le validateur
  // refuserait.
  if (options.envFile !== undefined) {
    etapes.push({ type: "env.write", depuis: options.envFile })
  }

  etapes.push({ type: "app.run", port_interne: port, reseau: ALLOWED_NETWORK })

  if (options.domaine !== undefined) {
    etapes.push({ type: "proxy.caddy.site", domaine: options.domaine })
  }

  etapes.push({ type: "state.record" })

  const empreinte_etat = computeFingerprint(server, classification)
  const id = derivePlanId(empreinte_etat, options.application, etapes)

  // `classification.blockers` (`regime.ts`) signale ce qui gênerait un déploiement même
  // en régime exécutable — un disque plein, une mémoire trop courte pour une construction
  // Docker. `plan-render.ts` pose l'invariant : le développeur n'approuve que ce texte,
  // rien d'autre. Un plan qui les tairait se présenterait confiant sur une machine que
  // `classify()` a déjà jugée fragile.
  const horsPerimetre = [...classification.blockers, "aucune sauvegarde n'est configurée"]
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
      resume: buildResume(
        classification.regime,
        caddyMissing,
        dockerfileProvided,
        generatedStep,
        project,
        options
      ),
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
  caddyMissing: boolean,
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
  } else if (regime === "skynode" && caddyMissing) {
    // Le cas d'équipement de l'axe B : la machine est gérée par SkyNode mais son
    // conteneur Caddy a disparu depuis — on le repose plutôt que de refuser.
    parts.push("réinstaller Caddy, absent de la machine")
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
