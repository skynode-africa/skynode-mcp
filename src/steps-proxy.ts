import { ALLOWED_NETWORK, APPLICATION_PATTERN, CADDY_CONTAINER, DOMAIN_PATTERN } from "./plan-rules.js"
import type { PlanStep } from "./plan-types.js"
import { markerBlockScript, shellQuote, writeFileScript } from "./remote.js"
import type { StepRecipe } from "./step.js"
import { PREAMBULE, REPERTOIRE_SKYNODE } from "./steps-host.js"

/**
 * Les deux étapes du routage : le reverse proxy lui-même (`proxy.caddy.install`) et la
 * publication d'une application sur un domaine (`proxy.caddy.site`).
 *
 * **Un fichier par application, jamais un fichier partagé à découper.** La spec §6.4 impose
 * un bloc marqué pour ce que SkyNode pose dans un fichier qui n'est pas à lui ; un fichier
 * par application sert mieux la même intention — il n'y a plus de texte à retrancher, et
 * retirer une application revient à supprimer un fichier. Le seul fichier de ce module qui
 * puisse préexister est le `Caddyfile` principal, et il n'est touché que par un bloc marqué
 * portant une ligne : l'`import` des fichiers de site.
 *
 * Trois choses gouvernent ce module, et aucune n'est négociable :
 *
 * - **On ne prend jamais un port tenu par un tiers.** 80 et 443 sont constatés libres avant
 *   que le conteneur soit créé, et un conteneur `skynode-caddy` déjà en marche n'est ni
 *   recréé ni redémarré : c'est peut-être lui qui sert les autres applications de la machine.
 * - **Les certificats ne se rejettent pas.** `/data` et `/config` vivent dans des volumes
 *   nommés qui survivent au conteneur, et l'annulation retire le conteneur sans y toucher.
 *   Sans eux, chaque redémarrage redemanderait les certificats — et Let's Encrypt plafonne
 *   à cinq échecs de validation par heure et par domaine, ce qui bloquerait le domaine du
 *   client pour l'après-midi.
 * - **Une seule attente du certificat, jamais de boucle**, pour la même raison.
 */

/* ------------------------------------------------------------------------ constantes --- */

/**
 * L'image, épinglée à une version de correctif.
 *
 * Une étiquette flottante (`caddy:2`, `caddy:latest`) ferait dépendre du jour la version
 * qui tourne chez le client : deux machines posées à une semaine d'écart ne porteraient pas
 * le même proxy, et la mise à jour arriverait sans que personne ne l'ait décidée. Un
 * condensat serait plus strict encore, mais illisible dans un plan qu'un humain approuve ;
 * une étiquette de correctif complet est immuable en pratique et se lit.
 */
export const IMAGE_CADDY = "caddy:2.10.2"

/** Le répertoire de configuration de Caddy, côté hôte **et** côté conteneur. */
export const REPERTOIRE_CADDY = `${REPERTOIRE_SKYNODE}/caddy`

/**
 * Le `Caddyfile` principal — **le seul fichier de ce produit qui puisse préexister**.
 * `proxy.caddy.install` le crée s'il manque et ne le réécrit jamais ; `proxy.caddy.site`
 * n'y ajoute qu'un bloc marqué.
 */
export const CHEMIN_CADDYFILE = `${REPERTOIRE_CADDY}/Caddyfile`

/** Un fichier par application, jamais un fichier partagé. */
export const REPERTOIRE_SITES = `${REPERTOIRE_CADDY}/sites`

export const VOLUME_DONNEES = "skynode-caddy-data"
export const VOLUME_CONFIG = "skynode-caddy-config"

/**
 * Le marqueur du bloc posé dans le `Caddyfile` principal. `skynode-caddy`, pas `skynode`
 * tout court : `host.prepare` a déjà établi la convention `skynode-<sujet>` dans
 * `/etc/fstab`, et un marqueur générique ferait se recouvrir deux blocs du produit le jour
 * où un second aurait à cohabiter dans le même fichier — `removeMarkerBlockScript` en
 * retirerait alors un de trop.
 */
export const MARQUEUR_IMPORT = "skynode-caddy"

/**
 * La seule ligne que SkyNode ajoute au `Caddyfile` principal. Un motif qui ne correspond à
 * aucun fichier n'est qu'un avertissement pour Caddy (vérifié sur `caddy validate` 2.10.2),
 * pas une erreur : retirer le dernier site ne casse donc pas la configuration.
 */
export const LIGNE_IMPORT = `import ${REPERTOIRE_SITES}/*.caddy`

/**
 * L'étiquette par laquelle `app.run` (tâche 7) fait connaître le port d'écoute du conteneur
 * applicatif. Voir `portInterne` plus bas pour ce qui la rend nécessaire et ce qui la borne.
 */
export const ETIQUETTE_PORT = "skynode.port_interne"

/**
 * L'unique attente du certificat, en secondes.
 *
 * Assez pour qu'un domaine correctement pointé ait abouti, jamais assez pour qu'un agent
 * soit tenté de recommencer. **Ce délai ne s'accompagne d'aucune boucle et son échéance
 * n'est pas un échec** : Caddy continue de demander le certificat de lui-même, et une étape
 * qui rendrait `failed` ferait relancer le déploiement — donc redemander le certificat, et
 * consommer le plafond de cinq échecs par heure et par domaine de Let's Encrypt.
 */
export const ATTENTE_CERTIFICAT_S = 20

/** L'en-tête du `Caddyfile` créé quand il n'en existe aucun. Aucune règle : c'est voulu. */
export const ENTETE_CADDYFILE: string = [
  "# Écrit par SkyNode parce qu'aucun Caddyfile n'existait ici.",
  "#",
  "# Ce fichier vous appartient : SkyNode n'y ajoute qu'un bloc marqué « >>> skynode-caddy >>> »",
  "# portant l'import des fichiers de site, et ne touche à rien d'autre. Tout ce que vous",
  "# écrivez en dehors de ce bloc est conservé tel quel.",
  "",
].join("\n")

const q = shellQuote

/* ------------------------------------------------------------------------- garde-fous --- */

/**
 * Refuse toute valeur qui n'a pas la forme que `plan-rules.ts` impose, **avant** qu'elle
 * entre dans un script.
 *
 * `plan-validate.ts` contrôle déjà le domaine et `PlanSchema` le nom d'application, mais
 * une recette est appelable directement : `recipeFor("proxy.caddy.site").script(…)` ne
 * passe par aucun des deux. Ce contrôle-ci est donc celui qui **autorise** l'interpolation
 * plus bas, et c'est lui qu'il faut lire pour vérifier l'invariant n°1 du jalon.
 */
function exigeMotif(valeur: string, motif: RegExp, quoi: string): string {
  if (!motif.test(valeur)) {
    throw new Error(`« ${valeur} » n'est pas ${quoi} : aucun script ne peut être composé avec cette valeur.`)
  }

  return valeur
}

/**
 * Une recette ne doit jamais lire une étape d'un autre type : les champs qu'elle attend n'y
 * seraient pas, et TypeScript ne protège pas un exécuteur qui aurait perdu le lien entre le
 * type et la recette.
 */
function exigeType<T extends PlanStep["type"]>(step: PlanStep, type: T): Extract<PlanStep, { type: T }> {
  if (step.type !== type) {
    throw new Error(`La recette de « ${type} » a reçu une étape de type « ${step.type} ».`)
  }

  return step as Extract<PlanStep, { type: T }>
}

/**
 * Le fichier de site d'une application. **Le nom vient du nom d'application, jamais du
 * domaine.**
 *
 * Les deux sont indépendants (`APPLICATION_PATTERN` et `DOMAIN_PATTERN`), et le dériver de
 * la première étiquette du domaine ferait se recouvrir `app.exemple.ci` et `app.autre.ci`
 * sur un même `app.caddy` — le second déploiement écraserait le routage du premier, puis
 * enverrait le trafic vers un conteneur qui n'existe pas.
 */
export function cheminSite(application: string): string {
  return `${REPERTOIRE_SITES}/${exigeMotif(application, APPLICATION_PATTERN, "un nom d'application valide")}.caddy`
}

/* -------------------------------------------------------------------------- install --- */

/** Les répertoires de Caddy, sans jamais relâcher le mode de `/etc/skynode`. */
function sectionRepertoires(): string[] {
  return [
    // `install -d` créerait les répertoires manquants du chemin **au mode demandé** : un
    // `/etc/skynode` absent naîtrait alors en 0755, alors qu'il porte des secrets. On le
    // crée séparément, à son mode à lui.
    `if [ ! -d ${q(REPERTOIRE_SKYNODE)} ]; then`,
    `  install -d -m 0700 -o root -g root ${q(REPERTOIRE_SKYNODE)} || echec ` +
      q(`Création de ${REPERTOIRE_SKYNODE} impossible.`),
    "fi",
    `if [ ! -d ${q(REPERTOIRE_CADDY)} ]; then`,
    `  install -d -m 0755 -o root -g root ${q(REPERTOIRE_CADDY)} || echec ` +
      q(`Création de ${REPERTOIRE_CADDY} impossible.`),
    "  note " + q(`${REPERTOIRE_CADDY} créé.`),
    "  applique=oui",
    "fi",
    `if [ ! -d ${q(REPERTOIRE_SITES)} ]; then`,
    `  install -d -m 0755 -o root -g root ${q(REPERTOIRE_SITES)} || echec ` +
      q(`Création de ${REPERTOIRE_SITES} impossible.`),
    "  note " + q(`${REPERTOIRE_SITES} créé.`),
    "  applique=oui",
    "fi",
  ]
}

/**
 * Le `Caddyfile` principal, **posé seulement s'il n'existe pas**.
 *
 * L'image officielle en embarque un par défaut, que le montage lié masque : sans fichier à
 * cet endroit, Caddy refuse de démarrer. Mais un fichier déjà là est celui du client ou
 * celui d'un passage précédent, et dans les deux cas il n'est pas à nous.
 */
function sectionCaddyfile(): string[] {
  return [
    `if [ ! -f ${q(CHEMIN_CADDYFILE)} ]; then`,
    // **Sans indentation, et ce n'est pas cosmétique** : `writeFileScript` écrit par heredoc
    // quoté, dont le délimiteur de fermeture doit occuper la colonne zéro. Décalé de deux
    // espaces, il cesse d'être reconnu — le heredoc avale alors tout le reste du script, que
    // `dash -n` refuse à la fin du fichier. Le corps du fichier écrit y gagnerait de surcroît
    // deux espaces par ligne, que le contrôle d'octets rejetterait.
    ...writeFileScript(
      CHEMIN_CADDYFILE,
      ENTETE_CADDYFILE,
      "0644",
      "echec " + q(`Écriture interrompue : ${CHEMIN_CADDYFILE} est incomplet, rien n'a été démarré.`)
    ).split("\n"),
    "  note " + q("Caddyfile principal créé, vide de toute règle."),
    "  applique=oui",
    "fi",
  ]
}

/**
 * Le réseau interne, puis les volumes nommés — **avant** le conteneur, qui les référence.
 *
 * Les volumes sont créés explicitement plutôt que laissés à `docker run` : c'est ce qui
 * permet au rapport de dire qu'ils viennent d'être posés, et ce qui rend visible, à la
 * lecture, qu'ils sont des objets à part du conteneur — donc que l'annulation les laisse.
 */
function sectionReseauEtVolumes(): string[] {
  return [
    // `docker network inspect` écrit du JSON sur la sortie standard, `docker network
    // create` l'identifiant du réseau : ni l'un ni l'autre n'a rien à faire sur le flux qui
    // porte le protocole d'étape.
    `if ! docker network inspect ${ALLOWED_NETWORK} >/dev/null 2>&1; then`,
    `  docker network create ${ALLOWED_NETWORK} >&2 || echec ` +
      q(`Création du réseau interne ${ALLOWED_NETWORK} impossible.`),
    "  note " + q(`Réseau interne ${ALLOWED_NETWORK} créé.`),
    "  applique=oui",
    "fi",

    // Découpage en mots voulu : ces deux noms sont des constantes de ce module, jamais des
    // valeurs venues du plan.
    `for v in ${VOLUME_DONNEES} ${VOLUME_CONFIG}; do`,
    '  if docker volume inspect "$v" >/dev/null 2>&1; then continue; fi',
    '  docker volume create "$v" >&2 || echec ' +
      q("Création d'un volume nommé de Caddy impossible : sans lui, les certificats seraient redemandés à chaque redémarrage."),
    '  note "Volume nommé $v créé."',
    "  applique=oui",
    "done",
  ]
}

/**
 * Le constat des ports, **et le refus de prendre celui d'un tiers** (invariant n°2).
 *
 * Ce contrôle n'est pas la seule protection : `docker run -p 80:80` échoue de lui-même sur
 * un port déjà lié. Il est là pour que l'échec se lise — « le port 80 est tenu par nginx »
 * plutôt que « address already in use » —, et c'est pourquoi son absence (`ss` introuvable)
 * n'arrête pas l'étape : Docker refusera quand même, on perd le diagnostic, pas la garde.
 */
function sectionPortsLibres(): string[] {
  return [
    'tenus=""',
    "if command -v ss >/dev/null 2>&1; then",
    "  for port in 80 443; do",
    // La quatrième colonne de `ss -lntH` est l'adresse locale : `0.0.0.0:80`, `[::]:80` ou
    // `*:80` selon la pile. Seul ce qui suit le dernier `:` nous intéresse.
    "    if ss -lntH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -qx \"$port\"; then",
    '      tenus="$tenus $port"',
    "    fi",
    "  done",
    "fi",
    'if [ -n "$tenus" ]; then',
    '  echec "Ports déjà tenus par un autre processus :$tenus. Caddy ne les prendra pas : ' +
      'libérer ces ports, ou arrêter le service qui les occupe, avant de rejouer cette étape."',
    "fi",
  ]
}

const SCRIPT_INSTALL: string = [
  ...PREAMBULE,

  // Docker est un prérequis de cette étape, pas quelque chose qu'elle installe :
  // `plan-validate.ts` exige déjà `host.install_docker` plus haut dans le plan, ou Docker
  // constaté utilisable. Le redire ici évite de rendre `failed` sur une commande `docker`
  // introuvable, ce qui enverrait chercher le défaut du mauvais côté.
  "if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then",
  "  echec " +
    q("Docker ne répond pas à « docker info » : cette étape suppose un moteur de conteneurs en marche."),
  "fi",

  ...sectionReseauEtVolumes(),
  ...sectionRepertoires(),
  ...sectionCaddyfile(),

  // **Un Caddy en marche n'est ni recréé, ni redémarré, ni même inspecté plus avant.** Il
  // sert peut-être déjà les autres applications de la machine, et le recréer couperait leur
  // trafic le temps du redémarrage — pour un résultat identique, puisque l'image est
  // épinglée et la configuration lue dans un montage lié.
  `if docker inspect -f '{{.State.Running}}' ${CADDY_CONTAINER} 2>/dev/null | grep -qx true; then`,
  '  if [ "$applique" = oui ]; then',
  '    fin applied "$detail"',
  "  fi",
  "  fin unchanged " + q(`Caddy tourne déjà sous le nom ${CADDY_CONTAINER} : conteneur laissé intact.`),
  "fi",

  // Un conteneur du même nom mais arrêté est le nôtre, et il ne sert rien : on le retire
  // pour le reposer avec l'image épinglée et les montages courants. Les volumes nommés, eux,
  // ne bougent pas — les certificats déjà obtenus survivent à l'opération.
  `if docker inspect ${CADDY_CONTAINER} >/dev/null 2>&1; then`,
  `  docker rm -f ${CADDY_CONTAINER} >&2 || echec ` +
    q("Un conteneur skynode-caddy arrêté n'a pas pu être retiré avant d'être reposé."),
  "fi",

  ...sectionPortsLibres(),

  // Seuls 80 et 443 sont publiés. Pas d'API d'administration (2019) : elle n'écoute que sur
  // la boucle locale du conteneur, et `docker exec` suffit à la joindre pour un rechargement.
  // Pas d'UDP 443 non plus — le pare-feu de `host.prepare` n'ouvre que du TCP, et publier un
  // port que rien ne laisse entrer ferait croire à un HTTP/3 qui ne fonctionne pas.
  "docker run -d \\",
  `  --name ${CADDY_CONTAINER} \\`,
  "  --restart unless-stopped \\",
  `  --network ${ALLOWED_NETWORK} \\`,
  "  -p 80:80 \\",
  "  -p 443:443 \\",
  `  -v ${VOLUME_DONNEES}:/data \\`,
  `  -v ${VOLUME_CONFIG}:/config \\`,
  // En lecture seule, et **au même chemin des deux côtés** : ce que le Caddyfile désigne se
  // retrouve tel quel sur l'hôte, donc un humain qui lit `import /etc/skynode/caddy/sites/…`
  // trouve les fichiers là où la ligne le dit.
  `  -v ${REPERTOIRE_CADDY}:${REPERTOIRE_CADDY}:ro \\`,
  `  ${IMAGE_CADDY} \\`,
  `  caddy run --config ${CHEMIN_CADDYFILE} --adapter caddyfile >&2 || echec ` +
    q("La création du conteneur Caddy a échoué."),

  // Créé n'est pas en marche : un Caddyfile que Caddy refuse fait sortir le conteneur dans
  // la seconde, et `docker run -d` a pourtant rendu 0. Sans ce constat, l'étape rendrait
  // `applied` sur un proxy éteint.
  "sleep 2",
  `if ! docker inspect -f '{{.State.Running}}' ${CADDY_CONTAINER} 2>/dev/null | grep -qx true; then`,
  // Le journal explique le refus ; il part sur stderr, que `runRemote` joint au diagnostic.
  `  docker logs --tail 40 ${CADDY_CONTAINER} >&2 2>&1 || true`,
  // L'invariant n°4 : une étape qui échoue en cours de route défait ce qu'elle a commencé.
  // Le conteneur mort est retiré, la machine retrouve l'état d'avant l'étape.
  `  docker rm -f ${CADDY_CONTAINER} >&2 || true`,
  "  echec " +
    q(
      "Le conteneur Caddy a démarré puis s'est arrêté aussitôt : il a été retiré. " +
        "Le journal du conteneur est joint au diagnostic."
    ),
  "fi",
  "note " +
    q(
      "Caddy posé en conteneur sur une image épinglée, 80 et 443 publiés, certificats et " +
        "configuration dans des volumes nommés."
    ),
  "applique=oui",
  'fin applied "$detail"',
].join("\n")

const SCRIPT_INSTALL_UNDO: string = [
  ...PREAMBULE,

  `if docker inspect ${CADDY_CONTAINER} >/dev/null 2>&1; then`,
  `  docker rm -f ${CADDY_CONTAINER} >&2 || echec ` + q("Le retrait du conteneur Caddy a échoué."),
  "  note " + q(`Conteneur ${CADDY_CONTAINER} retiré.`),
  "  applique=oui",
  "fi",

  // Ce que cette annulation ne défait pas, et pourquoi :
  //
  // - **Les volumes nommés restent.** Ils portent les certificats déjà obtenus, et les
  //   jeter ferait redemander chaque certificat au prochain passage — or Let's Encrypt
  //   plafonne les échecs de validation à cinq par heure et par domaine. Un retour arrière
  //   ne doit pas pouvoir coûter au client l'accès HTTPS de l'après-midi.
  // - **Le réseau interne reste.** Les conteneurs applicatifs y sont attachés ; le
  //   supprimer les couperait les uns des autres alors qu'ils n'ont rien à voir avec Caddy.
  // - **Le Caddyfile principal reste.** C'est le seul fichier de ce produit qui puisse
  //   préexister, et il porte peut-être la configuration d'un humain.
  'if [ "$applique" = oui ]; then',
  '  fin applied "$detail"',
  "fi",
  "fin unchanged " + q(`Aucun conteneur ${CADDY_CONTAINER} sur cette machine : rien à défaire.`),
].join("\n")

/* ----------------------------------------------------------------------------- site --- */

/**
 * Comment le port d'écoute du conteneur applicatif est déterminé — **et pourquoi il n'est
 * pas dans l'étape**.
 *
 * `ProxyCaddySite` est `{ type, domaine }` en `.strict()` : le port vit dans `app.run`
 * (`port_interne`), et `plan-validate.ts` exige que `app.run` figure plus haut dans le plan
 * (« il n'y a rien à publier » sans elle). Au moment où cette étape s'exécute, le conteneur
 * applicatif existe donc, et son port se lit sur lui. L'alternative — élargir
 * `ProxyCaddySite` — changerait l'empreinte des plans d'un jalon clos et rippérait sur
 * quatre modules pour une valeur déjà présente sur la machine.
 *
 * Deux sources, dans cet ordre :
 *
 * 1. L'étiquette `skynode.port_interne`, que `app.run` pose sur le conteneur. C'est la
 *    seule qui porte le port **que le plan a demandé**, et la seule qui tranche quand
 *    l'image en expose plusieurs.
 * 2. À défaut, l'unique port exposé de l'image. Plusieurs ports, ou aucun, font échouer
 *    l'étape : router vers un port deviné serait pire que refuser — l'application
 *    paraîtrait déployée et répondrait 502, sans que rien ne dise pourquoi.
 *
 * **Le nombre obtenu est borné avant d'entrer dans le Caddyfile.** Une étiquette Docker est
 * du texte libre, que le `Dockerfile` du client peut porter : c'est la seule valeur de ce
 * module qui ne vienne pas de `plan-rules.ts`, et le `case` numérique ci-dessous est le
 * contrôle qui l'autorise à être interpolée.
 */
function sectionPortInterne(application: string): string[] {
  return [
    `port=$(docker inspect -f '{{index .Config.Labels "${ETIQUETTE_PORT}"}}' ${application} 2>/dev/null)`,
    // Une carte sans la clé rend la chaîne vide, une carte absente rend `<no value>` : les
    // deux se ramènent ici au même « pas d'étiquette », et le repli prend la main.
    'case "$port" in',
    '  ""|0*|*[!0-9]*) port="" ;;',
    "esac",

    'if [ -z "$port" ]; then',
    `  expose=$(docker inspect -f '{{range $p, $v := .Config.ExposedPorts}}{{$p}} {{end}}' ${application} 2>/dev/null` +
      " | tr ' ' '\\n' | sed -n 's#^\\([0-9][0-9]*\\)/tcp$#\\1#p')",
    "  nb=$(printf '%s\\n' \"$expose\" | grep -c '^[0-9]')",
    '  if [ "$nb" = 1 ]; then',
    "    port=$(printf '%s\\n' \"$expose\" | grep '^[0-9]')",
    '  elif [ "$nb" = 0 ]; then',
    "    echec " +
      q(
        `Le port d'écoute de « ${application} » est indéterminable : le conteneur ne porte pas ` +
          `l'étiquette ${ETIQUETTE_PORT} et son image n'expose aucun port TCP. Ajouter une ` +
          "directive EXPOSE au Dockerfile, puis rejouer le déploiement."
      ),
    "  else",
    "    echec " +
      q(
        `Le port d'écoute de « ${application} » est ambigu : son image expose plusieurs ports TCP ` +
          `et le conteneur ne porte pas l'étiquette ${ETIQUETTE_PORT} qui trancherait. Aucun ` +
          "routage n'a été posé — router vers un port deviné vaudrait moins que ce refus."
      ),
    "  fi",
    "fi",

    // Ce nombre entre dans le Caddyfile : il vient d'une étiquette ou d'une image, donc d'un
    // texte que `plan-rules.ts` n'a jamais vu. Le borner ici est ce qui autorise
    // l'interpolation de `$port` dans le fichier de site.
    'case "$port" in',
    '  ""|0*|*[!0-9]*) echec ' +
      q("Le port d'écoute lu sur le conteneur applicatif n'est pas un nombre : routage refusé.") +
      " ;;",
    "esac",
    'if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then',
    "  echec " + q("Le port d'écoute lu sur le conteneur applicatif est hors de la plage 1-65535 : routage refusé."),
    "fi",
  ]
}

function scriptSite(domaine: string, application: string): string {
  const site = cheminSite(application)
  const brouillon = `${REPERTOIRE_CADDY}/.brouillon-site-${application}`
  const sauvegarde = `${REPERTOIRE_CADDY}/.sauvegarde-site-${application}`

  return [
    ...PREAMBULE,

    // Sans proxy en marche, il n'y a rien à recharger — et écrire un fichier de site que
    // personne ne lit ferait rendre `applied` à une étape qui n'a rien publié.
    `if ! docker inspect -f '{{.State.Running}}' ${CADDY_CONTAINER} 2>/dev/null | grep -qx true; then`,
    "  echec " +
      q(`Le conteneur ${CADDY_CONTAINER} ne tourne pas : il n'y a aucun proxy à configurer.`),
    "fi",

    // `application` a passé `APPLICATION_PATTERN` dans `cheminSite`, donc `[a-z][a-z0-9-]{0,31}` :
    // c'est ce qui autorise son interpolation ici, en nom de conteneur comme en nom de fichier.
    `if ! docker inspect ${application} >/dev/null 2>&1; then`,
    "  echec " +
      q(
        `Le conteneur applicatif « ${application} » est introuvable : il n'y a rien à publier ` +
          `sur ${domaine}.`
      ),
    "fi",

    ...sectionPortInterne(application),

    // Le fichier est composé par `printf` et non par `writeFileScript` : son contenu dépend
    // de `$port`, lu à l'exécution, et le heredoc quoté de `writeFileScript` — qui est
    // précisément ce qui le rend sûr — n'expanserait rien.
    //
    // Tout le reste est littéral : `domaine` a passé `DOMAIN_PATTERN`, `application` a passé
    // `APPLICATION_PATTERN`, et `$port` est borné à un nombre par la section précédente.
    "{",
    `  printf '%s\\n' ${q(`# Écrit par SkyNode pour l'application ${application}.`)}`,
    "  printf '%s\\n' " +
      q("# Ce fichier appartient à SkyNode : il est réécrit à chaque déploiement, et supprimé avec l'application."),
    `  printf '%s\\n' ${q(`${domaine} {`)}`,
    `  printf '\\treverse_proxy %s:%s\\n' ${q(application)} "$port"`,
    "  printf '%s\\n' " + q("}"),
    `} > ${q(brouillon)} || echec ` + q("Écriture du brouillon du fichier de site impossible."),

    // La sauvegarde sert au retour arrière si Caddy refuse la configuration produite : sans
    // elle, un site déjà publié et fonctionnel disparaîtrait au premier déploiement fautif.
    "avait_site=non",
    `if [ -f ${q(site)} ]; then`,
    "  avait_site=oui",
    `  cp -p ${q(site)} ${q(sauvegarde)} || echec ` +
      q("Sauvegarde du fichier de site existant impossible : rien n'a été modifié."),
    "fi",

    "site_change=non",
    `if cmp -s ${q(brouillon)} ${q(site)}; then`,
    `  rm -f ${q(brouillon)}`,
    "else",
    `  install -m 0644 -o root -g root ${q(brouillon)} ${q(site)} || echec ` +
      q(`Installation de ${site} impossible.`),
    `  rm -f ${q(brouillon)}`,
    "  site_change=oui",
    "  note " + q(`Fichier de site de ${application} écrit pour ${domaine}.`),
    "  applique=oui",
    "fi",

    // Le `Caddyfile` principal peut être celui d'un humain : bloc marqué, jamais de
    // redirection qui écraserait le fichier. On ne pose le bloc que si la ligne d'import
    // manque — un client qui l'aurait écrite lui-même, hors de tout bloc, est déjà servi.
    "import_change=non",
    `if ! grep -q -F -x -- ${q(LIGNE_IMPORT)} ${q(CHEMIN_CADDYFILE)} 2>/dev/null; then`,
    ...markerBlockScript(CHEMIN_CADDYFILE, MARQUEUR_IMPORT, LIGNE_IMPORT)
      .split("\n")
      .map((l) => "  " + l),
    // `markerBlockScript` ne dit pas lui-même s'il a abouti : une relecture le fait, et
    // évite de recharger Caddy sur une configuration qui ne référence pas nos sites.
    `  grep -q -F -x -- ${q(LIGNE_IMPORT)} ${q(CHEMIN_CADDYFILE)} 2>/dev/null || echec ` +
      q(`L'import des fichiers de site n'a pas pu être ajouté à ${CHEMIN_CADDYFILE}.`),
    "  import_change=oui",
    "  note " + q("Import des fichiers de site ajouté au Caddyfile principal, dans un bloc marqué."),
    "  applique=oui",
    "fi",

    // Rejouée, l'étape sort ici : ni le fichier de site ni l'import n'ont bougé, donc la
    // configuration que Caddy sert est déjà celle qu'on voulait. Sortir avant le
    // rechargement **et avant l'attente du certificat** est ce qui rend un nouvel essai sans
    // danger — un rechargement inutile relancerait une demande ACME.
    'if [ "$site_change" = non ] && [ "$import_change" = non ]; then',
    `  rm -f ${q(sauvegarde)}`,
    "  fin unchanged " + q(`Le site ${domaine} était déjà routé vers « ${application} » : rien à changer.`),
    "fi",

    // Le retour arrière de cette étape, en une fonction parce que deux chemins d'échec s'en
    // servent (invariant n°4).
    "defaire_site() {",
    '  if [ "$avait_site" = oui ]; then',
    `    mv ${q(sauvegarde)} ${q(site)} 2>/dev/null || rm -f ${q(site)}`,
    "  else",
    `    rm -f ${q(site)}`,
    "  fi",
    "}",

    // `validate` avant `reload` : un rechargement refusé laisse Caddy sur son ancienne
    // configuration — donc pas de casse — mais le fichier fautif resterait sur le disque et
    // ferait échouer le prochain démarrage du conteneur, celui-là définitivement.
    `if ! docker exec ${CADDY_CONTAINER} caddy validate --config ${CHEMIN_CADDYFILE} --adapter caddyfile >&2; then`,
    "  defaire_site",
    "  echec " +
      q(
        "La configuration produite est refusée par « caddy validate » : le fichier de site a été " +
          "retiré et rien n'a été rechargé."
      ),
    "fi",
    // Un `reload` refusé est atomique côté Caddy : le processus continue de servir la
    // configuration précédente. Il n'y a donc rien à recharger de nouveau ici, seulement le
    // fichier à remettre comme il était.
    `if ! docker exec ${CADDY_CONTAINER} caddy reload --config ${CHEMIN_CADDYFILE} --adapter caddyfile >&2; then`,
    "  defaire_site",
    "  echec " +
      q(
        "Le rechargement de Caddy a échoué : le fichier de site a été retiré et Caddy sert " +
          "toujours la configuration précédente."
      ),
    "fi",
    `rm -f ${q(sauvegarde)}`,

    // **Une seule attente, jamais de boucle.** Let's Encrypt plafonne les échecs de
    // validation à cinq par heure et par domaine ; un agent qui réessaie brûle ce plafond et
    // bloque le domaine du client pour l'après-midi. L'échéance n'est donc pas un échec :
    // Caddy poursuit ses tentatives de lui-même, et le rapport dit quoi vérifier.
    `sleep ${String(ATTENTE_CERTIFICAT_S)}`,
    `if docker exec ${CADDY_CONTAINER} find /data/caddy/certificates -type f -name ${q(`${domaine}.crt`)} 2>/dev/null | grep -q .; then`,
    "  note " + q(`Certificat TLS obtenu pour ${domaine}.`),
    "else",
    "  note " +
      q(
        `Certificat TLS pas encore émis pour ${domaine} après ${ATTENTE_CERTIFICAT_S} s : Caddy ` +
          `continue d'essayer de lui-même. Vérifier que ${domaine} pointe bien vers ce serveur ` +
          "(enregistrement A ou AAAA) et que 80 et 443 sont joignables depuis l'extérieur."
      ),
    "fi",
    'fin applied "$detail"',
  ].join("\n")
}

function scriptSiteUndo(domaine: string, application: string): string {
  const site = cheminSite(application)

  return [
    ...PREAMBULE,

    `if [ -f ${q(site)} ]; then`,
    `  rm -f ${q(site)} || echec ` + q(`Suppression de ${site} impossible.`),
    "  note " + q(`Fichier de site de ${application} supprimé : ${domaine} n'est plus routé.`),
    "  applique=oui",
    "fi",

    // Le bloc marqué du `Caddyfile` principal reste : il porte l'import de **tous** les
    // fichiers de site, et le retirer couperait le routage des autres applications de la
    // machine. Un motif qui ne correspond à aucun fichier n'est qu'un avertissement pour
    // Caddy, donc le laisser ne coûte rien même quand ce site était le dernier.
    `if docker inspect -f '{{.State.Running}}' ${CADDY_CONTAINER} 2>/dev/null | grep -qx true; then`,
    `  docker exec ${CADDY_CONTAINER} caddy reload --config ${CHEMIN_CADDYFILE} --adapter caddyfile >&2 || echec ` +
      q("Le fichier de site a été supprimé mais Caddy n'a pas pu être rechargé : il sert encore l'ancienne configuration."),
    "fi",

    'if [ "$applique" = oui ]; then',
    '  fin applied "$detail"',
    "fi",
    "fin unchanged " + q(`Aucun fichier de site pour « ${application} » : rien à défaire.`),
  ].join("\n")
}

/* ------------------------------------------------------------------------- recettes --- */

export const RECETTE_PROXY_CADDY_INSTALL: StepRecipe = Object.freeze({
  script(step: PlanStep): string {
    exigeType(step, "proxy.caddy.install")

    return SCRIPT_INSTALL
  },
  undoScript(step: PlanStep): string {
    exigeType(step, "proxy.caddy.install")

    return SCRIPT_INSTALL_UNDO
  },
})

export const RECETTE_PROXY_CADDY_SITE: StepRecipe = Object.freeze({
  script(step: PlanStep, ctx: { application: string }): string {
    const domaine = exigeMotif(
      exigeType(step, "proxy.caddy.site").domaine,
      DOMAIN_PATTERN,
      "un nom de domaine valide"
    )

    return scriptSite(domaine, ctx.application)
  },
  undoScript(step: PlanStep, ctx: { application: string }): string {
    const domaine = exigeMotif(
      exigeType(step, "proxy.caddy.site").domaine,
      DOMAIN_PATTERN,
      "un nom de domaine valide"
    )

    return scriptSiteUndo(domaine, ctx.application)
  },
})
