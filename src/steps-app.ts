import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { ALLOWED_NETWORK, APPLICATION_PATTERN, exigeMotif, exigeType, pathEscapes } from "./plan-rules.js"
import type { PlanStep } from "./plan-types.js"
import { shellQuote, writeFileScript } from "./remote.js"
import type { StepContext, StepRecipe } from "./step.js"
import { PREAMBULE, REPERTOIRE_SKYNODE } from "./steps-host.js"
import { ETIQUETTE_PORT, REPERTOIRE_SITES } from "./steps-proxy.js"
import { depotImage, LONGUEUR_CONDENSAT } from "./steps-build.js"
import { exigeRepertoireDeTravail } from "./transfer.js"

/**
 * Les trois dernières étapes d'un déploiement : l'environnement (`env.write`), le conteneur
 * (`app.run`) et l'état laissé sur la machine (`state.record`).
 *
 * Quatre choses gouvernent ce module :
 *
 * - **Le contenu du fichier d'environnement ne sort jamais.** Il vient de la machine du
 *   développeur et porte ses secrets : il entre dans le script par un heredoc quoté, il
 *   n'apparaît dans aucun `printf`, dans aucun message d'échec, dans aucun diagnostic. Un
 *   `step.detail` qui le mentionnerait remonterait tel quel à l'agent, donc au modèle.
 * - **On ne touche jamais un conteneur qui n'est pas le notre** (invariant n°2). Un
 *   conteneur portant le nom de l'application mais pas l'étiquette `skynode.app` appartient
 *   à quelqu'un d'autre : l'étape échoue plutôt que de le remplacer.
 * - **L'étiquette du port est posée ici.** `proxy.caddy.site` la lit sur le conteneur pour
 *   savoir où router (`steps-proxy.ts`) : sans elle, une image exposant plusieurs ports rend
 *   la publication impossible, et l'étape suivante échouerait pour une raison née ici.
 * - **L'état est constaté, pas déclaré.** `state.record` interroge Docker et le répertoire
 *   des sites plutôt que de recopier ce que le plan annonçait : un plan dont une étape a été
 *   défaite laisserait sinon un état qui décrit une machine qui n'existe pas.
 */

/* ------------------------------------------------------------------------ constantes --- */

/**
 * Où vit le fichier d'environnement d'une application.
 *
 * Sous `/etc/skynode`, qui est en 0700 root — donc hors de portée de tout compte non
 * privilégié, y compris le compte applicatif. C'est voulu : `--env-file` est lu par le
 * **client** Docker, qui tourne en root, pas par le conteneur. Un `chown skynode` sur ce
 * fichier suggérerait un accès que le répertoire parent interdit de toute façon, et
 * l'affaiblirait pour rien.
 */
export const REPERTOIRE_ENV = `${REPERTOIRE_SKYNODE}/env`

/** L'état de la machine, à l'emplacement que la sonde lit déjà (`probe.ts`). */
export const CHEMIN_ETAT = `${REPERTOIRE_SKYNODE}/state.json`

/**
 * L'état par application, dont `CHEMIN_ETAT` n'est que l'assemblage.
 *
 * Fusionner du JSON en `sh` demanderait de l'analyser, ce qu'aucun outil garanti présent sur
 * une Ubuntu nue ne sait faire — `jq` n'est pas installé, et l'installer pour cela seul
 * serait une dépendance de plus sur la machine du client. Un fichier par application ramène
 * la fusion à une concaténation : l'état d'une autre application ne peut pas disparaître,
 * puisque rien ne le relit jamais. Même raisonnement que les fichiers de site de Caddy.
 */
export const REPERTOIRE_ETAT = `${REPERTOIRE_SKYNODE}/state.d`

/**
 * L'étiquette qui distingue nos conteneurs de ceux d'un tiers.
 *
 * `build.image` la pose déjà sur l'image (`steps-build.ts`) ; c'est sur le **conteneur**
 * qu'elle sert ici, parce que c'est le conteneur qu'on s'autorise à remplacer.
 */
export const ETIQUETTE_APP = "skynode.app"

/**
 * Le temps laissé au conteneur pour mourir de lui-même avant qu'on le déclare démarré.
 *
 * Un processus qui manque une variable d'environnement, ou qui ne trouve pas sa base, sort
 * en une seconde ou deux. `docker run -d` rend la main aussitôt et sans erreur : sans cette
 * attente, l'étape annoncerait « démarré » un conteneur déjà mort, et c'est `proxy.caddy.site`
 * — l'étape suivante — qui échouerait, en désignant le mauvais coupable.
 */
export const ATTENTE_DEMARRAGE_S = 3

/** Ce qu'on joint au diagnostic quand le conteneur est mort : assez pour voir la cause. */
export const LIGNES_JOURNAL_APP = 40

const q = shellQuote

/* ------------------------------------------------------------------------- garde-fous --- */

/** Le fichier d'environnement d'une application, nommé d'après elle et elle seule. */
export function cheminEnv(application: string): string {
  return `${REPERTOIRE_ENV}/${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}.env`
}

/** L'état d'une application, dans le répertoire que `state.record` assemble. */
export function cheminEtat(application: string): string {
  return `${REPERTOIRE_ETAT}/${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}.json`
}

/**
 * Referme le réseau **à l'exécution**, là où le schéma ne borne qu'une longueur.
 *
 * `AppRun.reseau` est un `z.string()` : le schéma accepterait `host`, qui ferait tomber le
 * conteneur dans la pile réseau de la machine — tous ses ports publiés d'un coup, sans qu'une
 * seule ligne du plan rendu à l'humain ne le laisse voir. `plan-validate.ts` le borne déjà,
 * mais une recette s'appelle sans passer par lui : c'est ce contrôle-ci qui ne se contourne
 * pas, et c'est lui qui autorise l'interpolation du réseau plus bas.
 */
export function exigeReseauAutorise(reseau: string): string {
  if (reseau !== ALLOWED_NETWORK) {
    throw new Error(
      `Le réseau « ${reseau} » n'est pas celui du produit (${ALLOWED_NETWORK}) : aucun conteneur ne peut être ` +
        "démarré ailleurs, un autre réseau exposerait l'application hors du proxy."
    )
  }

  return reseau
}

/**
 * Referme le port **à l'exécution**, comme le réseau juste au-dessus.
 *
 * `AppRun.port_interne` est un entier borné par le schéma, mais une recette s'appelle sans
 * schéma. Ce contrôle est celui qui autorise l'interpolation du port dans l'étiquette du
 * conteneur — étiquette que `proxy.caddy.site` relit ensuite pour composer une directive
 * Caddy, donc une valeur qui traverse deux étapes.
 */
export function exigePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `« ${String(port)} » n'est pas un port TCP valide : aucun conteneur ne peut être étiqueté avec cette valeur.`
    )
  }

  return port
}

/** Le préambule, plus les deux prérequis que toute étape de ce module partage. */
function enTeteDocker(workDir: string): string[] {
  return [
    ...PREAMBULE,

    // Docker est un prérequis de ces étapes, pas quelque chose qu'elles installent :
    // `plan-validate.ts` exige déjà `host.install_docker` plus haut dans le plan, ou Docker
    // constaté utilisable. Le redire ici évite de rendre `failed` sur un `docker` introuvable,
    // ce qui enverrait chercher le défaut du mauvais côté.
    "if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then",
    "  echec " +
      q("Docker ne répond pas à « docker info » : cette étape suppose un moteur de conteneurs en marche."),
    "fi",

    `if [ ! -d ${q(workDir)} ]; then`,
    "  echec " +
      q(
        `Aucune arborescence dans ${workDir} : l'étiquette de l'image ne peut pas être recalculée, ` +
          "et rien ne garantirait que le conteneur démarre sur l'image que le plan annonce."
      ),
    "fi",
  ]
}

/**
 * Lit le fichier d'environnement **sur la machine du développeur**, à l'instant où le script
 * se compose.
 *
 * C'est le seul contenu d'étape qui ne se dérive pas du plan : il faut bien qu'il traverse
 * le réseau, et le transfert l'exclut à dessein — `.env` est dans le `.dockerignore`, donc
 * hors de l'archive et hors du contexte de construction. Il n'a rien à faire dans une image,
 * il n'a rien à faire non plus dans le répertoire de travail : il va dans `/etc/skynode/env`,
 * en 0600, et le conteneur le reçoit par `--env-file`.
 *
 * `pathEscapes` est revérifié ici bien que `plan-validate.ts` le fasse déjà : une recette est
 * appelable directement, et c'est ce chemin-là qui aboutit à un `readFileSync`. C'est ce
 * contrôle qui autorise la jointure avec `projectRoot` — et la comparaison finale des chemins
 * résolus le confirme, parce qu'un lien symbolique ne se voit pas dans une chaîne.
 */
export function litFichierEnv(projectRoot: string, depuis: string): string {
  if (pathEscapes(depuis)) {
    throw new Error(
      `Le fichier d'environnement « ${depuis} » échappe à la racine du projet : un chemin absolu ou un ` +
        'segment ".." n\'est jamais accepté.'
    )
  }

  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `La racine du projet « ${projectRoot} » n'est pas un chemin absolu : le fichier d'environnement ne ` +
        "peut pas être localisé sans ambiguïté."
    )
  }

  // `pathEscapes` travaille sur la chaîne ; ceci travaille sur le fichier réel. Les deux sont
  // nécessaires, et le second ne double pas le premier : un chemin sans `..` et sans `/` en
  // tête peut désigner un **lien symbolique** qui sort du dépôt. Le cas n'est pas
  // hypothétique — le plan se compose à partir d'un dépôt que l'agent a lu, et un dépôt
  // hostile peut porter un `.env.production` pointant vers la clé SSH de qui le déploie. Sans
  // ce contrôle, l'étape l'enverrait sur le serveur, en 0600 et sans que rien ne le dise.
  let racine: string
  let cible: string
  try {
    racine = realpathSync(resolve(projectRoot))
    cible = realpathSync(resolve(racine, depuis))
  } catch {
    throw new Error(
      `Le fichier d'environnement « ${depuis} » est introuvable ou illisible sous la racine du projet : ` +
        "rien n'a été envoyé au serveur."
    )
  }

  if (cible !== racine && !cible.startsWith(`${racine}/`)) {
    throw new Error(
      `Le fichier d'environnement « ${depuis} » désigne un fichier hors de la racine du projet — un lien ` +
        "symbolique, le plus souvent. Rien n'a été envoyé au serveur."
    )
  }

  try {
    return readFileSync(cible, "utf8")
  } catch {
    // Le message nomme le chemin demandé, jamais le contenu ni la raison système : un
    // « permission denied » sur un fichier de secrets n'apprend rien d'utile à l'agent.
    throw new Error(
      `Le fichier d'environnement « ${depuis} » est introuvable ou illisible sous la racine du projet : ` +
        "rien n'a été envoyé au serveur."
    )
  }
}

/* -------------------------------------------------------------------------- env.write --- */

/**
 * Le répertoire des fichiers d'environnement, créé à son mode à lui.
 *
 * `install -d` créerait les répertoires manquants **au mode demandé** ; on ne s'en remet pas
 * à l'umask de la session pour un répertoire qui ne contiendra que des secrets.
 */
function sectionRepertoire(chemin: string): string[] {
  return [
    `if [ ! -d ${q(chemin)} ]; then`,
    `  install -d -m 0700 -o root -g root ${q(chemin)} || echec ` + q(`Création de ${chemin} impossible.`),
    "fi",
  ]
}

function scriptEnvWrite(contenu: string, application: string): string {
  const chemin = cheminEnv(application)
  const brouillon = `${REPERTOIRE_ENV}/.brouillon-${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}`

  return [
    ...PREAMBULE,
    ...sectionRepertoire(REPERTOIRE_SKYNODE),
    ...sectionRepertoire(REPERTOIRE_ENV),

    // Le brouillon sert à trancher l'idempotence sans jamais imprimer quoi que ce soit : on
    // écrit à côté, on compare, et on ne remplace que si le contenu a changé. Un `cat` du
    // fichier en place, ou un condensat imprimé, ferait sortir de la matière liée aux
    // secrets là où justement rien ne doit sortir.
    ...writeFileScript(brouillon, contenu, "0600", "echec " + q("Écriture du fichier d'environnement impossible : rien n'a été modifié.")).split("\n"),

    `if [ -f ${q(chemin)} ] && cmp -s ${q(brouillon)} ${q(chemin)}; then`,
    `  rm -f ${q(brouillon)}`,
    "  fin unchanged " + q("Le fichier d'environnement de l'application est déjà celui du projet : rien à écrire."),
    "fi",

    // `mv` sur le même système de fichiers est atomique : le conteneur ne peut pas lire un
    // fichier à moitié écrit, et un échec en cours de route laisse l'ancien intact.
    `mv -f ${q(brouillon)} ${q(chemin)} || { rm -f ${q(brouillon)}; echec ` +
      q("Mise en place du fichier d'environnement impossible : l'ancien est resté en place.") +
      "; }",
    `chmod 0600 ${q(chemin)} || echec ` + q("Le fichier d'environnement n'a pas pu être restreint à root : il a été laissé en place, à vérifier."),
    `chown root:root ${q(chemin)} || echec ` + q("Le propriétaire du fichier d'environnement n'a pas pu être fixé."),

    // Le détail nomme le chemin et le nombre de lignes, jamais une clé ni une valeur. Le
    // compte suffit à distinguer « le fichier attendu » de « le mauvais fichier ».
    `note "Fichier d'environnement écrit dans ${chemin} ($(wc -l < ${q(chemin)} | tr -d ' ') lignes), lisible par root seul."`,
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

function scriptEnvWriteUndo(application: string): string {
  const chemin = cheminEnv(application)

  return [
    ...PREAMBULE,

    `if [ ! -f ${q(chemin)} ]; then`,
    "  fin unchanged " + q("Aucun fichier d'environnement pour cette application : rien à défaire."),
    "fi",

    // Pas de `cmp` avec le contenu attendu, contrairement au `Dockerfile` de `build.image` :
    // ce fichier-ci n'existe que parce que SkyNode l'a écrit, il n'appartient à aucun humain,
    // et le comparer obligerait à réécrire les secrets sur le disque pour rien.
    `rm -f ${q(chemin)} || echec ` + q("Le fichier d'environnement n'a pas pu être supprimé."),
    "note " + q("Fichier d'environnement supprimé."),
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

/* --------------------------------------------------------------------------- app.run --- */

/**
 * L'étiquette de l'image de ce passage, recalculée depuis l'arborescence de travail.
 *
 * Exactement le calcul de `build.image` (`steps-build.ts`), et pour la même raison : rien
 * n'est mémorisé entre deux étapes, donc rien ne peut être périmé. Les deux sections doivent
 * bouger ensemble — un test de ce module les confronte.
 */
function sectionCondensat(workDir: string): string[] {
  return [
    `sha=$(cd ${q(workDir)} && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | ` +
      `sha256sum | cut -c1-${String(LONGUEUR_CONDENSAT)})`,

    // Ce condensat entre dans une ligne de commande jouée en root : il vient d'une commande
    // du serveur, pas de `plan-rules.ts`. Le borner à douze caractères hexadécimaux est le
    // contrôle qui autorise son interpolation.
    'case "$sha" in',
    '  ""|*[!0-9a-f]*) echec ' +
      q("Le condensat de l'arborescence transférée n'est pas hexadécimal : aucune image ne peut être démarrée.") +
      " ;;",
    "esac",
    `if [ "\${#sha}" -ne ${String(LONGUEUR_CONDENSAT)} ]; then`,
    "  echec " +
      q("Le condensat de l'arborescence transférée n'a pas la longueur attendue : aucune image ne peut être démarrée."),
    "fi",
  ]
}

/**
 * Refuse d'aller plus loin si un conteneur du même nom ne nous appartient pas.
 *
 * Le nom d'un conteneur est unique sur une machine : rien n'empêche un client d'avoir déjà
 * un `boutique` à lui. Le remplacer serait exactement ce que l'invariant n°2 interdit, et
 * l'échec doit le dire assez précisément pour qu'il sache quoi faire — renommer son
 * conteneur, ou déployer sous un autre nom.
 */
function sectionProprietaire(application: string): string[] {
  return [
    `if docker inspect ${application} >/dev/null 2>&1; then`,
    `  proprietaire=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_APP}"}}' ${application} 2>/dev/null)`,
    `  if [ "$proprietaire" != ${q(application)} ]; then`,
    "    echec " +
      q(
        `Un conteneur nommé « ${application} » existe déjà sur cette machine et ne porte pas ` +
          `l'étiquette ${ETIQUETTE_APP}=${application} : il n'a pas été posé par SkyNode et ne sera ` +
          "pas remplacé. Le renommer, ou déployer sous un autre nom d'application."
      ),
    "  fi",
    "  notre=oui",
    "else",
    "  notre=non",
    "fi",
  ]
}

function scriptAppRun(step: Extract<PlanStep, { type: "app.run" }>, ctx: StepContext): string {
  const application = exigeMotif(ctx.application, APPLICATION_PATTERN, "un nom d'application valide")
  const workDir = exigeRepertoireDeTravail(ctx.workDir)
  const reseau = exigeReseauAutorise(step.reseau)
  const depot = depotImage(application)
  const env = cheminEnv(application)

  // `port_interne` est un entier borné à 1..65535 par `AppRun` en `.strict()` et revérifié
  // par `plan-validate.ts` ; `String()` d'un entier de cette plage ne peut porter que des
  // chiffres. C'est ce qui autorise son interpolation dans l'étiquette et dans le script.
  const port = String(exigePort(step.port_interne))

  return [
    ...enTeteDocker(workDir),

    ...sectionCondensat(workDir),
    `image=${q(`${depot}:`)}"$sha"`,

    'if ! docker image inspect "$image" >/dev/null 2>&1; then',
    "  echec " +
      q(
        "Aucune image ne correspond à l'arborescence transférée : jouer build.image avant cette étape. " +
          "Une image construite depuis un autre contenu ne serait pas celle que le plan annonce."
      ),
    "fi",

    // Le réseau est interne et sans passerelle publiée : c'est Caddy, seul conteneur à
    // publier des ports, qui atteint l'application par son nom. `docker network create` sur
    // un réseau existant échoue ; on ne le crée que s'il manque, et on ne touche jamais à ses
    // réglages s'il est déjà là — il peut porter d'autres applications.
    `if ! docker network inspect ${reseau} >/dev/null 2>&1; then`,
    `  docker network create ${reseau} >&2 2>&1 || echec ` +
      q(`Le réseau ${reseau} n'a pas pu être créé : aucun conteneur n'a été démarré.`),
    `  note ${q(`Réseau ${reseau} créé.`)}`,
    "fi",

    ...sectionProprietaire(application),

    // Rejouée, l'étape sort ici. Trois conditions, et les trois comptent : le conteneur
    // tourne (un conteneur arrêté doit être relancé), il porte l'image de ce contenu (sinon
    // c'est une version précédente), et son étiquette de port est celle du plan (sinon
    // `proxy.caddy.site` router ait ailleurs que ce que le plan annonce).
    'if [ "$notre" = oui ]; then',
    `  courante=$(docker inspect -f '{{.Config.Image}}' ${application} 2>/dev/null)`,
    // `.State.Status`, pas `.State.Running`, pour la raison expliquée plus bas : un conteneur
    // en boucle de redémarrage rend `Running=true`, et l'étape le prendrait pour sain.
    `  marche=$(docker inspect -f '{{.State.Status}}' ${application} 2>/dev/null)`,
    `  porte=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_PORT}"}}' ${application} 2>/dev/null)`,
    `  if [ "$courante" = "$image" ] && [ "$marche" = running ] && [ "$porte" = ${q(port)} ]; then`,
    "    fin unchanged " +
      q(`Le conteneur « ${application} » tourne déjà sur cette image et ce port interne : rien à redémarrer.`),
    "  fi",

    // Le remplacement ne concerne que notre propre conteneur, la section ci-dessus l'a
    // établi. `-f` parce qu'un conteneur en marche doit être arrêté d'abord, et qu'un arrêt
    // séparé laisserait une fenêtre où le nom est pris sans que rien ne tourne.
    `  docker rm -f ${application} >&2 2>&1 || echec ` +
      q(`L'ancien conteneur « ${application} » n'a pas pu être retiré : rien de neuf n'a été démarré.`),
    `  note ${q("Version précédente du conteneur retirée.")}`,
    "fi",

    // Aucun port publié : l'application n'est joignable que depuis le réseau interne, donc
    // par Caddy. Publier un port ici la rendrait accessible en clair sur l'IP publique,
    // pare-feu compris — `host.prepare` n'ouvre que 22, 80 et 443, mais Docker écrit ses
    // propres règles et passe **devant** UFW.
    //
    // Les options variables passent par `"$@"` et non par une chaîne à découper : un
    // `$options` non quoté marcherait aujourd'hui — le chemin est borné par
    // `APPLICATION_PATTERN` — et cesserait de marcher le jour où une option porterait un
    // espace, silencieusement et en root.
    "demarre() {",
    `  docker run -d --name ${application} --network ${reseau} --restart unless-stopped \\`,
    `    --label ${q(`${ETIQUETTE_APP}=${application}`)} --label ${q(`${ETIQUETTE_PORT}=${port}`)} "$@"`,
    "}",

    // `--env-file` n'accepte pas un fichier absent : sans ce test, une application sans
    // environnement — cas légitime, `env.write` est facultatif dans le plan — ne démarrerait
    // jamais.
    "demarrage=0",
    `if [ -f ${q(env)} ]; then`,
    `  demarre --env-file ${q(env)} "$image" >&2 2>&1 || demarrage=$?`,
    "else",
    '  demarre "$image" >&2 2>&1 || demarrage=$?',
    "fi",
    'if [ "$demarrage" -ne 0 ]; then',
    "  echec " +
      q(`Le conteneur « ${application} » n'a pas pu être créé : aucune version précédente n'a été laissée en place.`),
    "fi",

    // Un `docker run -d` réussi ne dit rien de la suite : le processus peut sortir aussitôt.
    `sleep ${String(ATTENTE_DEMARRAGE_S)}`,

    // **Jamais `.State.Running`.** Mesuré sur le banc : un conteneur qui meurt à chaque
    // démarrage sous `--restart unless-stopped` rend `Running=true` alors que son état est
    // `restarting` et son code de sortie 1. La garde de vivacité passait donc, l'étape
    // annonçait « démarré », et c'est `proxy.caddy.site` qui publiait un domaine devant un
    // conteneur qui ne sert rien. `.State.Status` distingue les deux, et `RestartCount` ferme
    // le reste : dans les premières secondes, un seul redémarrage veut déjà dire que le
    // processus est mort une fois.
    `statut=$(docker inspect -f '{{.State.Status}}' ${application} 2>/dev/null)`,
    `redemarrages=$(docker inspect -f '{{.RestartCount}}' ${application} 2>/dev/null)`,
    'if [ "$statut" != running ] || [ "$redemarrages" != 0 ]; then',
    `  docker logs --tail ${String(LIGNES_JOURNAL_APP)} ${application} >&2 2>&1 || true`,
    `  docker rm -f ${application} >&2 2>&1 || true`,
    "  echec " +
      q(
        `Le conteneur « ${application} » n'a pas tenu les ${ATTENTE_DEMARRAGE_S} secondes qui ont suivi son ` +
          "démarrage : il s'est arrêté, ou il redémarre en boucle. Les " +
          `${LIGNES_JOURNAL_APP} dernières lignes de son journal sont jointes au diagnostic ; il a été ` +
          "retiré pour ne pas laisser un conteneur mort sous ce nom."
      ),
    "fi",

    `note "Conteneur ${application} démarré sur $image, réseau ${reseau}, port interne ${port}, sans port publié."`,
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

function scriptAppRunUndo(ctx: StepContext): string {
  const application = exigeMotif(ctx.application, APPLICATION_PATTERN, "un nom d'application valide")

  return [
    ...PREAMBULE,

    `if ! docker inspect ${application} >/dev/null 2>&1; then`,
    "  fin unchanged " + q(`Aucun conteneur « ${application} » sur cette machine : rien à défaire.`),
    "fi",

    // La même garde qu'à l'aller, et elle compte davantage ici : une annulation joue après un
    // échec, donc sur une machine dont on sait déjà qu'elle n'est pas dans l'état prévu.
    ...sectionProprietaire(application),

    `docker rm -f ${application} >&2 2>&1 || echec ` +
      q(`Le conteneur « ${application} » n'a pas pu être retiré ; la machine reste à mi-chemin, à inspecter à la main.`),
    "note " + q(`Conteneur ${application} arrêté et retiré. L'image reste en place pour un retour arrière.`),
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

/* ---------------------------------------------------------------------- state.record --- */

/**
 * Assemble `state.json` depuis les fichiers par application.
 *
 * Aucune analyse de JSON : chaque fichier est un objet complet, on les recolle séparés par
 * des virgules. Le fichier assemblé est un dérivé — le perdre ne perd rien, un rejeu le
 * reconstruit à l'identique depuis `state.d`.
 */
function sectionAssemblage(rienAChanger: string): string[] {
  const brouillon = `${REPERTOIRE_SKYNODE}/.brouillon-state`

  return [
    "{",
    `  printf '%s\\n' '{'`,
    `  printf '%s\\n' '  "version": 1,'`,
    `  printf '%s\\n' '  "apps": ['`,
    "  premier=oui",
    `  for fichier in ${REPERTOIRE_ETAT}/*.json; do`,
    '    [ -f "$fichier" ] || continue',
    '    if [ "$premier" = non ]; then printf \',\\n\'; fi',
    "    premier=non",
    '    cat "$fichier"',
    "  done",
    '  if [ "$premier" = non ]; then printf \'\\n\'; fi',
    `  printf '%s\\n' '  ]'`,
    `  printf '%s\\n' '}'`,
    `} > ${q(brouillon)} || echec ` + q("L'état assemblé n'a pas pu être écrit : l'ancien est resté en place."),

    `if [ -f ${q(CHEMIN_ETAT)} ] && cmp -s ${q(brouillon)} ${q(CHEMIN_ETAT)}; then`,
    `  rm -f ${q(brouillon)}`,
    "  fin unchanged " + q(rienAChanger),
    "fi",

    `mv -f ${q(brouillon)} ${q(CHEMIN_ETAT)} || { rm -f ${q(brouillon)}; echec ` +
      q("L'état n'a pas pu être mis en place : l'ancien est resté intact.") +
      "; }",
    `chmod 0600 ${q(CHEMIN_ETAT)} || echec ` + q("L'état n'a pas pu être restreint à root."),
    `chown root:root ${q(CHEMIN_ETAT)} || echec ` + q("Le propriétaire de l'état n'a pas pu être fixé."),
  ]
}

function scriptStateRecord(ctx: StepContext): string {
  const application = exigeMotif(ctx.application, APPLICATION_PATTERN, "un nom d'application valide")
  const fichier = cheminEtat(application)
  const site = `${REPERTOIRE_SITES}/${application}.caddy`

  return [
    ...PREAMBULE,
    ...sectionRepertoire(REPERTOIRE_SKYNODE),
    ...sectionRepertoire(REPERTOIRE_ETAT),

    `if ! docker inspect ${application} >/dev/null 2>&1; then`,
    "  echec " +
      q(
        `Aucun conteneur « ${application} » à constater : cette étape enregistre ce qui tourne, ` +
          "elle ne déclare pas ce que le plan annonçait."
      ),
    "fi",

    // Tout ce qui suit est **lu sur la machine**, donc hors du périmètre de `plan-rules.ts` :
    // chaque valeur est bornée par un `case` avant d'entrer dans le JSON, faute de quoi un
    // guillemet suffirait à en faire sortir. Une valeur qui ne passe pas devient `null` —
    // l'état reste du JSON valide et dit qu'il ne sait pas, plutôt que de mentir.
    `image=$(docker inspect -f '{{.Config.Image}}' ${application} 2>/dev/null)`,
    'case "$image" in',
    "  *[!A-Za-z0-9_./:-]*) image='' ;;",
    "esac",

    `port=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_PORT}"}}' ${application} 2>/dev/null)`,
    'case "$port" in',
    "  0*|*[!0-9]*) port='' ;;",
    "esac",

    `demarre_le=$(docker inspect -f '{{.State.StartedAt}}' ${application} 2>/dev/null)`,
    'case "$demarre_le" in',
    "  *[!0-9A-Za-z:.+-]*) demarre_le='' ;;",
    "esac",

    // Le domaine se lit sur le fichier de site que `proxy.caddy.site` a écrit, dont la
    // troisième ligne est `<domaine> {`. C'est la seule source de vérité du routage : le
    // plan a pu être joué sans domaine, ou le site retiré depuis.
    "domaine=''",
    `if [ -f ${q(site)} ]; then`,
    `  domaine=$(sed -n '3s/ {$//p' ${q(site)} 2>/dev/null)`,
    "fi",
    'case "$domaine" in',
    "  *[!a-z0-9.-]*) domaine='' ;;",
    "esac",

    // Une valeur vide devient `null` : l'état reste du JSON valide et dit qu'il ne sait pas,
    // plutôt que de porter une chaîne vide qu'un lecteur prendrait pour une valeur. Les
    // `case` ci-dessus ont déjà écarté tout guillemet et toute contre-oblique, ce qui est le
    // contrôle qui autorise ce `%s` sans échappement.
    "texte() { if [ -z \"$1\" ]; then printf null; else printf '\"%s\"' \"$1\"; fi; }",

    "{",
    `  printf '%s\\n' ${q("    {")}`,
    `  printf '%s\\n' ${q(`      "nom": "${application}",`)}`,
    `  printf '      "image": %s,\\n' "$(texte "$image")"`,
    '  printf \'      "port_interne": %s,\\n\' "${port:-null}"',
    `  printf '      "demarre_le": %s,\\n' "$(texte "$demarre_le")"`,
    `  printf '      "domaine": %s\\n' "$(texte "$domaine")"`,
    `  printf '%s' ${q("    }")}`,
    `} > ${q(fichier)} || echec ` + q("L'état de cette application n'a pas pu être écrit."),
    `chmod 0600 ${q(fichier)} || echec ` + q("L'état de cette application n'a pas pu être restreint à root."),
    `chown root:root ${q(fichier)} || echec ` + q("Le propriétaire de l'état de cette application n'a pas pu être fixé."),

    ...sectionAssemblage("L'état de la machine décrit déjà ce déploiement : rien à réécrire."),

    `note "État enregistré dans ${CHEMIN_ETAT} ; les applications déjà connues y figurent toujours."`,
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

function scriptStateRecordUndo(ctx: StepContext): string {
  const application = exigeMotif(ctx.application, APPLICATION_PATTERN, "un nom d'application valide")
  const fichier = cheminEtat(application)

  return [
    ...PREAMBULE,
    ...sectionRepertoire(REPERTOIRE_SKYNODE),
    ...sectionRepertoire(REPERTOIRE_ETAT),

    `if [ ! -f ${q(fichier)} ]; then`,
    "  fin unchanged " + q("Cette application ne figure pas dans l'état de la machine : rien à défaire."),
    "fi",

    `rm -f ${q(fichier)} || echec ` + q("L'entrée d'état de cette application n'a pas pu être supprimée."),

    // On réassemble : laisser `state.json` décrire une application qu'on vient d'en retirer
    // serait pire que de ne rien avoir défait, puisque `rollback` s'y fierait.
    ...sectionAssemblage(
      "L'état de la machine ne mentionnait déjà plus cette application : rien à réécrire."
    ),

    "note " + q("Entrée d'état de cette application retirée ; celles des autres applications sont intactes."),
    "applique=oui",
    'fin applied "$detail"',
  ].join("\n")
}

/* ------------------------------------------------------------------------- recettes --- */

export const RECETTE_ENV_WRITE: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: StepContext): string {
    const etape = exigeType(step, "env.write")

    return scriptEnvWrite(litFichierEnv(ctx.projectRoot, etape.depuis), ctx.application)
  },
  undoScript(step: PlanStep, ctx: StepContext): string {
    exigeType(step, "env.write")

    return scriptEnvWriteUndo(ctx.application)
  },
})

export const RECETTE_APP_RUN: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: StepContext): string {
    return scriptAppRun(exigeType(step, "app.run"), ctx)
  },
  undoScript(step: PlanStep, ctx: StepContext): string {
    exigeType(step, "app.run")

    return scriptAppRunUndo(ctx)
  },
})

export const RECETTE_STATE_RECORD: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: StepContext): string {
    exigeType(step, "state.record")

    return scriptStateRecord(ctx)
  },
  undoScript(step: PlanStep, ctx: StepContext): string {
    exigeType(step, "state.record")

    return scriptStateRecordUndo(ctx)
  },
})
