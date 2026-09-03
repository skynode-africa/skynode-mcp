import { generateDockerfile, generateDockerignore } from "./dockerfile.js"
import { APPLICATION_PATTERN, exigeMotif, exigeType } from "./plan-rules.js"
import type { PlanStep } from "./plan-types.js"
import { shellQuote, writeFileScript } from "./remote.js"
import type { StepContext, StepRecipe } from "./step.js"
import { PREAMBULE, REPERTOIRE_SKYNODE } from "./steps-host.js"
import { exigeRepertoireDeTravail } from "./transfer.js"

/**
 * Les deux étapes de la construction : le `Dockerfile` (`build.generate_dockerfile`) et
 * l'image elle-même (`build.image`).
 *
 * Les deux travaillent dans l'**arborescence transférée** (`ctx.workDir`), jamais dans le
 * dépôt du développeur — ce module n'écrit rien sur la machine de qui l'appelle. C'est le
 * transfert (`transfer.ts`) qui a posé cette arborescence, sans les fichiers d'environnement
 * ni les dépendances installées.
 *
 * Quatre choses gouvernent ce module :
 *
 * - **On n'écrit jamais par-dessus un humain.** Un `Dockerfile` trouvé dans l'arborescence
 *   est celui du client : on le garde et on construit avec. La même règle vaut pour son
 *   `.dockerignore`.
 * - **L'étiquette porte le condensat du contenu transféré.** Deux déploiements de contenus
 *   identiques donnent la même étiquette — donc `unchanged`, sans reconstruction — et deux
 *   contenus différents donnent deux images qui coexistent.
 * - **Les trois dernières images restent** (spec §6.3). C'est ce qui rend `rollback`
 *   possible, et donc ce qui fait qu'un développeur ose déployer. Le reste est élagué, et
 *   jamais au-delà du dépôt de cette application.
 * - **Le journal de construction est borné.** Un `docker build` verbeux noierait le contexte
 *   de l'agent ; il part sur `stderr`, jamais dans `/dev/null` — c'est lui qui explique une
 *   panne, et `runRemote` le joint au diagnostic.
 */

/* ------------------------------------------------------------------------ constantes --- */

/**
 * Le dépôt d'images du produit. Les étiquettes du plan (`TAG_PATTERN`, `plan-validate.ts`)
 * ne sortent pas de ce préfixe : ni registre tiers, ni chemin arbitraire.
 */
export const PREFIXE_IMAGE = "skynode"

/** Spec §6.3 : au-delà, une image ne sert plus à revenir en arrière, elle occupe un disque. */
export const IMAGES_CONSERVEES = 3

/**
 * La longueur du condensat retenue dans l'étiquette.
 *
 * Douze caractères hexadécimaux — 48 bits — sont assez pour qu'une collision entre deux
 * versions d'une même application soit hors de portée, et assez courts pour qu'un humain
 * lise `skynode/boutique:3f0a91c2b7de` dans un rapport sans y perdre la ligne.
 */
export const LONGUEUR_CONDENSAT = 12

/**
 * Ce que l'on garde du journal de construction quand elle échoue. Quarante lignes ne
 * porteraient pas toujours la trace d'une compilation ratée ; deux mille noieraient l'agent.
 */
export const LIGNES_JOURNAL = 60

/**
 * Le répertoire de sortie que le gabarit statique de Node suppose faute de champ dans
 * l'étape.
 *
 * `BuildGenerateDockerfile` est `.strict()` et ne porte pas de `repertoire` : `nodeStatic`
 * (`dockerfile.ts`) retombe donc sur `dist`, et le `.dockerignore` doit le réintroduire —
 * sinon le fichier qui exclut et le `Dockerfile` qui recopie s'annulent l'un l'autre. Les
 * deux valeurs doivent bouger ensemble ; un test de ce module les confronte.
 */
export const REPERTOIRE_STATIQUE_PAR_DEFAUT = "dist"

/**
 * Le seul `source.path` que le produit sait honorer : la racine du projet.
 *
 * `plan-compose.ts` n'en émet jamais d'autre, mais un plan n'est pas tenu de venir de lui
 * (spec §5.1) — c'est la recette qui doit refuser, pas le composeur qui doit bien se tenir.
 */
export const RACINE_PROJET = "."

const q = shellQuote

/* ------------------------------------------------------------------------- garde-fous --- */

/**
 * Le dépôt d'image d'une application. **Le nom vient de `ctx.application`, pas de
 * `etape.tag`.**
 *
 * `AppRun` est `{ type, port_interne, reseau }` en `.strict()` et `ProxyCaddySite`
 * `{ type, domaine }` : aucune des deux ne porte de nom d'image ni de conteneur, toutes deux
 * désignent l'application par `ctx.application`. Une image nommée d'après un champ que
 * personne d'autre ne lit permettrait de construire `skynode/a` et de démarrer `skynode/b` —
 * l'application paraîtrait déployée et ne le serait pas.
 *
 * `plan-validate.ts` borne déjà `tag` à `skynode/<nom>` et `plan-compose.ts` n'émet jamais
 * autre chose que `skynode/${application}` : dans tout plan que ce produit compose, la valeur
 * dérivée et la valeur déclarée coïncident. Le jour où une application devra produire
 * plusieurs images, c'est `app.run` qu'il faudra élargir d'abord — pas cette dérivation.
 *
 * `APPLICATION_PATTERN` est le contrôle qui autorise l'interpolation de ce nom dans les
 * scripts plus bas (invariant n°1).
 */
export function depotImage(application: string): string {
  return `${PREFIXE_IMAGE}/${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}`
}

/**
 * Referme le vocabulaire de `source.type` **à l'exécution**, là où le schéma ne le referme
 * qu'à la compilation.
 *
 * `BuildImageSource` est `z.literal("local")` en `.strict()`, et le jalon 3a avait laissé
 * ouverte la question de savoir si `plan-validate.ts` devait le revérifier. La réponse est
 * ici : une recette est appelable directement — `recipeFor("build.image").script(…)` ne passe
 * ni par `parsePlan` ni par `validatePlan` — donc c'est **ce** point, et lui seul, qui ne se
 * contourne pas. Le refuser au validateur en plus ne fermerait rien de neuf.
 *
 * Le `default` est inaccessible au compilateur et accessible à l'exécution : l'affectation à
 * `never` fait échouer la compilation le jour où une seconde source entrera dans le schéma,
 * ce qui obligera à décider ici ce qu'elle veut dire.
 */
export function exigeSourceLocale(step: Extract<PlanStep, { type: "build.image" }>): void {
  switch (step.source.type) {
    case "local":
      // **Et le chemin, pas seulement le type.** `plan-render.ts` écrit « construire l'image
      // X depuis <path> » : c'est ce texte que le développeur approuve. Or le transfert
      // envoie la racine du projet entière et rien d'autre — un `path` de sous-répertoire
      // ferait approuver « depuis apps/web » et construire le dépôt complet. Tant que le
      // transfert ne sait pas viser un sous-arbre, le seul chemin honnête est la racine.
      if (step.source.path !== RACINE_PROJET) {
        throw new Error(
          `La construction depuis « ${step.source.path} » n'est pas encore possible : le projet est ` +
            "transféré depuis sa racine, et ce plan annoncerait un sous-répertoire que rien " +
            `n'irait chercher. Composer le plan avec « ${RACINE_PROJET} », ou déployer ce ` +
            "sous-projet depuis sa propre racine."
        )
      }

      return
    default: {
      const inconnue: never = step.source.type
      throw new Error(
        `La source de construction « ${String(inconnue)} » n'appartient pas au vocabulaire fermé : ` +
          "seule « local » est connue, et une source inconnue ne se devine pas."
      )
    }
  }
}

/**
 * Le répertoire que le transfert doit préserver pour cette étape, ou `null`.
 *
 * Exporté pour l'exécuteur (tâche 8) : c'est lui qui transfère, avant que la moindre recette
 * ne s'exécute, et la valeur se lit dans l'étape `build.generate_dockerfile` du même plan.
 * Sans cet accès, le transfert exclurait `dist` et le gabarit statique recopierait un
 * répertoire absent.
 */
/**
 * Refuse une étiquette que l'étape ne posera pas.
 *
 * `depotImage` dérive le dépôt de `ctx.application` — pour de bonnes raisons, expliquées
 * plus haut — et ignore `etape.tag`. Mais `plan-render.ts` **montre** `etape.tag` au
 * développeur, et `plan-validate.ts` ne borne cette valeur qu'à la forme `skynode/…` sans
 * la rattacher à l'application. Un plan déclarant `skynode/autre` ferait donc approuver la
 * construction d'une image, et en construirait une autre. On refuse plutôt que de laisser
 * diverger le texte approuvé et le geste posé.
 */
export function exigeEtiquetteAttendue(
  step: Extract<PlanStep, { type: "build.image" }>,
  application: string
): void {
  const attendu = depotImage(application)

  // Le plan peut nommer le dépôt seul (`skynode/boutique`) ou porter une étiquette
  // explicite (`skynode/boutique:latest`) : c'est le dépôt qui doit coïncider, l'étiquette
  // effective étant toujours le condensat du contenu transféré.
  const depotDeclare = step.tag.includes(":") ? step.tag.slice(0, step.tag.indexOf(":")) : step.tag

  if (depotDeclare !== attendu) {
    throw new Error(
      `Le plan annonce l'image « ${step.tag} » alors que l'application « ${application} » produit ` +
        `« ${attendu} » : le texte approuvé et l'image construite ne coïncideraient pas. ` +
        "Recomposer le plan pour cette application."
    )
  }
}

export function repertoireAPreserver(step: PlanStep): string | null {
  if (step.type !== "build.generate_dockerfile") return null

  return step.famille === "node" && step.sortie === "static" ? REPERTOIRE_STATIQUE_PAR_DEFAUT : null
}

/** Les paramètres du gabarit, tirés de l'étape et d'elle seule. */
function parametresDockerfile(step: Extract<PlanStep, { type: "build.generate_dockerfile" }>) {
  return {
    famille: step.famille,
    sortie: step.sortie,
    version: step.version,
    gestionnaire: step.gestionnaire,
    port: step.port,
    // Le champ n'existe pas dans l'étape ; `generateDockerfile` retombe sur ses propres
    // défauts, que `repertoireAPreserver` reproduit pour le transfert.
    repertoire: null,
  }
}

/** Le préambule commun, plus le refus de travailler sans arborescence transférée. */
function enTete(workDir: string, quoi: string): string[] {
  return [
    ...PREAMBULE,
    `if [ ! -d ${q(workDir)} ]; then`,
    "  echec " +
      q(
        `Aucune arborescence dans ${workDir} : le projet n'a pas été transféré, il n'y a rien à ${quoi}.`
      ),
    "fi",
  ]
}

/* --------------------------------------------------------------- generate_dockerfile --- */

/**
 * Écrit un fichier dans l'arborescence transférée **s'il n'y est pas déjà**.
 *
 * Les lignes de `writeFileScript` ne sont pas indentées, et ce n'est pas cosmétique : le
 * délimiteur de fermeture de son heredoc doit occuper la colonne zéro. Décalé, il cesse
 * d'être reconnu, le heredoc avale le reste du script et le contenu écrit gagne deux espaces
 * par ligne que le contrôle d'octets rejette.
 */
function sectionFichier(chemin: string, contenu: string, quoi: string, garde: string): string[] {
  return [
    `if [ -f ${q(chemin)} ]; then`,
    "  note " + q(`${quoi} fourni avec le projet : conservé tel quel, rien n'a été écrit par-dessus.`),
    "else",
    ...writeFileScript(chemin, contenu, "0644", "echec " + q(garde)).split("\n"),
    "  note " + q(`${quoi} engendré dans le répertoire de travail.`),
    "  applique=oui",
    "fi",
  ]
}

function scriptGenerate(step: Extract<PlanStep, { type: "build.generate_dockerfile" }>, workDir: string): string {
  const dockerfile = `${workDir}/Dockerfile`
  const dockerignore = `${workDir}/.dockerignore`

  return [
    ...enTete(workDir, "construire"),

    ...sectionFichier(
      dockerfile,
      generateDockerfile(parametresDockerfile(step)),
      "Dockerfile",
      `Écriture interrompue : ${dockerfile} est incomplet, il a été retiré et rien n'a été construit.`
    ),
    ...sectionFichier(
      dockerignore,
      generateDockerignore(repertoireAPreserver(step)),
      ".dockerignore",
      `Écriture interrompue : ${dockerignore} est incomplet, il a été retiré et rien n'a été construit.`
    ),

    'if [ "$applique" = oui ]; then',
    '  fin applied "$detail"',
    "fi",
    "fin unchanged " +
      q("Dockerfile et .dockerignore étaient déjà dans l'arborescence transférée : rien à écrire."),
  ].join("\n")
}

/**
 * L'annulation ne retire un fichier que s'il est **exactement** celui qu'on aurait écrit.
 *
 * Un `Dockerfile` du client se trouve, lui aussi, dans l'arborescence transférée : le retirer
 * sans regarder reviendrait à effacer le travail d'un humain pour défaire le nôtre. On
 * réécrit donc le contenu de référence dans un brouillon sous `/etc/skynode` — en 0600, hors
 * du contexte de construction — et on ne supprime qu'après un `cmp` concluant.
 */
function sectionRetraitSiIdentique(chemin: string, contenu: string, quoi: string, brouillon: string): string[] {
  return [
    ...writeFileScript(brouillon, contenu, "0600", "echec " + q(`Comparaison impossible : ${brouillon} n'a pas pu être écrit.`)).split("\n"),
    `if cmp -s ${q(brouillon)} ${q(chemin)}; then`,
    `  rm -f ${q(chemin)} || echec ` + q(`Suppression de ${chemin} impossible.`),
    "  note " + q(`${quoi} engendré par SkyNode retiré de l'arborescence de travail.`),
    "  applique=oui",
    "fi",
    `rm -f ${q(brouillon)}`,
  ]
}

function scriptGenerateUndo(step: Extract<PlanStep, { type: "build.generate_dockerfile" }>, workDir: string): string {
  return [
    ...PREAMBULE,

    // `install -d` créerait les répertoires manquants **au mode demandé** : un `/etc/skynode`
    // absent naîtrait en 0755 alors qu'il porte des secrets. On le crée à son mode à lui.
    `if [ ! -d ${q(REPERTOIRE_SKYNODE)} ]; then`,
    `  install -d -m 0700 -o root -g root ${q(REPERTOIRE_SKYNODE)} || echec ` +
      q(`Création de ${REPERTOIRE_SKYNODE} impossible.`),
    "fi",

    `if [ -d ${q(workDir)} ]; then`,
    ...sectionRetraitSiIdentique(
      `${workDir}/Dockerfile`,
      generateDockerfile(parametresDockerfile(step)),
      "Dockerfile",
      `${REPERTOIRE_SKYNODE}/.brouillon-dockerfile-defait`
    ),
    ...sectionRetraitSiIdentique(
      `${workDir}/.dockerignore`,
      generateDockerignore(repertoireAPreserver(step)),
      ".dockerignore",
      `${REPERTOIRE_SKYNODE}/.brouillon-dockerignore-defait`
    ),
    "fi",

    'if [ "$applique" = oui ]; then',
    '  fin applied "$detail"',
    "fi",
    "fin unchanged " +
      q("Aucun fichier engendré par SkyNode dans l'arborescence de travail : rien à défaire."),
  ].join("\n")
}

/* -------------------------------------------------------------------------- image --- */

/**
 * Le condensat du contenu transféré, calculé **sur le serveur** : c'est ce qui s'y trouve
 * vraiment qui compte, pas ce que la machine du développeur croit avoir envoyé.
 *
 * Le nom de chaque fichier entre dans le calcul en même temps que son contenu — `sha256sum`
 * imprime les deux —, sans quoi un simple renommage donnerait la même étiquette pour une
 * arborescence différente. `LC_ALL=C sort` fixe l'ordre indépendamment de la locale du
 * serveur : un tri dépendant de la locale rendrait l'étiquette différente d'une machine à
 * l'autre pour un contenu identique.
 */
function sectionCondensat(workDir: string): string[] {
  return [
    `sha=$(cd ${q(workDir)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | ` +
      `sha256sum | cut -c1-${String(LONGUEUR_CONDENSAT)})`,

    // Ce condensat entre dans l'étiquette de l'image, donc dans une ligne de commande jouée
    // en root : il vient d'une commande du serveur, pas de `plan-rules.ts`. Le borner à
    // douze caractères hexadécimaux est le contrôle qui autorise son interpolation.
    'case "$sha" in',
    '  ""|*[!0-9a-f]*) echec ' +
      q("Le condensat de l'arborescence transférée n'est pas hexadécimal : aucune image ne peut être étiquetée.") +
      " ;;",
    "esac",
    `if [ "\${#sha}" -ne ${String(LONGUEUR_CONDENSAT)} ]; then`,
    "  echec " +
      q("Le condensat de l'arborescence transférée n'a pas la longueur attendue : aucune image ne peut être étiquetée."),
    "fi",
  ]
}

function scriptImage(application: string, workDir: string): string {
  const depot = depotImage(application)
  const journal = `${REPERTOIRE_SKYNODE}/.journal-construction-${application}`

  return [
    ...enTete(workDir, "construire"),

    // Docker est un prérequis de cette étape, pas quelque chose qu'elle installe :
    // `plan-validate.ts` exige déjà `host.install_docker` plus haut dans le plan, ou Docker
    // constaté utilisable. Le redire ici évite de rendre `failed` sur un `docker` introuvable,
    // ce qui enverrait chercher le défaut du mauvais côté.
    "if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then",
    "  echec " +
      q("Docker ne répond pas à « docker info » : cette étape suppose un moteur de conteneurs en marche."),
    "fi",

    `if [ ! -f ${q(`${workDir}/Dockerfile`)} ]; then`,
    "  echec " +
      q(
        "Aucun Dockerfile dans l'arborescence transférée : jouer build.generate_dockerfile " +
          "avant cette étape, ou committer un Dockerfile dans le projet."
      ),
    "fi",

    ...sectionCondensat(workDir),

    `image=${q(`${depot}:`)}"$sha"`,

    // Rejouée sur un contenu identique, l'étape sort ici : l'image porte le condensat de ce
    // qu'elle contient, donc une image déjà présente sous cette étiquette **est** celle
    // qu'on allait construire. Reconstruire ne changerait rien et coûterait des minutes.
    'if docker image inspect "$image" >/dev/null 2>&1; then',
    '  fin unchanged "L\'image $image existe déjà : contenu identique, rien à reconstruire."',
    "fi",

    `if [ ! -d ${q(REPERTOIRE_SKYNODE)} ]; then`,
    `  install -d -m 0700 -o root -g root ${q(REPERTOIRE_SKYNODE)} || echec ` +
      q(`Création de ${REPERTOIRE_SKYNODE} impossible.`),
    "fi",

    // Le journal va dans un fichier, pas sur la sortie standard : celle-ci porte le protocole
    // d'étape que `runRemote` lit. Et pas dans le répertoire de travail : Docker le lit comme
    // contexte de construction pendant que le journal s'y écrirait.
    `if ! docker build --tag "$image" --label ${q(`skynode.app=${application}`)} ` +
      `--file ${q(`${workDir}/Dockerfile`)} ${q(workDir)} > ${q(journal)} 2>&1; then`,
    `  tail -n ${String(LIGNES_JOURNAL)} ${q(journal)} >&2`,
    `  rm -f ${q(journal)}`,
    // Rien à défaire : une construction échouée ne laisse pas d'image étiquetée. Les couches
    // intermédiaires restent au cache de Docker, qui les réutilisera au prochain essai — les
    // jeter rendrait chaque nouvelle tentative aussi longue que la première.
    "  echec " +
      q(
        `La construction de l'image a échoué. Les ${LIGNES_JOURNAL} dernières lignes du journal ` +
          "sont jointes au diagnostic ; aucune image n'a été étiquetée."
      ),
    "fi",
    `rm -f ${q(journal)}`,

    'note "Image $image construite depuis l\'arborescence transférée."',
    "applique=oui",

    // L'élagage vient **après** la construction, pour que la nouvelle image compte parmi les
    // conservées. `docker images` rend le dépôt du plus récent au plus ancien, et les
    // `IMAGES_CONSERVEES` premières restent (spec §6.3) : c'est ce qui rend `rollback`
    // possible.
    //
    // **Mais il compte des images, pas des étiquettes.** Deux passages dont seul le contexte
    // de construction diffère produisent souvent une image finale identique au bit près —
    // Docker lui donne alors un seul identifiant sous deux étiquettes, à la même date. Le
    // classement par date ne les départage plus, et `docker images` retombe sur l'ordre des
    // étiquettes : mesuré sur le banc, l'étape a désétiqueté l'image qu'elle venait
    // d'annoncer construite, laissant `app.run` chercher une image qui n'existait plus. On
    // retient donc les `IMAGES_CONSERVEES` premiers **identifiants distincts**, et l'image de
    // ce passage n'est jamais candidate.
    //
    // Le découpage en mots est voulu : une étiquette de ce dépôt est
    // `skynode/<application>:<douze caractères hexadécimaux>`, deux formes que
    // `APPLICATION_PATTERN` et le contrôle du condensat bornent — aucune ne porte d'espace.
    "recents=''",
    "vus=0",
    `for identifiant in $(docker images ${q(depot)} --format '{{.ID}}' 2>/dev/null); do`,
    '  case " $recents " in *" $identifiant "*) continue ;; esac',
    '  recents="$recents $identifiant"',
    "  vus=$((vus + 1))",
    `  if [ "$vus" -ge ${String(IMAGES_CONSERVEES)} ]; then break; fi`,
    "done",

    "elaguees=0",
    `for couple in $(docker images ${q(depot)} --format '{{.ID}}|{{.Repository}}:{{.Tag}}' 2>/dev/null | ` +
      `grep -v ${q(":<none>$")}); do`,
    "  identifiant=${couple%%|*}",
    "  vieille=${couple#*|}",
    // L'image de ce passage n'est jamais élaguée, quel que soit l'ordre rendu par Docker :
    // l'étape vient de l'annoncer construite, et la retirer ici ferait mentir son propre
    // compte rendu.
    '  if [ "$vieille" = "$image" ]; then continue; fi',
    '  case " $recents " in *" $identifiant "*) continue ;; esac',
    // Un `docker rmi` refusé est presque toujours une image que sert un conteneur en marche :
    // Docker se protège lui-même, et l'échec n'en est pas un pour cette étape. On ne fait pas
    // échouer un déploiement réussi pour du ménage.
    '  if docker rmi "$vieille" >&2 2>&1; then',
    "    elaguees=$((elaguees + 1))",
    "  fi",
    "done",
    'if [ "$elaguees" -gt 0 ]; then',
    `  note "$elaguees image(s) plus ancienne(s) élaguée(s) ; les ${IMAGES_CONSERVEES} dernières sont conservées pour un retour arrière."`,
    "fi",

    'fin applied "$detail"',
  ].join("\n")
}

/**
 * L'annulation retire **l'image de ce passage, et elle seule**.
 *
 * L'étiquette n'est pas mémorisée : elle se recalcule depuis l'arborescence de travail, qui
 * est encore là quand l'exécuteur défait les étapes d'un même passage. Un état écrit quelque
 * part serait une chose de plus à tenir à jour, et fausse le jour où elle ne l'est pas.
 *
 * Les images précédentes ne sont jamais touchées — ce sont elles que `rollback` ramène.
 */
function scriptImageUndo(application: string, workDir: string): string {
  const depot = depotImage(application)

  return [
    ...PREAMBULE,

    "if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then",
    "  fin unchanged " +
      q("Docker ne répond pas : aucune image ne peut être retirée, et aucune ne l'a été."),
    "fi",

    `if [ ! -f ${q(`${workDir}/Dockerfile`)} ]; then`,
    "  echec " +
      q(
        `L'arborescence de travail a disparu : l'étiquette construite ne peut plus être recalculée. ` +
          `Inspecter « docker images ${depot} » et retirer à la main l'image la plus récente si elle est de trop.`
      ),
    "fi",

    ...sectionCondensat(workDir),

    `image=${q(`${depot}:`)}"$sha"`,

    'if ! docker image inspect "$image" >/dev/null 2>&1; then',
    '  fin unchanged "Aucune image $image sur cette machine : rien à défaire."',
    "fi",

    'if docker rmi "$image" >&2 2>&1; then',
    '  note "Image $image retirée ; les versions précédentes sont intactes."',
    "  applique=oui",
    "else",
    "  echec " +
      q(
        "L'image de ce passage n'a pas pu être retirée : un conteneur en marche s'en sert " +
          "probablement encore. Aucune image précédente n'a été touchée."
      ),
    "fi",

    'fin applied "$detail"',
  ].join("\n")
}

/* ------------------------------------------------------------------------- recettes --- */

export const RECETTE_BUILD_GENERATE_DOCKERFILE: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: StepContext): string {
    return scriptGenerate(exigeType(step, "build.generate_dockerfile"), exigeRepertoireDeTravail(ctx.workDir))
  },
  undoScript(step: PlanStep, ctx: StepContext): string {
    return scriptGenerateUndo(exigeType(step, "build.generate_dockerfile"), exigeRepertoireDeTravail(ctx.workDir))
  },
})

export const RECETTE_BUILD_IMAGE: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: StepContext): string {
    const etape = exigeType(step, "build.image")
    exigeSourceLocale(etape)
    exigeEtiquetteAttendue(etape, ctx.application)

    return scriptImage(ctx.application, exigeRepertoireDeTravail(ctx.workDir))
  },
  undoScript(step: PlanStep, ctx: StepContext): string {
    const etape = exigeType(step, "build.image")
    exigeSourceLocale(etape)
    exigeEtiquetteAttendue(etape, ctx.application)

    return scriptImageUndo(ctx.application, exigeRepertoireDeTravail(ctx.workDir))
  },
})
