import type { Outcome } from "./remote.js"
import { shellQuote, writeFileScript } from "./remote.js"
import type { SshResult, SshRunner, SshTarget } from "./ssh.js"
import { explainSsh } from "./ssh.js"

/**
 * Le durcissement SSH, et le filet sans lequel il ne doit pas exister.
 *
 * **C'est la seule opération du produit dont l'échec est irréparable à distance.** Un client
 * enfermé hors de son serveur n'a plus que la console de secours de son hébergeur, et
 * beaucoup ignorent qu'elle existe. Tout ce qui suit découle de là : en cas de doute, on ne
 * durcit pas.
 *
 * Ce n'est pas une recette d'étape, et ça ne peut pas l'être : les points 2 et 6 du
 * protocole exigent d'**ouvrir de vraies sessions SSH** en tant que compte applicatif, ce
 * qu'un script envoyé dans une session ne sait pas faire. D'où `needsSecondSession` sur la
 * recette de `host.prepare`, et cette fonction, qui reçoit le `SshRunner`.
 *
 * Le protocole, dans cet ordre, sans raccourci :
 *
 * 1. `/etc/ssh/sshd_config` porte-t-il l'`Include` du répertoire ? Sinon, on ne durcit pas.
 * 2. Une session en tant que compte applicatif passe-t-elle, avec `sudo -n true` ? Sinon,
 *    on ne durcit pas : couper l'authentification par mot de passe fermerait la seule autre
 *    porte.
 * 3. Écrire `50-skynode.conf`.
 * 4. `sshd -t` : configuration refusée, on retire le fichier et on ne recharge pas.
 * 5. Recharger — `reload`, **jamais** `restart`, qui coupe les sessions en cours, y compris
 *    celle par laquelle on travaille.
 * 6. Une troisième session en tant que compte applicatif. Elle échoue : on retire, on
 *    recharge, on vérifie que la porte se rouvre, et on rend `failed`.
 *
 * **Et une septième chose, que le plan ne prévoyait pas.** Écrire le fichier ne garantit pas
 * que ses directives prennent effet : l'`Include` est en tête de `sshd_config`, le glob
 * s'ordonne lexicalement, et `sshd_config(5)` retient **la première valeur obtenue**. Un
 * `00-hardening.conf` déjà posé chez le client l'emporte donc sur le nôtre — cas mesuré sur
 * une Ubuntu 24.04 en production. On relit donc l'état résolu du démon (`sshd -T`) et on
 * compare : une valeur qui n'a pas pris est dite, en nommant le fichier qui l'emporte.
 * Annoncer un durcissement que la machine n'applique pas est pire que ne rien durcir, parce
 * que le client cesse alors de s'en occuper.
 */

/** Le seul fichier que ce module écrit. Le `sshd_config` du client n'est jamais ouvert. */
export const CHEMIN_DURCISSEMENT = "/etc/ssh/sshd_config.d/50-skynode.conf"

/**
 * Le brouillon, hors du répertoire inclus : `sshd` ne lit là-bas que `*.conf`, mais un
 * fichier intermédiaire à portée du glob est le genre de détail qui finit par mordre.
 */
const CHEMIN_BROUILLON = "/etc/ssh/.skynode-brouillon"

/**
 * Le contenu posé, et **rien d'autre**.
 *
 * Pas d'`AllowUsers` : il enfermerait dehors tout compte que le client utilise et que nous
 * ne connaissons pas. Pas de changement de port : le pare-feu de `host.prepare` n'ouvre que
 * 22, et déplacer le port casserait les outils du client sans rien apporter.
 */
export const CONFIG_DURCISSEMENT: string = [
  "# Écrit par SkyNode. Retirer ce fichier suffit à revenir en arrière.",
  "PasswordAuthentication no",
  "KbdInteractiveAuthentication no",
  "PermitRootLogin prohibit-password",
  "",
].join("\n")

/**
 * Ce que `sshd -T` doit rendre pour que le durcissement soit réellement en vigueur.
 *
 * `permitrootlogin` accepte deux écritures parce que **`sshd -T` ne rend pas la valeur
 * écrite** : il rend le premier libellé de sa propre table pour la constante interne, et
 * pour `prohibit-password` c'est l'ancien alias `without-password`. Mesuré sur Ubuntu 24.04 :
 * un fichier portant `PermitRootLogin prohibit-password` se relit `permitrootlogin
 * without-password`. N'accepter que la valeur écrite ferait donc annoncer un conflit
 * inexistant sur **toutes** les machines, ce qui reviendrait à crier au loup en permanence.
 */
const VOULU: ReadonlyArray<{ motCle: string; valeurs: readonly string[] }> = [
  { motCle: "passwordauthentication", valeurs: ["no"] },
  { motCle: "kbdinteractiveauthentication", valeurs: ["no"] },
  { motCle: "permitrootlogin", valeurs: ["prohibit-password", "without-password"] },
]

/** Ce que rend le durcissement, dans la forme de `RemoteResult` — mêmes lectures côté appelant. */
export interface HardenResult {
  outcome: Outcome
  /** Ce qui s'est passé, en français, prêt à figurer dans un rapport. */
  detail: string
  /** Diagnostic brut et borné quand ça a échoué. Vide sinon. */
  diagnostic: string
}

/** Un nom d'utilisateur POSIX, et rien d'autre : il devient l'argument de `ssh -l`. */
const UTILISATEUR_VALIDE = /^[a-z_][a-z0-9_-]{0,31}$/

/** Le préambule commun aux quatre scripts : le protocole `clé<TAB>valeur` et sa fin. */
const PREAMBULE: readonly string[] = [
  "set -u",
  "emit() { printf '%s\\t%s\\n' \"$1\" \"$2\"; }",
  "fin() { emit harden.end 1; exit 0; }",
  "echec() { emit harden.erreur \"$1\"; fin; }",
]

/**
 * Le rechargement du démon, dans les trois formes rencontrées sur le terrain.
 *
 * `reload`, **jamais `restart`** : `restart` coupe les sessions en cours, à commencer par
 * celle qui exécute ce script — le serveur resterait à mi-chemin, et personne ne pourrait
 * plus ni finir ni défaire.
 *
 * La branche `ssh.socket` n'est pas de la coquetterie : depuis Ubuntu 23.04, `sshd` est
 * souvent activé par socket, chaque connexion démarrant son propre `sshd` qui relit la
 * configuration. `systemctl reload ssh` y échoue alors sur un service qui ne tourne pas, et
 * conclure à un échec ferait défaire un durcissement déjà en vigueur.
 */
const RECHARGER: readonly string[] = [
  "recharger() {",
  "  if systemctl reload ssh >/dev/null 2>&1; then return 0; fi",
  "  if systemctl reload sshd >/dev/null 2>&1; then return 0; fi",
  "  systemctl is-active ssh.socket >/dev/null 2>&1",
  "}",
]

/**
 * Point 1 : l'`Include` est-il là ?
 *
 * Sans lui, écrire dans `sshd_config.d/` ne sert à rien — et laisserait croire le serveur
 * durci alors qu'il ne l'est pas. Le motif est délibérément étroit : un doute fait rendre
 * `non`, donc « on ne durcit pas », qui est le sens sûr de l'erreur.
 */
export const SCRIPT_INCLUDE: string = [
  ...PREAMBULE,
  "if [ ! -r /etc/ssh/sshd_config ]; then",
  "  emit harden.include non",
  "  fin",
  "fi",
  // `#Include …`, la forme commentée, ne correspond pas : `#` n'est pas une espace.
  "if grep -Eqi '^[[:space:]]*include[[:space:]]+.*/etc/ssh/sshd_config\\.d/\\*\\.conf' /etc/ssh/sshd_config; then",
  "  emit harden.include oui",
  "else",
  "  emit harden.include non",
  "fi",
  "fin",
].join("\n")

/**
 * Points 2 et 6 : la sonde du compte applicatif, jouée **dans sa propre session SSH**.
 *
 * Elle ne prouve rien par elle-même — c'est le fait que la session s'ouvre qui prouve que la
 * clé fonctionne. `sudo -n true` s'y ajoute parce qu'un compte applicatif sans élévation ne
 * pourrait pas réparer un durcissement raté, ce qui revient au même qu'être enfermé dehors.
 */
export const SCRIPT_SONDE: string = [
  ...PREAMBULE,
  "if sudo -n true 2>/dev/null; then",
  "  emit harden.sudo oui",
  "else",
  "  emit harden.sudo non",
  "fi",
  "fin",
].join("\n")

/**
 * Le constat de l'état résolu, mot-clé par mot-clé, avec le fichier qui l'emporte quand la
 * valeur voulue n'a pas pris.
 *
 * `motCle` et `voulu` viennent de `VOULU`, une constante de ce module : rien du plan ni d'un
 * texte lu par l'agent n'entre ici (invariant n°1).
 */
function sectionEffectif(motCle: string, valeurs: readonly string[]): string[] {
  const test = valeurs.map((v) => `[ "$valeur" = ${shellQuote(v)} ]`).join(" || ")

  return [
    // `-v cle=…`, jamais le mot-clé posé dans le programme `awk` : le programme voyage entre
    // guillemets simples, et un `shellQuote` glissé dedans **refermerait** cette citation. Le
    // mot-clé devenait alors une variable `awk` vide, `$1 == ""` ne correspondait à rien, et
    // le durcissement annonçait un conflit sur les trois directives de toutes les machines —
    // exactement le cri au loup permanent que cette vérification est censée éviter.
    `valeur=$(printf '%s\\n' "$resolu" | awk -v cle=${shellQuote(motCle)} '$1 == cle { print $2; exit }')`,
    `emit harden.effectif ${shellQuote(motCle)}" ${"${valeur:-absente}"}"`,
    `if ${test}; then`,
    "  :",
    "else",
    // L'ordre du glob est celui que `sshd` suit lui-même, et le premier fichier qui porte le
    // mot-clé est donc celui qui l'emporte. Le nôtre est écarté de la liste : il ne peut pas
    // se faire de l'ombre à lui-même. `sshd_config` vient en dernier, faute de savoir si ses
    // propres directives précèdent ou suivent la ligne `Include`.
    `  qui=$(grep -l -i -E ${shellQuote(`^[[:space:]]*${motCle}[[:space:]]`)} /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | grep -v -F -x ${shellQuote(CHEMIN_DURCISSEMENT)} | head -n1)`,
    `  emit harden.conflit ${shellQuote(motCle)}" ${"${qui:-inconnu}"}"`,
    "fi",
  ]
}

/**
 * Points 3 à 5, plus la relecture de l'état résolu.
 *
 * Le fichier est posé, `sshd -t` juge, puis on recharge — et seulement ensuite on relit ce
 * que le démon retient vraiment. Chaque échec de ce script rend la machine à l'état où il
 * l'a trouvée : un durcissement à moitié posé est le pire des trois résultats possibles.
 */
export const SCRIPT_DURCIT: string = [
  ...PREAMBULE,
  ...RECHARGER,
  // Écrire dans /etc/ssh et recharger un service : sans les droits, le script laisserait la
  // machine à mi-chemin en croyant avoir travaillé.
  "if [ \"$(id -u)\" != 0 ]; then",
  "  echec " + shellQuote("Le durcissement SSH doit s'exécuter en root."),
  "fi",
  // `command -v` d'abord : le `PATH` d'une session non interactive ne porte pas toujours
  // `/usr/sbin`, et le chemin en dur est le repli, pas la règle.
  "sshd_bin=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)",
  "if [ ! -x \"$sshd_bin\" ]; then",
  "  echec " + shellQuote("Le démon sshd est introuvable : impossible de valider une configuration qu'on ne peut pas relire."),
  "fi",
  // Le répertoire est déjà désigné par l'`Include` constaté au point 1 ; le créer s'il manque
  // ne prend rien à personne.
  "install -d -m 0755 -o root -g root /etc/ssh/sshd_config.d || echec " +
    shellQuote("Création de /etc/ssh/sshd_config.d impossible."),

  // Le brouillon est relu par `writeFileScript` avant qu'on s'en serve : une écriture
  // interrompue poserait un fichier tronqué, et un `sshd_config` tronqué reste valide —
  // il durcirait à moitié sans que rien ne le signale.
  ...writeFileScript(
    CHEMIN_BROUILLON,
    CONFIG_DURCISSEMENT,
    "0600",
    "echec " + shellQuote("Écriture interrompue : le brouillon du durcissement est incomplet, rien n'a été installé.")
  ).split("\n"),

  // Les deux chemins sont des constantes de ce module — aucune valeur du plan, aucun texte lu
  // par un agent n'y entre (invariant n°1). Ils sont écrits nus plutôt que mis en sécurité
  // par `shellQuote` pour que le retrait se lise tel quel dans les scripts et dans les tests,
  // là où un `rm -f '…'` obligerait à relire des guillemets pour se convaincre de la cible.
  `if cmp -s ${CHEMIN_BROUILLON} ${CHEMIN_DURCISSEMENT}; then`,
  "  ecrit=non",
  `  rm -f ${CHEMIN_BROUILLON}`,
  "else",
  "  ecrit=oui",
  `  install -m 0644 -o root -g root ${CHEMIN_BROUILLON} ${CHEMIN_DURCISSEMENT} || { rm -f ${CHEMIN_BROUILLON}; echec ` +
    shellQuote(`Écriture de ${CHEMIN_DURCISSEMENT} impossible.`) +
    "; }",
  `  rm -f ${CHEMIN_BROUILLON}`,
  "fi",

  // Le fichier est en place mais le démon ne l'a pas encore lu : c'est exactement la fenêtre
  // où une configuration fautive se retire sans conséquence.
  "if ! \"$sshd_bin\" -t >&2; then",
  "  if [ \"$ecrit\" = oui ]; then",
  `    rm -f ${CHEMIN_DURCISSEMENT}`,
  "    echec " +
    shellQuote(
      "« sshd -t » refuse la configuration une fois le fichier de SkyNode posé : il a été retiré et le " +
        "service n'a pas été rechargé. Le détail de sshd -t, qui nomme le fichier fautif, est dans le diagnostic."
    ),
  "  fi",
  // Le fichier était déjà là, identique : le refus vient d'ailleurs dans la configuration de
  // la machine. Retirer notre fichier ne réparerait rien et retirerait un durcissement qui
  // tenait peut-être depuis des mois.
  "  echec " +
    shellQuote(
      "« sshd -t » refuse la configuration de cette machine, pour une raison qui ne vient pas du fichier de SkyNode : rien n'a été touché."
    ),
  "fi",

  "if [ \"$ecrit\" = oui ]; then",
  "  if recharger; then",
  "    emit harden.recharge oui",
  "  else",
  `    rm -f ${CHEMIN_DURCISSEMENT}`,
  "    recharger || true",
  "    echec " +
    shellQuote(
      "Le service SSH n'a pas pu être rechargé : le fichier a été retiré, la configuration en vigueur est celle d'avant."
    ),
  "  fi",
  "fi",
  "emit harden.ecrit \"$ecrit\"",

  // La découverte de production : le fichier écrit ne dit pas la configuration en vigueur.
  // `sshd -T` rend la configuration résolue, c'est-à-dire ce que le démon retient vraiment.
  "resolu=$(\"$sshd_bin\" -T 2>/dev/null) || resolu=''",
  "if [ -z \"$resolu\" ]; then",
  // Ne pas pouvoir vérifier vaut ne pas avoir durci : on défait plutôt que d'annoncer un
  // durcissement dont personne n'a constaté l'effet.
  "  if [ \"$ecrit\" = oui ]; then",
  `    rm -f ${CHEMIN_DURCISSEMENT}`,
  "    recharger || true",
  "  fi",
  "  echec " +
    shellQuote(
      "« sshd -T » n'a rien rendu : impossible de vérifier que le durcissement prend effet, il a donc été défait."
    ),
  "fi",
  ...VOULU.flatMap(({ motCle, valeurs }) => sectionEffectif(motCle, valeurs)),
  "fin",
].join("\n")

/**
 * Le retour arrière. Une seule commande, parce que le durcissement tient dans un seul
 * fichier — c'est toute la raison de ne jamais toucher à `sshd_config`.
 */
export const SCRIPT_RETRAIT: string = [
  ...PREAMBULE,
  ...RECHARGER,
  `rm -f ${CHEMIN_DURCISSEMENT} || echec ` +
    shellQuote(`Retrait de ${CHEMIN_DURCISSEMENT} impossible : le durcissement reste en place.`),
  // Un rechargement qui échoue ici n'est pas fatal : le fichier est déjà parti, et la
  // prochaine lecture de la configuration — au pire au redémarrage — se fera sans lui.
  "if recharger; then",
  "  emit harden.recharge oui",
  "else",
  "  emit harden.recharge non",
  "fi",
  "emit harden.retire oui",
  "fin",
].join("\n")

/** Assez pour diagnostiquer, pas assez pour noyer le contexte de l'agent. Comme `runRemote`. */
const MAX_DIAGNOSTIC = 1000

function borne(raw: string): string {
  const masque = raw.replace(/[^\s"'()]*\.ssh[^\s"'()]*/g, "‹chemin masqué›")

  return masque.length <= MAX_DIAGNOSTIC ? masque : `[sortie tronquée]\n${masque.slice(-MAX_DIAGNOSTIC)}`
}

/** Les deux flux d'une exécution, joints pour le diagnostic. */
function joint(r: SshResult): string {
  if (r.stdout === "") return r.stderr
  if (r.stderr === "") return r.stdout

  return `${r.stdout}\n${r.stderr}`
}

/**
 * La sortie d'un script de ce module : les paires `clé<TAB>valeur`, et le marqueur de fin.
 *
 * Une clé peut revenir plusieurs fois — `harden.conflit` en porte une par mot-clé qui n'a
 * pas pris —, d'où la liste plutôt que la dernière valeur vue.
 */
interface SortieHarden {
  valeurs: Map<string, string[]>
  /** Faux quand le script n'a pas rendu son marqueur : sortie coupée, on ne conclut rien. */
  complet: boolean
}

function lireSortie(stdout: string): SortieHarden {
  const lignes = stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)

  const valeurs = new Map<string, string[]>()

  for (const ligne of lignes) {
    const tab = ligne.indexOf("\t")
    if (tab === -1) continue

    const cle = ligne.slice(0, tab)
    const deja = valeurs.get(cle)
    if (deja === undefined) valeurs.set(cle, [ligne.slice(tab + 1)])
    else deja.push(ligne.slice(tab + 1))
  }

  // Le marqueur ne compte que s'il clôt réellement la sortie — même règle que `runRemote` :
  // ailleurs, il pourrait n'être qu'un fragment traversé avant que la connexion coupe.
  const derniere = lignes[lignes.length - 1]

  return { valeurs, complet: derniere !== undefined && derniere.startsWith("harden.end\t") }
}

function premiere(sortie: SortieHarden, cle: string): string | null {
  return sortie.valeurs.get(cle)?.[0] ?? null
}

/**
 * Une exécution et sa lecture, ou l'explication de son échec.
 *
 * Union discriminée plutôt qu'un `echec: string | null` : le compilateur refuse alors de
 * lire la sortie d'un passage qui n'a pas abouti, plutôt que de laisser une assertion tenir
 * la promesse à sa place.
 */
type Passage =
  | { ok: true; sortie: SortieHarden }
  | { ok: false; echec: string; diagnostic: string }

async function passe(ssh: SshRunner, cible: SshTarget, script: string): Promise<Passage> {
  const resultat = await ssh.run(cible, script)
  const echecSsh = explainSsh(resultat)

  if (echecSsh !== null) {
    return { ok: false, echec: echecSsh, diagnostic: borne(resultat.stderr) }
  }

  const sortie = lireSortie(resultat.stdout)
  if (!sortie.complet) {
    return {
      ok: false,
      echec: "La session s'est interrompue avant la fin du contrôle : résultat incomplet, rien n'est conclu.",
      diagnostic: borne(joint(resultat)),
    }
  }

  const erreur = premiere(sortie, "harden.erreur")
  if (erreur !== null) {
    return { ok: false, echec: erreur, diagnostic: borne(joint(resultat)) }
  }

  return { ok: true, sortie }
}

/**
 * La sonde applicative a-t-elle abouti — session ouverte **et** élévation disponible ?
 *
 * Le second message sert quand la session s'ouvre mais que `sudo -n true` échoue : un compte
 * applicatif sans élévation ne pourrait pas réparer un durcissement raté.
 */
function echecSonde(p: Passage): string | null {
  if (!p.ok) return p.echec
  if (premiere(p.sortie, "harden.sudo") === "oui") return null

  return "la session s'ouvre mais « sudo -n true » y est refusé"
}

/**
 * Durcit la configuration SSH d'un serveur, ou explique pourquoi elle ne l'a pas été.
 *
 * `cible` est la session d'administration (root, ou un compte à `sudo`), `utilisateur` le
 * compte applicatif dont la porte doit rester ouverte. Les deux sessions de vérification
 * s'ouvrent sur **le même hôte** que la cible : un hôte fourni séparément permettrait de
 * durcir une machine en vérifiant la porte d'une autre.
 */
export async function hardenSsh(
  ssh: SshRunner,
  cible: SshTarget,
  utilisateur: string
): Promise<HardenResult> {
  // Un nom d'utilisateur devient l'argument de `ssh -l` : `-oProxyCommand=…` glissé là
  // exécuterait une commande sur la machine du développeur. `resolveSshTarget` valide déjà
  // le compte de la cible, mais celui-ci arrive par un autre chemin.
  if (!UTILISATEUR_VALIDE.test(utilisateur)) {
    throw new Error(`« ${utilisateur} » n'est pas un nom de compte valide pour une session SSH.`)
  }

  const applicatif: SshTarget = { host: cible.host, user: utilisateur }

  // 1. L'Include.
  const inclusion = await passe(ssh, cible, SCRIPT_INCLUDE)
  if (!inclusion.ok) {
    return {
      outcome: "failed",
      detail: `Durcissement SSH refusé : impossible de lire /etc/ssh/sshd_config. ${inclusion.echec}`,
      diagnostic: inclusion.diagnostic,
    }
  }

  if (premiere(inclusion.sortie, "harden.include") !== "oui") {
    return {
      outcome: "unchanged",
      detail:
        "Durcissement SSH non appliqué : /etc/ssh/sshd_config ne porte pas de ligne " +
        "« Include /etc/ssh/sshd_config.d/*.conf ». Un fichier posé dans ce répertoire n'y " +
        "serait jamais lu, et le serveur passerait pour durci sans l'être.",
      diagnostic: "",
    }
  }

  // 2. La porte de secours, avant de toucher à quoi que ce soit.
  const avant = await passe(ssh, applicatif, SCRIPT_SONDE)
  const echecAvant = echecSonde(avant)
  if (echecAvant !== null) {
    return {
      outcome: "failed",
      detail:
        `Durcissement SSH refusé : le compte « ${utilisateur} » n'a pas de clé autorisée qui ` +
        `fonctionne avec élévation (${echecAvant}). Couper l'authentification par mot de passe ` +
        "fermerait la seule autre porte. Rien n'a été modifié.",
      diagnostic: avant.ok ? "" : avant.diagnostic,
    }
  }

  // 3 à 5, plus la relecture de l'état résolu.
  const pose = await passe(ssh, cible, SCRIPT_DURCIT)
  if (!pose.ok) {
    return { outcome: "failed", detail: pose.echec, diagnostic: pose.diagnostic }
  }

  const sortie = pose.sortie

  // 6. La troisième session : la seule preuve que la porte tient encore.
  const apres = await passe(ssh, applicatif, SCRIPT_SONDE)
  const echecApres = echecSonde(apres)
  if (echecApres !== null) {
    return await defaire(ssh, cible, applicatif, utilisateur, echecApres)
  }

  const conflits = sortie.valeurs.get("harden.conflit") ?? []
  if (conflits.length > 0) {
    return {
      outcome: "failed",
      detail:
        `Le fichier ${CHEMIN_DURCISSEMENT} est bien posé, mais ` +
        `${conflits.length === 1 ? "une directive n'a pas pris effet" : "des directives n'ont pas pris effet"} : ` +
        conflits.map((c) => decritConflit(c)).join(" ") +
        " sshd retient la première valeur rencontrée, et l'Include du répertoire est en tête " +
        "de sshd_config. Le fichier de SkyNode est laissé en place — le retirer emporterait " +
        "aussi les directives qui, elles, ont pris.",
      diagnostic: "",
    }
  }

  if (premiere(sortie, "harden.ecrit") === "oui") {
    return {
      outcome: "applied",
      detail:
        "Durcissement SSH appliqué : mot de passe et clavier interactif refusés, root " +
        `restreint à la clé. Vérifié par « sshd -T » et par une session « ${utilisateur} » ` +
        `ouverte après le rechargement. Retirer ${CHEMIN_DURCISSEMENT} suffit à revenir en arrière.`,
      diagnostic: "",
    }
  }

  return {
    outcome: "unchanged",
    detail: `Durcissement SSH déjà en place et effectif : ${CHEMIN_DURCISSEMENT} est inchangé.`,
    diagnostic: "",
  }
}

/** « passwordauthentication /etc/ssh/sshd_config.d/00-client.conf » en une phrase lisible. */
function decritConflit(brut: string): string {
  const espace = brut.indexOf(" ")
  const motCle = espace === -1 ? brut : brut.slice(0, espace)
  const fichier = espace === -1 ? "inconnu" : brut.slice(espace + 1)

  return fichier === "inconnu"
    ? `« ${motCle} » garde une autre valeur, sans qu'on ait pu désigner le fichier qui l'impose.`
    : `« ${motCle} » garde la valeur imposée par ${fichier}.`
}

/**
 * Le retour arrière du point 6, et sa vérification.
 *
 * Retirer le fichier ne suffit pas à dire que la porte est rouverte : on rouvre une session
 * applicative pour le constater. Le client a besoin de savoir laquelle des deux situations
 * il vit — « c'était chaud mais c'est réparé » et « le compte applicatif est inaccessible »
 * n'appellent pas les mêmes gestes.
 */
async function defaire(
  ssh: SshRunner,
  cible: SshTarget,
  applicatif: SshTarget,
  utilisateur: string,
  raison: string
): Promise<HardenResult> {
  const retrait = await passe(ssh, cible, SCRIPT_RETRAIT)

  if (!retrait.ok) {
    return {
      outcome: "failed",
      detail:
        `Durcissement SSH appliqué puis jugé dangereux (${raison}), et le retour arrière a ` +
        `échoué : ${retrait.echec} Retirer ${CHEMIN_DURCISSEMENT} à la main, puis recharger ` +
        "le service ssh, depuis la session d'administration encore ouverte ou par la console " +
        "de secours de l'hébergeur.",
      diagnostic: retrait.diagnostic,
    }
  }

  const reprise = await passe(ssh, applicatif, SCRIPT_SONDE)
  if (echecSonde(reprise) !== null) {
    return {
      outcome: "failed",
      detail:
        `Durcissement SSH annulé : la session « ${utilisateur} » ne passait plus après le ` +
        `rechargement (${raison}). ${CHEMIN_DURCISSEMENT} a été retiré et le service rechargé, ` +
        "mais cette session ne passe toujours pas — la cause est donc antérieure au " +
        "durcissement. La session d'administration, elle, reste ouverte : c'est par elle " +
        "qu'il faut réparer la clé du compte applicatif.",
      diagnostic: reprise.ok ? "" : reprise.diagnostic,
    }
  }

  return {
    outcome: "failed",
    detail:
      `Durcissement SSH annulé : la session « ${utilisateur} » ne passait plus après le ` +
      `rechargement (${raison}). ${CHEMIN_DURCISSEMENT} a été retiré, le service rechargé, et ` +
      "une nouvelle session applicative passe de nouveau. Le serveur est revenu exactement " +
      "dans l'état où il était avant.",
    diagnostic: "",
  }
}
