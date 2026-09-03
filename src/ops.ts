import { APPLICATION_PATTERN, ALLOWED_NETWORK, exigeMotif } from "./plan-rules.js"
import { shellQuote } from "./remote.js"
import { ATTENTE_DEMARRAGE_S, ETIQUETTE_APP, LIGNES_JOURNAL_APP, cheminEnv } from "./steps-app.js"
import { PREAMBULE } from "./steps-host.js"
import { depotImage } from "./steps-build.js"
import { ETIQUETTE_PORT } from "./steps-proxy.js"

/**
 * Les deux opérations qui ne sont pas des étapes de plan : lire les journaux d'une
 * application (`app_logs`) et revenir à sa version précédente (`rollback`).
 *
 * Elles vivent hors de `step.ts` parce qu'elles ne s'y rattachent pas : elles ne figurent
 * dans aucun plan, ne s'annulent pas, et n'ont donc ni recette ni réversibilité à déclarer.
 * Elles partagent en revanche tout le reste — le protocole de sortie, les étiquettes qui
 * distinguent nos conteneurs, et la discipline d'interpolation de l'invariant n°1.
 */

const q = shellQuote

/* ---------------------------------------------------------------------------- logs --- */

/**
 * Le plafond, et il est délibéré : des journaux entiers noieraient le contexte de l'agent
 * et lui feraient perdre le fil de ce qu'il cherchait. Mille lignes suffisent à voir une
 * pile d'exception ou une boucle de redémarrage.
 */
export const LIGNES_MAX = 1000

/** Ce qu'un agent obtient sans rien demander. */
export const LIGNES_DEFAUT = 100

/**
 * La forme d'un `--since` de Docker : un horodatage RFC 3339, ou une durée relative
 * (`10m`, `2h`, `1h30m`).
 *
 * Cette valeur vient de l'agent et entre dans une ligne de commande jouée en root : c'est
 * ce motif, et lui seul, qui autorise son interpolation. Docker accepte d'autres formes —
 * un horodatage Unix, par exemple — mais élargir le motif pour les couvrir élargirait
 * d'autant ce qu'un texte lu dans un dépôt peut faire passer.
 */
export const SINCE_PATTERN = /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?|\d+[smhd]([0-9]+[smhd])*)$/

/** Le marqueur de fin : sans lui, une session coupée se lirait comme des journaux complets. */
export const MARQUEUR_LOGS = "logs.end"

/** Rappelle qu'aucun conteneur ne porte ce nom, plutôt que de rendre un silence. */
export const MARQUEUR_ABSENT = "logs.absent"

export function bornerLignes(demande: number | undefined): number {
  if (demande === undefined || !Number.isFinite(demande)) return LIGNES_DEFAUT

  const entier = Math.floor(demande)
  if (entier < 1) return 1

  return entier > LIGNES_MAX ? LIGNES_MAX : entier
}

export function exigeSince(since: string): string {
  if (!SINCE_PATTERN.test(since)) {
    throw new Error(
      `« ${since} » n'est pas une date ou une durée que Docker sait lire : attendez-vous à ` +
        "« 2026-01-31T09:00:00Z » ou à une durée relative comme « 30m » ou « 2h »."
    )
  }

  return since
}

/**
 * Le script qui rend les journaux d'une application.
 *
 * Il ne suit pas le protocole d'étape : il ne change rien, n'a rien à défaire et n'a pas
 * d'idempotence à déclarer. Sa seule promesse est de dire s'il est allé au bout.
 *
 * **`2>&1` n'est pas cosmétique** : une application qui écrit ses erreurs sur la sortie
 * d'erreur — la plupart — ne montrerait rien de ce qui explique une panne sans lui.
 */
export function scriptLogs(application: string, lignes: number, since?: string): string {
  const app = exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")
  const nombre = String(bornerLignes(lignes))
  const depuis = since === undefined ? "" : ` --since ${q(exigeSince(since))}`

  return [
    "set -u",

    // Le conteneur peut ne pas exister : l'application n'a jamais été déployée, ou son
    // conteneur a été retiré. Le dire vaut mieux que rendre un journal vide, que l'agent
    // lirait comme « l'application ne dit rien », donc comme un fonctionnement normal.
    `if ! docker inspect ${app} >/dev/null 2>&1; then`,
    `  printf '%s\\t1\\n' ${q(MARQUEUR_ABSENT)}`,
    `  printf '%s\\t1\\n' ${q(MARQUEUR_LOGS)}`,
    "  exit 0",
    "fi",

    // `--timestamps` parce qu'un journal sans dates ne permet pas de rattacher une erreur à
    // un déploiement. Le `tail` final borne ce que Docker aurait rendu de trop : une ligne
    // du journal peut être longue, et `--tail` compte des lignes, pas des octets.
    `docker logs --tail ${nombre}${depuis} --timestamps ${app} 2>&1 | tail -n ${nombre}`,

    `printf '%s\\t1\\n' ${q(MARQUEUR_LOGS)}`,
  ].join("\n")
}

/* ------------------------------------------------------------------------ rollback --- */

/** Ce que le script émet pour dire vers quoi il est revenu, et d'où il venait. */
export const MARQUEUR_DEPUIS = "rollback.depuis"
export const MARQUEUR_VERS = "rollback.vers"

/**
 * Le script qui ramène une application à sa version précédente.
 *
 * Trois refus, dans cet ordre, et aucun ne touche à quoi que ce soit :
 *
 * 1. **Le conteneur n'est pas le nôtre.** Invariant n°2 : un conteneur qui ne porte pas
 *    l'étiquette `skynode.app` appartient à quelqu'un d'autre.
 * 2. **Il n'y a pas de version précédente.** Revenir à une image qui n'existe pas laisserait
 *    l'application arrêtée sans rien pour la remplacer — pire que ne pas revenir du tout.
 * 3. **Le conteneur ne porte pas son port interne.** Le redémarrer sans cette étiquette
 *    ferait perdre à `proxy.caddy.site` ce qui lui dit où router.
 *
 * Et un filet : **si la version précédente ne tient pas debout, on remet celle d'avant**.
 * Un retour arrière qui laisse l'application éteinte est le seul résultat qui soit pire
 * que le déploiement qu'il essayait de corriger.
 */
export function scriptRollback(application: string): string {
  const app = exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")
  const depot = depotImage(app)
  const env = cheminEnv(app)

  return [
    ...PREAMBULE,

    "if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then",
    "  echec " + q("Docker ne répond pas à « docker info » : il n'y a rien à ramener en arrière."),
    "fi",

    `if ! docker inspect ${app} >/dev/null 2>&1; then`,
    "  echec " +
      q(
        `Aucun conteneur « ${app} » sur cette machine : il n'y a pas de déploiement en cours ` +
          "à ramener à sa version précédente."
      ),
    "fi",

    `proprietaire=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_APP}"}}' ${app} 2>/dev/null)`,
    `if [ "$proprietaire" != ${q(app)} ]; then`,
    "  echec " +
      q(
        `Le conteneur « ${app} » ne porte pas l'étiquette ${ETIQUETTE_APP}=${app} : il n'a pas été ` +
          "posé par SkyNode et ne sera pas remplacé."
      ),
    "fi",

    `port=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_PORT}"}}' ${app} 2>/dev/null)`,
    'case "$port" in',
    '  ""|0*|*[!0-9]*) echec ' +
      q(
        `Le conteneur « ${app} » ne porte pas d'étiquette ${ETIQUETTE_PORT} exploitable : le ` +
          "redémarrer sans elle ferait perdre au proxy ce qui lui dit où router. Rien n'a été touché."
      ) +
      " ;;",
    "esac",

    `courante=$(docker inspect -f '{{.Config.Image}}' ${app} 2>/dev/null)`,
    `identifiant=$(docker inspect -f '{{.Image}}' ${app} 2>/dev/null)`,

    // La plus récente étiquette du dépôt qui ne désigne pas l'image en service. La
    // comparaison porte sur l'**identifiant** : deux étiquettes d'une même image ne sont pas
    // deux versions, et y « revenir » ne changerait rien tout en coupant le service le temps
    // du redémarrage.
    "precedente=''",
    `for couple in $(docker images ${q(depot)} --format '{{.ID}}|{{.Repository}}:{{.Tag}}' 2>/dev/null | ` +
      `grep -v ${q(":<none>$")}); do`,
    "  id=${couple%%|*}",
    "  etiquette=${couple#*|}",
    '  if [ "$etiquette" = "$courante" ]; then continue; fi',
    '  case "$identifiant" in *"$id"*) continue ;; esac',
    '  precedente="$etiquette"',
    "  break",
    "done",

    'if [ -z "$precedente" ]; then',
    "  echec " +
      q(
        `Aucune version précédente de « ${app} » n'est conservée sur cette machine : il n'y a ` +
          "rien vers quoi revenir, et le conteneur en service n'a pas été touché."
      ),
    "fi",

    `printf '%s\\t%s\\n' ${q(MARQUEUR_DEPUIS)} "$courante"`,
    `printf '%s\\t%s\\n' ${q(MARQUEUR_VERS)} "$precedente"`,

    // Le démarrage, identique à celui d'`app.run` : mêmes étiquettes, même réseau, même
    // fichier d'environnement. Les options variables passent par `"$@"`, jamais par une
    // chaîne à découper.
    "demarre() {",
    `  docker run -d --name ${app} --network ${ALLOWED_NETWORK} --restart unless-stopped \\`,
    `    --label ${q(`${ETIQUETTE_APP}=${app}`)} --label ${ETIQUETTE_PORT}="$port" "$@"`,
    "}",
    "lance() {",
    `  if [ -f ${q(env)} ]; then`,
    `    demarre --env-file ${q(env)} "$1" >&2 2>&1`,
    "  else",
    '    demarre "$1" >&2 2>&1',
    "  fi",
    "}",
    "tient() {",
    `  sleep ${String(ATTENTE_DEMARRAGE_S)}`,
    // `.State.Status`, jamais `.State.Running` : un conteneur en boucle de redémarrage rend
    // `Running=true`. Même mesure, même raison qu'à `app.run`.
    `  statut=$(docker inspect -f '{{.State.Status}}' ${app} 2>/dev/null)`,
    `  redemarrages=$(docker inspect -f '{{.RestartCount}}' ${app} 2>/dev/null)`,
    '  [ "$statut" = running ] && [ "$redemarrages" = 0 ]',
    "}",

    `docker rm -f ${app} >&2 2>&1 || echec ` +
      q(`Le conteneur « ${app} » n'a pas pu être arrêté : il tourne toujours sur sa version actuelle.`),

    'if lance "$precedente" && tient; then',
    '  note "Application ramenée de $courante à $precedente."',
    "  applique=oui",
    '  fin applied "$detail"',
    "fi",

    // La version précédente ne tient pas debout. Laisser l'application éteinte serait pire
    // que le déploiement qu'on essayait de corriger : on remet celle qui tournait.
    `docker logs --tail ${String(LIGNES_JOURNAL_APP)} ${app} >&2 2>&1 || true`,
    `docker rm -f ${app} >&2 2>&1 || true`,

    'if lance "$courante" && tient; then',
    "  echec " +
      q(
        "La version précédente n'a pas tenu debout : son journal est joint au diagnostic. " +
          "La version qui tournait a été remise en service, l'application répond de nouveau."
      ),
    "fi",

    `docker rm -f ${app} >&2 2>&1 || true`,
    "echec " +
      q(
        "Ni la version précédente ni celle qui tournait n'ont tenu debout : l'application est " +
          "arrêtée et aucun conteneur ne porte plus son nom. Les journaux sont joints au " +
          "diagnostic ; la panne ne vient pas de l'image, elle est sur la machine."
      ),
  ].join("\n")
}
