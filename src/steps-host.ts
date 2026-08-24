import type { PlanStep } from "./plan-types.js"
import { markerBlockScript, shellQuote, writeFileScript } from "./remote.js"
import type { StepRecipe } from "./step.js"

/**
 * Les deux étapes qui transforment une machine nue en hôte exploitable : la couche de
 * sécurité (`host.prepare`) et le moteur de conteneurs (`host.install_docker`).
 *
 * Ces scripts écrivent en root sur la machine d'un client payant. Trois principes les
 * gouvernent, et aucun n'est négociable :
 *
 * - **Rien d'arbitraire n'y entre.** `host.install_docker` n'interpole rien du tout ;
 *   `host.prepare` interpole une seule valeur, `swap_mo`, que `plan-types.ts` borne à un
 *   entier de 0 à 8192. Tout le reste est littéral.
 * - **On n'écrit jamais par-dessus un humain.** Un fichier déjà présent que SkyNode n'a pas
 *   posé est laissé tel quel (`/etc/apt/sources.list.d/docker.list`, l'`authorized_keys` de
 *   l'utilisateur applicatif) ; `/etc/fstab`, qui est forcément à quelqu'un d'autre, n'est
 *   touché que par un bloc marqué ; le pare-feu du client n'est jamais réinitialisé.
 * - **Rejoué, le script ne change rien et le dit.** Chaque section constate avant d'agir,
 *   et le résultat global est `unchanged` si aucune section n'a rien eu à faire.
 *
 * Le durcissement SSH n'est **pas** ici : c'est la seule opération du produit dont l'échec
 * est irréparable à distance, et elle a sa propre tâche avec son protocole de reconnexion.
 * Ces scripts ne touchent donc ni à `sshd_config`, ni à `sshd_config.d/`, ni au service
 * `ssh` — un test le vérifie, parce qu'un durcissement glissé ici échapperait au filet
 * qu'on lui construit ailleurs.
 */

/** Le compte non-root qui fait tourner les applications. Jamais celui du client. */
export const UTILISATEUR_APPLICATIF = "skynode"

/**
 * Le seul trafic entrant admis, dans cet ordre. **22 en tête n'est pas cosmétique** :
 * les règles sont posées dans l'ordre du tableau, et le pare-feu n'est activé qu'ensuite.
 * Inverser reviendrait à couper la session par laquelle l'étape s'exécute — le serveur
 * resterait à mi-chemin, et l'exécuteur ne pourrait même pas défaire ce qu'il a fait.
 */
export const PORTS_ENTRANTS: readonly number[] = [22, 80, 443]

/**
 * L'empreinte de la clé de signature du dépôt Docker officiel.
 *
 * TLS authentifie déjà `download.docker.com` ; ce contrôle-ci porte plus loin — il refuse
 * une clé qui aurait changé sans qu'on le décide, quelle qu'en soit la raison. Le prix est
 * assumé : si Docker publie un jour une nouvelle clé, l'installation s'arrête net en
 * nommant l'empreinte reçue. Un arrêt bruyant vaut mieux qu'un dépôt de paquets root
 * signé par une clé que personne n'a regardée.
 */
export const EMPREINTE_CLE_DOCKER = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

/** Là où SkyNode range ce qui lui appartient, fermé aux autres comptes. */
const REPERTOIRE_SKYNODE = "/etc/skynode"

/**
 * Un fichier temporaire à chemin **littéral**, sous un répertoire en 0700 qui n'appartient
 * qu'à root : `mktemp` rendrait un chemin dans une variable, que `writeFileScript` ne sait
 * pas viser — il met son argument en sécurité, donc le prendrait pour un nom de fichier.
 * Passer par `/tmp` exposerait de surcroît un contenu qui devient parfois du `sudoers`.
 */
const brouillon = (nom: string): string => `${REPERTOIRE_SKYNODE}/.brouillon-${nom}`

/**
 * Le préambule commun. `set -e` en est volontairement absent : chaque commande qui peut
 * échouer le dit elle-même par `|| echec …`, ce qui nomme la section fautive dans le
 * rapport. Sous `set -e`, le script mourrait sans rendre son marqueur de fin et
 * `runRemote` lirait une connexion coupée là où il n'y a qu'un paquet manquant.
 */
const PREAMBULE: readonly string[] = [
  "set -u",
  "emit() { printf '%s\\t%s\\n' \"$1\" \"$2\"; }",
  "fin() { emit step.outcome \"$1\"; emit step.detail \"$2\"; emit step.end 1; exit 0; }",
  "echec() { fin failed \"$1\"; }",
  "detail=''",
  // `${detail:+…}` évite l'espace en tête quand c'est la première note : le rapport part
  // tel quel dans `step.detail`, et un exécuteur le recopie sans le relire.
  "note() { detail=\"${detail:+$detail }$1\"; }",
  "applique=non",
  // Tout ce qui suit écrit dans /etc et gère des services. Un script qui tenterait la
  // même chose sans les droits laisserait la machine à moitié préparée en croyant avoir
  // fait la moitié du travail ; on refuse avant d'avoir touché quoi que ce soit.
  "if [ \"$(id -u)\" != 0 ]; then",
  "  echec " + shellQuote("Cette étape doit s'exécuter en root : ouvrir la session en root, ou passer le script à « sudo sh -s »."),
  "fi",
]

/**
 * Comment `apt-get` est invoqué, partout et sans exception.
 *
 * `DEBIAN_FRONTEND=noninteractive` parce qu'une invite de `dpkg` — celle d'un fichier de
 * configuration modifié, typiquement — attendrait une réponse qui n'arrivera jamais et
 * bloquerait la session jusqu'au délai. Jamais `apt-get upgrade` : on installe ce qu'on a
 * annoncé au client, rien d'autre ; les mises à jour de sécurité sont le travail
 * d'`unattended-upgrades`, qui est justement ce que cette étape met en place.
 */
const APT = "DEBIAN_FRONTEND=noninteractive apt-get"

/**
 * `apt-get`, `ufw` et `systemctl` racontent leur travail sur la sortie standard — or c'est
 * elle qui porte le protocole d'étape que `runRemote` lit. Leur sortie part donc sur
 * `stderr` (`>&2`), et non dans `/dev/null` : `runRemote` joint `stderr` au diagnostic
 * quand l'étape échoue, et jeter ces lignes-là reviendrait à effacer précisément ce qui
 * explique la panne.
 */

/** Les paquets que `host.prepare` pose, dans l'ordre où le script en parle. */
const PAQUETS_PREPARE: readonly string[] = ["ufw", "fail2ban", "unattended-upgrades"]

/**
 * La règle `sudo` du compte applicatif, dans son propre fichier de `sudoers.d/` : le
 * `/etc/sudoers` du client n'est jamais ouvert, et retirer ce fichier suffit à revenir en
 * arrière.
 *
 * Pas de spécification d'exécutant — `ALL=(ALL) NOPASSWD: ALL`, la forme qu'on écrit
 * d'ordinaire — pour deux raisons. La première est de fond : sans elle, l'exécutant est
 * `root` et rien d'autre ; l'écrire donnerait au compte applicatif le droit de devenir
 * **n'importe quel** utilisateur de la machine, y compris ceux du client, ce dont le
 * produit n'a aucun usage. La seconde est mécanique : `ALL=(` déclenche le contrôle
 * « pas de bashisme » de `step.ts`, qui y lit une affectation de tableau `nom=(…)`. Le
 * motif ne se trompe pas de beaucoup — il ne peut simplement pas savoir que ces octets-là
 * voyagent dans un heredoc quoté et ne seront jamais interprétés par `sh`.
 */
const REGLE_SUDO: readonly string[] = [
  "# Écrit par SkyNode. Retirer ce fichier retire l'élévation du compte applicatif.",
  `${UTILISATEUR_APPLICATIF} ALL=NOPASSWD: ALL`,
]

/**
 * La prison `sshd` de fail2ban, dans `jail.d/` — jamais dans `jail.conf`, qui appartient à
 * la distribution.
 *
 * `backend = systemd` parce qu'Ubuntu 24.04 n'installe plus `rsyslog` : `/var/log/auth.log`
 * n'existe pas, et une prison qui le lit ne démarre pas du tout. Le service passerait alors
 * pour actif dans le rapport sans surveiller quoi que ce soit.
 */
export const CONFIG_FAIL2BAN: string = [
  "# Écrit par SkyNode. Retirer ce fichier revient au réglage de la distribution.",
  "[sshd]",
  "enabled = true",
  "backend = systemd",
  "maxretry = 5",
  "findtime = 10m",
  "bantime = 1h",
  "",
].join("\n")

/**
 * `unattended-upgrades` limité aux correctifs de sécurité.
 *
 * Les deux `#clear` sont le cœur du fichier : **les listes d'APT sont additives**. Sans
 * eux, ces origines s'ajouteraient à celles de `50unattended-upgrades` au lieu de les
 * remplacer, et `-updates` resterait autorisé — le fichier aurait l'air de restreindre
 * quelque chose sans rien restreindre du tout. Les deux clés sont vidées parce que Ubuntu
 * emploie `Allowed-Origins` et Debian `Origins-Pattern` ; ne vider que la première
 * laisserait la seconde en place sur une Debian.
 *
 * Les origines ESM ne concernent qu'Ubuntu ; sur une Debian elles ne correspondent à aucun
 * dépôt et sont simplement ignorées. Toutes se terminent par `-security`, et un test le
 * vérifie ligne à ligne plutôt que de se fier à l'absence d'un motif.
 */
export const CONFIG_UNATTENDED: string = [
  "// Écrit par SkyNode. Retirer ce fichier revient au réglage de la distribution.",
  "// Les listes APT sont additives : sans ces #clear, les origines ci-dessous",
  "// s'ajouteraient à celles de 50unattended-upgrades au lieu de les remplacer.",
  "#clear Unattended-Upgrade::Allowed-Origins;",
  "#clear Unattended-Upgrade::Origins-Pattern;",
  "Unattended-Upgrade::Allowed-Origins {",
  '        "${distro_id}:${distro_codename}-security";',
  '        "${distro_id}ESMApps:${distro_codename}-apps-security";',
  '        "${distro_id}ESM:${distro_codename}-infra-security";',
  "};",
  'APT::Periodic::Update-Package-Lists "1";',
  'APT::Periodic::Unattended-Upgrade "1";',
  "",
].join("\n")

/** Trié après `50unattended-upgrades`, sans quoi la distribution reprendrait la main. */
const CHEMIN_UNATTENDED = "/etc/apt/apt.conf.d/51skynode-securite"
const CHEMIN_FAIL2BAN = "/etc/fail2ban/jail.d/50-skynode.conf"
const CHEMIN_SUDOERS = `/etc/sudoers.d/90-${UTILISATEUR_APPLICATIF}`

/**
 * Pose un fichier que SkyNode possède entièrement, sans le réécrire s'il est déjà
 * identique — c'est ce qui rend l'étape idempotente là où une écriture inconditionnelle
 * ferait rendre `applied` à chaque passage.
 *
 * `variable` reçoit `oui` quand le fichier a réellement changé : les services qui lisent
 * ce fichier ne sont rechargés que dans ce cas.
 */
function poseFichier(
  nom: string,
  chemin: string,
  contenu: string,
  mode: string,
  variable: string,
  /** La phrase exacte du rapport quand le fichier a bougé. */
  intitule: string,
  /**
   * Ce qui doit valider le brouillon **avant** qu'il devienne le fichier définitif. Un
   * contrôle joué après l'installation ne servirait à rien : le mal serait fait.
   */
  controle: readonly string[] = []
): string[] {
  const tmp = brouillon(nom)

  return [
    // Le contenu passe par `writeFileScript` : heredoc quoté, donc aucune expansion de
    // variable ni substitution de commande dans le fichier écrit — les `${distro_id}` de
    // la configuration APT doivent arriver littéralement chez le client.
    ...writeFileScript(tmp, contenu, "0600").split("\n"),
    ...controle,
    `if cmp -s ${shellQuote(tmp)} ${shellQuote(chemin)}; then`,
    `  ${variable}=non`,
    "else",
    `  install -m ${mode} -o root -g root ${shellQuote(tmp)} ${shellQuote(chemin)} || echec ` +
      shellQuote(`Écriture de ${chemin} impossible.`),
    `  ${variable}=oui`,
    `  note ${shellQuote(intitule)}`,
    "  applique=oui",
    "fi",
    `rm -f ${shellQuote(tmp)}`,
  ]
}

/* ------------------------------------------------------------------ install_docker --- */

/**
 * Le dépôt officiel, jamais le paquet `docker.io` de la distribution : celui d'Ubuntu est
 * souvent en retard de plusieurs versions majeures et n'apporte pas le greffon `compose`,
 * dont tout le reste du jalon dépend.
 */
const SCRIPT_INSTALL_DOCKER: string = [
  ...PREAMBULE,

  // Trois conditions, pas une : `docker` présent ne dit pas que le démon répond, et un
  // démon qui répond ne dit pas que le greffon compose est là. La sonde du jalon 2 fait
  // déjà cette distinction ; la refaire ici évite de rendre `unchanged` sur une
  // installation partielle qu'il faudrait compléter.
  "docker_ok=non",
  "if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then",
  "  docker_ok=oui",
  "fi",

  // L'appartenance au groupe est constatée à part : `host.prepare` peut n'avoir pas encore
  // créé le compte applicatif. Rendre `unchanged` sur le seul état de Docker laisserait
  // alors le compte hors du groupe pour de bon, et la première construction demanderait un
  // mot de passe qui n'arrivera jamais.
  "groupe_ok=non",
  "if id -u " + UTILISATEUR_APPLICATIF + " >/dev/null 2>&1; then",
  "  case \" $(id -nG " + UTILISATEUR_APPLICATIF + " 2>/dev/null) \" in",
  "    *\" docker \"*) groupe_ok=oui ;;",
  "  esac",
  "else",
  "  groupe_ok=oui",
  "fi",

  "if [ \"$docker_ok\" = oui ] && [ \"$groupe_ok\" = oui ]; then",
  "  fin unchanged " + shellQuote("Docker répond déjà à « docker info », greffon compose compris : rien à installer."),
  "fi",

  "if [ \"$docker_ok\" = non ]; then",
  // `/etc/os-release` est lu pour deux valeurs seulement, et `ID` est immédiatement
  // restreint à `ubuntu` ou `debian` : ce sont les deux seuls chemins de dépôt que Docker
  // publie sous cette forme, et c'est ce `case` qui autorise l'interpolation plus bas.
  "  if [ ! -r /etc/os-release ]; then",
  "    echec " + shellQuote("Distribution inconnue : /etc/os-release est illisible."),
  "  fi",
  "  . /etc/os-release",
  "  case \"${ID:-}\" in",
  "    ubuntu|debian) : ;;",
  "    *) echec " + shellQuote("Seules Ubuntu et Debian sont prises en charge par le dépôt Docker officiel.") + " ;;",
  "  esac",
  "  nom_code=\"${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}\"",
  "  if [ -z \"$nom_code\" ]; then",
  "    echec " + shellQuote("Distribution sans nom de code : impossible de désigner la bonne suite du dépôt Docker."),
  "  fi",

  `  ${APT} update -qq >&2 || echec ` + shellQuote("Le rafraîchissement des index APT a échoué avant l'installation de Docker."),
  `  ${APT} install -y -qq ca-certificates curl gnupg >&2 || echec ` +
    shellQuote("Installation de ca-certificates, curl et gnupg impossible."),
  "  install -m 0755 -d /etc/apt/keyrings || echec " + shellQuote("Création de /etc/apt/keyrings impossible."),

  // La clé est téléchargée à côté, vérifiée, et seulement ensuite installée : une clé
  // inattendue ne doit jamais séjourner, même une seconde, à l'endroit qu'APT consulte.
  "  cle=$(mktemp) || echec " + shellQuote("Création d'un fichier temporaire impossible."),
  // `${ID}` ne peut valoir que `ubuntu` ou `debian` — le `case` ci-dessus l'a établi.
  "  if ! curl -fsSL \"https://download.docker.com/linux/${ID}/gpg\" -o \"$cle\"; then",
  "    rm -f \"$cle\"",
  "    echec " + shellQuote("Téléchargement de la clé du dépôt Docker impossible."),
  "  fi",
  // `gpg` écrit dans son répertoire personnel dès qu'on l'invoque ; un `GNUPGHOME` jetable
  // évite de laisser un trousseau dans le `/root` du client pour une seule lecture.
  "  gpgdir=$(mktemp -d) || echec " + shellQuote("Création d'un répertoire temporaire impossible."),
  "  empreinte=$(GNUPGHOME=\"$gpgdir\" gpg --batch --show-keys --with-colons \"$cle\" 2>/dev/null | awk -F: '$1==\"fpr\" {print $10; exit}')",
  "  rm -rf \"$gpgdir\"",
  "  if [ \"$empreinte\" != " + shellQuote(EMPREINTE_CLE_DOCKER) + " ]; then",
  "    rm -f \"$cle\"",
  "    echec " + shellQuote("La clé servie par download.docker.com n'a pas l'empreinte attendue : installation refusée.") ,
  "  fi",
  "  install -m 0644 -o root -g root \"$cle\" /etc/apt/keyrings/docker.asc || echec " +
    shellQuote("Installation de la clé du dépôt Docker impossible."),
  "  rm -f \"$cle\"",

  // Un `docker.list` déjà présent est celui du client ou celui d'un passage précédent :
  // dans les deux cas on le laisse. Le réécrire changerait la suite ou la clé d'un dépôt
  // que quelqu'un d'autre a choisi.
  "  if [ ! -f /etc/apt/sources.list.d/docker.list ]; then",
  "    printf '%s\\n' " +
    shellQuote("# Écrit par SkyNode. Retirer ce fichier retire le dépôt Docker officiel.") +
    " \"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${nom_code} stable\" > /etc/apt/sources.list.d/docker.list || echec " +
    shellQuote("Écriture de /etc/apt/sources.list.d/docker.list impossible."),
  "  fi",

  `  ${APT} update -qq >&2 || echec ` + shellQuote("Le rafraîchissement des index APT a échoué après l'ajout du dépôt Docker."),
  `  ${APT} install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >&2 || echec ` +
    shellQuote("Installation des paquets Docker depuis le dépôt officiel impossible."),
  "  systemctl enable --now docker >&2 || echec " +
    shellQuote("Le service docker n'a pas pu être activé."),
  // Installé n'est pas utilisable : c'est `docker info` qui fait foi, ici comme dans la
  // sonde. Sans ce contrôle, l'étape rendrait `applied` sur un démon qui ne démarre pas.
  "  docker info >/dev/null || echec " +
    shellQuote("Docker est installé mais « docker info » ne répond pas : le démon n'a pas démarré."),
  "  note " + shellQuote("Docker installé depuis le dépôt officiel (greffon compose compris) et service activé."),
  "  applique=oui",
  "fi",

  "if [ \"$groupe_ok\" = non ]; then",
  "  usermod -aG docker " + UTILISATEUR_APPLICATIF + " || echec " +
    shellQuote("Ajout du compte applicatif au groupe docker impossible."),
  "  note " + shellQuote("Compte applicatif ajouté au groupe docker."),
  "  applique=oui",
  "fi",

  // Pas de branche `unchanged` ici : le seul cas où rien n'était à faire est sorti plus
  // haut, et l'une des deux moitiés a forcément agi pour arriver jusqu'ici.
  "fin applied \"$detail\"",
].join("\n")

/* ------------------------------------------------------------------------ prepare --- */

/** Le compte applicatif, son élévation, et la clé qui permettra de s'y connecter. */
function sectionCompte(): string[] {
  const u = UTILISATEUR_APPLICATIF

  return [
    "if id -u " + u + " >/dev/null 2>&1; then",
    "  :",
    "else",
    "  useradd --create-home --shell /bin/bash --comment " +
      shellQuote("Compte applicatif SkyNode") +
      " " + u + " || echec " + shellQuote("Création du compte applicatif impossible."),
    "  note " + shellQuote("Compte applicatif créé."),
    "  applique=oui",
    "fi",

    // Le foyer est lu dans la base de comptes, pas supposé : un compte préexistant peut
    // très bien vivre ailleurs que sous /home. Le contrôle qui suit refuse tout ce qui
    // n'est pas un chemin absolu — un foyer relatif ferait écrire la clé au hasard du
    // répertoire courant.
    "foyer=$(getent passwd " + u + " | cut -d: -f6)",
    "case \"${foyer:-}\" in",
    "  /*) : ;;",
    "  *) echec " + shellQuote("Le compte applicatif n'a pas de répertoire personnel absolu.") + " ;;",
    "esac",
    "groupe=$(id -gn " + u + ") || echec " + shellQuote("Groupe principal du compte applicatif introuvable."),

    ...poseFichier(
      "sudoers",
      CHEMIN_SUDOERS,
      REGLE_SUDO.join("\n") + "\n",
      "0440",
      "sudo_change",
      "Élévation sudo sans mot de passe du compte applicatif posée.",
      // `visudo -c` avant d'installer, jamais après : un fichier invalide dans `sudoers.d`
      // fait refuser **toute** élévation sur la machine, y compris celle qui permettrait
      // de le réparer. Le contrôle porte donc sur le brouillon, et le fichier définitif
      // n'est posé que si le brouillon passe.
      [
        `visudo -c -q -f ${shellQuote(brouillon("sudoers"))} >/dev/null 2>&1 || { rm -f ${shellQuote(brouillon("sudoers"))}; echec ` +
          shellQuote("La règle sudo produite est refusée par visudo : rien n'a été installé.") +
          "; }",
      ]
    ),
  ]
}

/** La clé qui ouvre le compte applicatif, reprise de celle qui a ouvert la session. */
function sectionCle(): string[] {
  return [
    // Jamais par-dessus : un `authorized_keys` déjà garni est celui du client, et
    // l'écraser lui retirerait son propre accès. On ne pose que dans le vide.
    "if [ ! -s \"$foyer/.ssh/authorized_keys\" ] && [ -s /root/.ssh/authorized_keys ]; then",
    "  install -d -m 0700 -o " + UTILISATEUR_APPLICATIF + " -g \"$groupe\" \"$foyer/.ssh\" || echec " +
      shellQuote("Création du répertoire .ssh du compte applicatif impossible."),
    "  install -m 0600 -o " + UTILISATEUR_APPLICATIF + " -g \"$groupe\" /root/.ssh/authorized_keys \"$foyer/.ssh/authorized_keys\" || echec " +
      shellQuote("Copie de la clé autorisée vers le compte applicatif impossible."),
    "  note " + shellQuote("Clé autorisée de la session recopiée sur le compte applicatif."),
    "  applique=oui",
    "fi",
  ]
}

/** Le répertoire de SkyNode, fermé aux autres comptes : il portera des secrets. */
function sectionRepertoire(): string[] {
  const d = shellQuote(REPERTOIRE_SKYNODE)

  return [
    `if [ ! -d ${d} ]; then`,
    `  install -d -m 0700 -o root -g root ${d} || echec ` + shellQuote(`Création de ${REPERTOIRE_SKYNODE} impossible.`),
    "  note " + shellQuote(`${REPERTOIRE_SKYNODE} créé en 0700.`),
    "  applique=oui",
    "else",
    // Un répertoire existant au mauvais mode est corrigé, mais pas recréé : son contenu
    // est celui des passages précédents.
    `  mode=$(stat -c '%a' ${d} 2>/dev/null || echo '')`,
    "  if [ \"$mode\" != 700 ]; then",
    `    chmod 0700 ${d} || echec ` + shellQuote(`Correction du mode de ${REPERTOIRE_SKYNODE} impossible.`),
    "    note " + shellQuote(`${REPERTOIRE_SKYNODE} refermé en 0700.`),
    "    applique=oui",
    "  fi",
    "fi",
  ]
}

/** Les paquets de la préparation, en un seul passage d'APT quand il en manque. */
function sectionPaquets(): string[] {
  return [
    "manquants=''",
    "for p in " + PAQUETS_PREPARE.join(" ") + "; do",
    // `dpkg-query` plutôt que `command -v` : `unattended-upgrades` n'apporte pas de binaire
    // qui porte son nom, et un `command -v` le croirait absent à chaque passage.
    "  if ! dpkg-query -W -f='${Status}' \"$p\" 2>/dev/null | grep -q 'ok installed'; then",
    "    manquants=\"$manquants $p\"",
    "  fi",
    "done",
    "if [ -n \"$manquants\" ]; then",
    `  ${APT} update -qq >&2 || echec ` + shellQuote("Le rafraîchissement des index APT a échoué."),
    // Découpage en mots voulu : `$manquants` est une liste de noms de paquets pris dans la
    // constante `PAQUETS_PREPARE`, jamais dans le plan.
    `  ${APT} install -y -qq $manquants >&2 || echec ` + shellQuote("Installation des paquets de préparation impossible."),
    "  note " + shellQuote("Paquets de préparation installés."),
    "  applique=oui",
    "fi",
  ]
}

/**
 * Le fichier d'échange. Deux constats avant d'agir, parce qu'aucun des deux ne suffit :
 * `swapon --show` dit ce qui est actif, `/swapfile` dit ce qui est posé mais peut-être pas
 * monté. On ne remplace jamais un échange que quelqu'un d'autre a mis en place.
 */
function sectionSwap(swapMo: number): string[] {
  // La seule valeur du plan qui entre dans un script de ce module. `HostPrepare`
  // (`plan-types.ts`) la déclare `z.number().int().min(0).max(8192)` : Zod refuse le plan
  // avant qu'elle arrive ici si ce n'est pas un entier de cet intervalle, donc rien
  // d'autre qu'un nombre ne peut être interpolé.
  const mo = String(swapMo)

  return [
    "swap_actif=non",
    "if [ -r /proc/swaps ] && [ \"$(awk 'NR>1' /proc/swaps 2>/dev/null | wc -l)\" -gt 0 ]; then swap_actif=oui; fi",
    "if [ -n \"$(swapon --show=NAME --noheadings 2>/dev/null)\" ]; then swap_actif=oui; fi",
    "if [ \"$swap_actif\" = non ] && [ ! -e /swapfile ]; then",
    // `fallocate` échoue sur certains systèmes de fichiers (Btrfs notamment), et le fichier
    // qu'il laisse alors derrière lui ferait échouer `mkswap` ; d'où le retrait avant le
    // repli sur `dd`, qui marche partout au prix du temps d'écriture.
    "  if ! fallocate -l " + mo + "M /swapfile 2>/dev/null; then",
    "    rm -f /swapfile",
    "    if ! dd if=/dev/zero of=/swapfile bs=1M count=" + mo + " status=none 2>/dev/null; then",
    "      rm -f /swapfile",
    "      echec " + shellQuote("Création du fichier d'échange impossible : ni fallocate ni dd n'ont abouti."),
    "    fi",
    "  fi",
    // 0600 avant `mkswap` : un fichier d'échange lisible par tous exposerait la mémoire
    // des processus. `mkswap` refuse d'ailleurs de travailler sur un fichier trop ouvert.
    "  chmod 0600 /swapfile || echec " + shellQuote("Le mode du fichier d'échange n'a pas pu être restreint."),
    "  if ! mkswap /swapfile >/dev/null 2>&1; then",
    "    rm -f /swapfile",
    "    echec " + shellQuote("Le formatage du fichier d'échange a échoué."),
    "  fi",
    // Un échec de `swapon` laisse un fichier inutile : on le retire plutôt que d'abandonner
    // deux gigaoctets sur le disque d'un client sans rien lui dire.
    "  if ! swapon /swapfile 2>/dev/null; then",
    "    rm -f /swapfile",
    "    echec " + shellQuote("Le fichier d'échange a été créé mais le noyau a refusé de l'activer."),
    "  fi",
    // `/etc/fstab` appartient forcément à quelqu'un d'autre : bloc marqué, jamais de
    // redirection qui écraserait le fichier.
    "  if ! grep -q '^/swapfile' /etc/fstab 2>/dev/null; then",
    ...markerBlockScript("/etc/fstab", "skynode-swap", "/swapfile none swap sw 0 0")
      .split("\n")
      .map((l) => "    " + l),
    "  fi",
    "  note " + shellQuote(`Fichier d'échange de ${mo} Mo créé et activé.`),
    "  applique=oui",
    "fi",
  ]
}

/**
 * Le pare-feu. **L'ordre de cette section est la chose la plus importante du module** :
 * les autorisations d'abord, la vérification qu'elles sont bien enregistrées ensuite,
 * l'activation en dernier. Activer avant d'autoriser le port 22 couperait la session par
 * laquelle l'étape s'exécute, et personne — ni l'exécuteur, ni le client — ne pourrait
 * plus ni finir ni défaire.
 */
function sectionPareFeu(): string[] {
  const lignes: string[] = [
    // Un pare-feu déjà conforme n'est pas retouché : `ufw --force enable` sur une
    // installation déjà active recharge les règles, ce qui suffirait à faire rendre
    // `applied` à chaque passage.
    "ufw_pret=non",
    "if ufw status verbose 2>/dev/null | grep -q '^Status: active'; then",
    "  if ufw status verbose 2>/dev/null | grep -q 'deny (incoming)'; then",
    "    ouverts=oui",
    "    for port in " + PORTS_ENTRANTS.join(" ") + "; do",
    "      ufw status 2>/dev/null | grep -q \"^$port/tcp\" || ouverts=non",
    "    done",
    "    if [ \"$ouverts\" = oui ]; then ufw_pret=oui; fi",
    "  fi",
    "fi",
    "if [ \"$ufw_pret\" = non ]; then",
  ]

  for (const port of PORTS_ENTRANTS) {
    // `/tcp` explicite : `ufw allow 22` ouvrirait aussi l'UDP, que rien de ce produit
    // n'écoute. Les trois ports viennent de `PORTS_ENTRANTS`, pas du plan.
    lignes.push(
      "  ufw allow " + port + "/tcp >&2 || echec " +
        shellQuote(`Le port ${port} n'a pas pu être autorisé dans le pare-feu.`)
    )
  }

  lignes.push(
    // Le filet. `ufw status` ne montre rien tant que le pare-feu est inactif ; `ufw show
    // added` rend les règles enregistrées dans les deux cas. Si le port 22 n'y est pas,
    // activer reviendrait à se couper la branche : on s'arrête avant, pare-feu inactif.
    "  ufw show added 2>/dev/null | grep -q 'allow 22/tcp' || echec " +
      shellQuote("Activation refusée : la règle du port 22 n'est pas enregistrée, l'activer couperait la session en cours."),
    "  ufw default deny incoming >&2 || echec " +
      shellQuote("Le refus par défaut du trafic entrant n'a pas pu être posé."),
    "  ufw default allow outgoing >&2 || echec " +
      shellQuote("L'autorisation par défaut du trafic sortant n'a pas pu être posée."),
    "  ufw --force enable >&2 || echec " + shellQuote("L'activation du pare-feu a échoué."),
    "  note " + shellQuote("Pare-feu actif : tout entrant refusé, 22, 80 et 443 ouverts."),
    "  applique=oui",
    "fi"
  )

  return lignes
}

/** fail2ban, sa prison `sshd`, et son rechargement — seulement si sa prison a changé. */
function sectionFail2ban(): string[] {
  return [
    ...poseFichier("fail2ban", CHEMIN_FAIL2BAN, CONFIG_FAIL2BAN, "0644", "jail_change", "Prison fail2ban de sshd posée."),
    "if ! systemctl is-enabled fail2ban >/dev/null 2>&1 || ! systemctl is-active fail2ban >/dev/null 2>&1; then",
    "  systemctl enable --now fail2ban >&2 || echec " +
      shellQuote("Le service fail2ban n'a pas pu être activé."),
    "  note " + shellQuote("Service fail2ban activé."),
    "  applique=oui",
    "elif [ \"$jail_change\" = oui ]; then",
    // Un `reload` plutôt qu'un `restart` : le service peut être celui du client, et
    // l'arrêter — même une seconde — lèverait sa protection pendant ce temps.
    "  systemctl reload fail2ban >&2 || echec " +
      shellQuote("La nouvelle prison fail2ban n'a pas pu être rechargée."),
    "fi",
  ]
}

/** Les mises à jour automatiques, réduites aux correctifs de sécurité. */
function sectionMisesAJour(): string[] {
  return [
    ...poseFichier("apt", CHEMIN_UNATTENDED, CONFIG_UNATTENDED, "0644", "apt_change", "Mises à jour automatiques restreintes aux correctifs de sécurité."),
    "if ! systemctl is-enabled unattended-upgrades >/dev/null 2>&1; then",
    "  systemctl enable --now unattended-upgrades >&2 || echec " +
      shellQuote("Le service unattended-upgrades n'a pas pu être activé."),
    "  note " + shellQuote("Service unattended-upgrades activé."),
    "  applique=oui",
    "fi",
  ]
}

/**
 * Le compte applicatif est ajouté au groupe `docker` ici aussi, et pas seulement dans
 * `host.install_docker` : l'ordre des deux étapes n'est pas garanti, et celle qui passe en
 * second est la seule à pouvoir constater les deux moitiés. Sans cela, un plan qui
 * installe Docker avant de préparer l'hôte laisserait le compte hors du groupe pour de bon.
 */
function sectionGroupeDocker(): string[] {
  const u = UTILISATEUR_APPLICATIF

  return [
    "if getent group docker >/dev/null 2>&1; then",
    "  dans_groupe=non",
    "  case \" $(id -nG " + u + " 2>/dev/null) \" in",
    "    *\" docker \"*) dans_groupe=oui ;;",
    "  esac",
    "  if [ \"$dans_groupe\" = non ]; then",
    "    usermod -aG docker " + u + " || echec " + shellQuote("Ajout du compte applicatif au groupe docker impossible."),
    "    note " + shellQuote("Compte applicatif ajouté au groupe docker."),
    "    applique=oui",
    "  fi",
    "fi",
  ]
}

function scriptPrepare(swapMo: number): string {
  return [
    ...PREAMBULE,
    ...sectionRepertoire(),
    ...sectionCompte(),
    ...sectionCle(),
    ...sectionPaquets(),
    // Le fichier d'échange n'est produit que si le plan en demande un. `swap_mo: 0` ne veut
    // pas dire « un échange de zéro octet », il veut dire « pas d'échange » — et la section
    // entière disparaît alors du script plutôt que d'y rester en dormance.
    ...(swapMo > 0 ? sectionSwap(swapMo) : []),
    ...sectionPareFeu(),
    ...sectionFail2ban(),
    ...sectionMisesAJour(),
    ...sectionGroupeDocker(),
    "if [ \"$applique\" = oui ]; then",
    "  fin applied \"$detail\"",
    "fi",
    "fin unchanged " + shellQuote("Rien à faire : l'hôte était déjà préparé."),
  ].join("\n")
}

/* ----------------------------------------------------------------------- recettes --- */

/**
 * Une recette ne doit jamais lire une étape d'un autre type : les champs qu'elle attend
 * n'y seraient pas, et TypeScript ne protège pas un exécuteur qui aurait perdu le lien
 * entre le type et la recette. Lever nomme la confusion au lieu de produire un script
 * incomplet.
 */
function exigeType<T extends PlanStep["type"]>(step: PlanStep, type: T): Extract<PlanStep, { type: T }> {
  if (step.type !== type) {
    throw new Error(`La recette de « ${type} » a reçu une étape de type « ${step.type} ».`)
  }

  return step as Extract<PlanStep, { type: T }>
}

export const RECETTE_HOST_PREPARE: StepRecipe = Object.freeze({
  script(step: PlanStep): string {
    return scriptPrepare(exigeType(step, "host.prepare").swap_mo)
  },
  // Irréversible, et c'est un fait, pas un manque : on ne retire pas un pare-feu qu'on
  // vient de poser, on ne supprime pas un compte qui fait peut-être déjà tourner quelque
  // chose. L'exécuteur le dira dans son rapport plutôt que de promettre un retour arrière.
  undoScript: (): null => null,
})

export const RECETTE_HOST_INSTALL_DOCKER: StepRecipe = Object.freeze({
  script(step: PlanStep): string {
    exigeType(step, "host.install_docker")

    return SCRIPT_INSTALL_DOCKER
  },
  // Irréversible : désinstaller Docker emporterait les conteneurs et les volumes de tout
  // ce qui tourne déjà sur la machine, y compris ce que SkyNode n'y a pas mis.
  undoScript: (): null => null,
})
