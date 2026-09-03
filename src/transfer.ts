import { spawn } from "node:child_process"

import { generateDockerignore } from "./dockerfile.js"
import { buildSshArgs, explainSsh, type SshResult, type SshTarget } from "./ssh.js"

/**
 * Le transfert de l'arborescence du projet vers le serveur : `tar` sur l'entrée standard
 * de `ssh`.
 *
 * **Ni `rsync`, ni `git clone` distant**, et ce n'est pas une commodité : `rsync` devrait
 * être exigé des deux côtés — sur la machine du développeur comme sur un VPS nu — et un
 * `git clone` joué par le serveur réclamerait les identifiants du dépôt privé du client,
 * ce que le produit promet de ne jamais demander. `tar` est présent partout et ne sait rien
 * du dépôt.
 *
 * **Les exclusions viennent du `.dockerignore` que `generateDockerignore()` produit déjà.**
 * Le même vocabulaire décide de ce qui entre dans l'image et de ce qui traverse le réseau ;
 * deux listes finiraient par diverger, et la divergence se paierait dans le seul sens qui
 * compte — un `.env` exclu de l'image mais recopié sur le serveur, où il resterait en clair
 * dans le répertoire de travail.
 *
 * **`spawn` avec un tableau d'arguments, jamais `shell: true`.** Le chemin de la racine
 * vient du développeur : il ne doit jamais pouvoir devenir une option de `tar`. Un
 * `--checkpoint-action=exec=sh` accepté comme « racine » n'est pas une évasion théorique,
 * c'est une exécution de commande par `tar` lui-même.
 */

/* ------------------------------------------------------------------------ constantes --- */

/**
 * Ce qu'un `.dockerignore` exclut mais qui doit malgré tout traverser le réseau.
 *
 * `Dockerfile` et `.dockerignore` n'ont rien à faire **dans** une image — d'où leur présence
 * dans la liste de `generateDockerignore()` — mais ils doivent être **à côté** d'elle : sans
 * eux sur le serveur, un `Dockerfile` écrit par le client ne serait jamais transféré,
 * `build.generate_dockerfile` ne le verrait pas et poserait le sien par-dessus une intention
 * humaine qu'il n'aurait même pas pu constater.
 */
const INDISPENSABLES_AU_TRANSFERT: ReadonlySet<string> = new Set(["Dockerfile", ".dockerignore"])

/**
 * Ce qu'un motif d'exclusion a le droit de contenir. La liste vient de nous
 * (`generateDockerignore`), mais cette fonction est exportée et réutilisable : un motif
 * portant une espace ou un saut de ligne se scinderait en deux arguments le jour où
 * quelqu'un composerait la commande autrement qu'ici.
 */
const MOTIF_EXCLUSION = /^[A-Za-z0-9._*?/-]+$/

/**
 * Un segment de chemin **distant** : le répertoire de travail est interpolé dans un script
 * `sh`, et c'est nous qui le nommons — la stricte parcimonie n'y coûte rien.
 */
const SEGMENT_DISTANT = /^[A-Za-z0-9._-]+$/

/**
 * Un segment de chemin **local**. Volontairement plus large : la racine du projet est
 * l'endroit où le développeur range son travail, et « ~/Mes projets/boutique » en est un tout
 * à fait ordinaire. Une espace n'y est dangereuse que pour qui recolle une ligne de commande
 * en une chaîne — ce que ce module ne fait jamais. Seuls les caractères de contrôle sont
 * refusés : un saut de ligne dans un chemin ne sert qu'à tromper un affichage.
 */
const SEGMENT_LOCAL = /^[^\u0000-\u001f/]+$/

/** 4096 est la borne de `PATH_MAX` sur Linux ; au-delà, aucun chemin n'est légitime. */
const LONGUEUR_CHEMIN_MAX = 4096

/**
 * Les arborescences système, **elles et tout ce qu'elles contiennent**.
 *
 * Une « racine de projet » qui tombe là-dedans n'est jamais une erreur bénigne : elle
 * enverrait le contenu de `/etc` — clés, certificats, mots de passe de service de la machine
 * du développeur — dans un contexte de construction Docker, donc dans une image, donc chez
 * le client. Le refus est la seule réponse acceptable.
 */
const SOUS_ARBRES_INTERDITS: readonly string[] = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
]

/**
 * Les répertoires de rassemblement : interdits **eux-mêmes**, autorisés en profondeur.
 *
 * `/home` comme racine embarquerait les fichiers de tous les comptes de la machine ;
 * `/home/dev/boutique` est en revanche l'emplacement le plus ordinaire d'un projet. Le
 * refus porte donc sur le répertoire exact, jamais sur son contenu — l'inverse de la liste
 * précédente, et pour la raison inverse.
 */
const REPERTOIRES_INTERDITS: readonly string[] = [
  "/Users",
  "/Volumes",
  "/home",
  "/media",
  "/mnt",
  "/opt",
  "/private",
  "/srv",
  "/tmp",
  "/usr",
  "/var",
]

/**
 * Le segment qu'un répertoire de travail distant doit porter pour qu'on accepte d'y faire
 * un `rm -rf`.
 *
 * Le transfert vide le répertoire avant d'extraire — sans quoi les fichiers d'un
 * déploiement précédent survivraient dans le contexte de construction, entreraient dans le
 * condensat et dans l'image, et l'on livrerait un mélange de deux versions. Mais un
 * `rm -rf` en root sur un chemin mal formé est irréparable : on n'efface récursivement
 * qu'un chemin dont **ce produit** a choisi un segment. Même garde que `scripts/banc.sh`
 * s'impose avant d'effacer son propre répertoire de clés.
 */
const SEGMENT_EXIGE_TRAVAIL = "skynode"

/** Assez pour diagnostiquer, pas assez pour noyer le contexte de l'agent — comme `remote.ts`. */
const MAX_DIAGNOSTIC = 1000

/**
 * La compression, **et la même des deux côtés**.
 *
 * La liaison visée est celle d'un client ivoirien, pas un réseau de centre de données : la
 * compression coûte quelques cycles et épargne l'essentiel du temps de transfert. Mais le
 * `tar` qui comprime et celui qui extrait doivent s'accorder : `bsdtar` — celui de macOS,
 * donc celui d'une bonne part des machines de développement — détecte la compression tout
 * seul et pardonnerait un désaccord, là où le `tar` GNU du serveur refuserait un flux non
 * comprimé qu'on lui annonce comprimé. Une constante partagée, et un test qui exige les deux.
 */
const COMPRESSION = "--gzip"

/** Un projet peut peser lourd sur une liaison lente ; l'attente par défaut en tient compte. */
const DELAI_TRANSFERT_MS = 300_000

/* ------------------------------------------------------------------------- garde-fous --- */

/** Découpe un chemin absolu en segments, ou rend `null` si sa forme interdit tout usage. */
function segmentsDe(chemin: string, forme: RegExp): string[] | null {
  if (chemin.length === 0 || chemin.length > LONGUEUR_CHEMIN_MAX) return null
  if (!chemin.startsWith("/")) return null

  // Une barre oblique finale est une écriture ordinaire du même répertoire, pas un segment
  // vide : la retirer avant le découpage évite de refuser « /home/dev/boutique/ ».
  const nu = chemin.length > 1 && chemin.endsWith("/") ? chemin.slice(0, -1) : chemin
  const segments = nu.slice(1).split("/")
  if (segments.length === 0) return null

  for (const segment of segments) {
    if (segment === "." || segment === "..") return null
    if (!forme.test(segment)) return null
  }

  return segments
}

/**
 * Refuse toute racine locale qui n'est pas un chemin absolu ordinaire, **avant** qu'elle
 * entre dans la ligne de commande de `tar`.
 *
 * C'est ce contrôle qui autorise `racine` à figurer en argument de `--directory` plus bas :
 * il impose une première lettre `/`, ce qui retire d'emblée à la valeur toute chance d'être
 * lue comme une option — `-C /etc` et `--checkpoint-action=exec=sh` échouent ici, pas dans
 * une couche plus loin.
 */
export function exigeRacineLocale(racine: string): string {
  const segments = segmentsDe(racine, SEGMENT_LOCAL)
  if (segments === null) {
    throw new Error(
      `« ${racine} » n'est pas une racine de projet utilisable : un chemin absolu est attendu, ` +
        "sans segment « .. » et sans caractère de contrôle. Une valeur qui ne commence pas par « / » " +
        "serait lue par « tar » comme une option, jamais comme un répertoire."
    )
  }

  const normalise = `/${segments.join("/")}`

  for (const interdit of SOUS_ARBRES_INTERDITS) {
    if (normalise === interdit || normalise.startsWith(`${interdit}/`)) {
      throw new Error(
        `« ${racine} » est sous ${interdit}, une arborescence système : aucun projet ne s'y trouve, ` +
          "et son contenu entrerait dans une image livrée au client."
      )
    }
  }

  if (REPERTOIRES_INTERDITS.includes(normalise)) {
    throw new Error(
      `« ${racine} » est un répertoire de rassemblement, pas une racine de projet : le transférer ` +
        "emporterait tout ce qu'il contient. Désigner le projet lui-même."
    )
  }

  return normalise
}

/**
 * Refuse tout répertoire de travail distant qui ne porte pas notre segment.
 *
 * Le script de réception y fait un `rm -rf` : ce contrôle est le seul qui sépare « vider le
 * répertoire de travail du passage » de « effacer une arborescence du client ».
 */
export function exigeRepertoireDeTravail(workDir: string): string {
  const segments = segmentsDe(workDir, SEGMENT_DISTANT)
  if (segments === null || segments.length < 2) {
    throw new Error(
      `« ${workDir} » n'est pas un répertoire de travail utilisable : un chemin absolu d'au moins ` +
        "deux segments est attendu, sans segment « .. » ni caractère hors de [A-Za-z0-9._-]."
    )
  }

  if (!segments.includes(SEGMENT_EXIGE_TRAVAIL)) {
    throw new Error(
      `« ${workDir} » ne porte pas le segment « ${SEGMENT_EXIGE_TRAVAIL} » : le transfert vide le ` +
        "répertoire avant d'extraire, et l'on n'efface récursivement qu'un chemin dont ce produit a choisi un segment."
    )
  }

  return `/${segments.join("/")}`
}

/* ------------------------------------------------------------------------ exclusions --- */

/**
 * Un préfixe « deux astérisques puis une barre oblique » ne dit rien de plus à `tar`, dont
 * les motifs d'exclusion ne sont pas ancrés : `x` couvre déjà `a/b/x`.
 */
function normaliseMotif(motif: string): string {
  let sortie = motif
  while (sortie.startsWith("**/")) sortie = sortie.slice(3)

  return sortie
}

/**
 * Traduit un `.dockerignore` en motifs `--exclude` de `tar`.
 *
 * Trois écarts, tous dans le même sens — **le transfert peut être plus strict que l'image,
 * jamais plus laxiste** :
 *
 * - Un motif préfixé de « deux astérisques puis une barre oblique » perd ce préfixe : les
 *   exclusions de `tar` ne sont pas ancrées et `x` couvre déjà `a/b/x`. Ce qui rendrait le
 *   transfert plus laxiste serait l'inverse.
 * - Une négation (`!x`) ne retire qu'une exclusion **littéralement identique**. `!dist`
 *   annule bien `dist`, comme le gabarit statique l'exige ; `!.env.example` n'annule rien,
 *   parce que c'est `.env.*` — un motif, pas le même littéral — qui l'exclut. `.env.example`
 *   ne traverse donc pas le réseau alors qu'il entrerait dans l'image. C'est un fichier
 *   d'exemple sans valeur, et le sens de l'écart est le bon.
 * - `Dockerfile` et `.dockerignore` ne sont pas exclus du tout : voir
 *   `INDISPENSABLES_AU_TRANSFERT`.
 */
export function exclusionsDepuisDockerignore(dockerignore: string): string[] {
  const exclusions: string[] = []
  const reintroduits = new Set<string>()

  for (const brute of dockerignore.split("\n")) {
    const ligne = brute.trim()
    if (ligne === "" || ligne.startsWith("#")) continue

    if (ligne.startsWith("!")) {
      reintroduits.add(normaliseMotif(ligne.slice(1)))
      continue
    }

    const motif = normaliseMotif(ligne)
    if (motif === "" || INDISPENSABLES_AU_TRANSFERT.has(motif)) continue

    if (!MOTIF_EXCLUSION.test(motif)) {
      throw new Error(
        `« ${motif} » n'est pas un motif d'exclusion utilisable : il porte un caractère que « tar » ` +
          "ne recevrait pas comme un seul argument."
      )
    }

    if (!exclusions.includes(motif)) exclusions.push(motif)
  }

  return exclusions.filter((motif) => !reintroduits.has(motif))
}

/* -------------------------------------------------------------------------- commande --- */

export interface TransferCommand {
  /** Le binaire, invoqué par `spawn` avec le tableau ci-dessous — jamais par un shell. */
  command: string
  /** Un argument par élément. Aucun n'est jamais recollé en une chaîne pour être exécuté. */
  args: readonly string[]
  /** Ce que le `sh` distant exécute pour recevoir l'archive sur son entrée standard. */
  remoteScript: string
}

/**
 * Le script joué sur le serveur : il vide le répertoire de travail, le recrée et extrait.
 *
 * `set -eu` ici, et non le protocole d'étape de `remote.ts` : ce script n'est pas une étape
 * du plan, il n'a ni annulation ni garde d'idempotence à déclarer, et sa seule question est
 * « l'archive est-elle arrivée entière ». Il le dit par un marqueur de fin, comme le reste
 * du projet, pour qu'une session coupée au milieu ne se lise pas comme un transfert abouti.
 *
 * `--no-same-owner` n'est pas cosmétique : `tar` en root restaure par défaut le propriétaire
 * inscrit dans l'archive, c'est-à-dire l'UID du développeur sur **sa** machine. Le
 * répertoire de travail se retrouverait possédé par un compte qui n'existe pas ici.
 */
function scriptReception(workDir: string): string {
  const q = (valeur: string): string => `'${valeur.replace(/'/g, "'\\''")}'`

  return [
    "set -eu",
    // Le contexte de construction est lu par Docker en root ; un umask laxiste hérité de la
    // session rendrait le répertoire inscriptible par tout compte de la machine.
    "umask 022",
    `rm -rf -- ${q(workDir)}`,
    `mkdir -p -- ${q(workDir)}`,
    `tar --extract ${COMPRESSION} --file - --no-same-owner --directory ${q(workDir)}`,
    `printf 'transfer.fichiers\\t%s\\n' "$(find ${q(workDir)} -type f | wc -l | tr -d ' ')"`,
    "printf 'transfer.end\\t1\\n'",
  ].join("\n")
}

/**
 * La commande de transfert, prête pour `spawn` : `tar` d'un côté, le script de réception de
 * l'autre.
 *
 * `preserveDir` réintroduit le répertoire de sortie d'un site statique déjà construit
 * (`dist`), que le `.dockerignore` exclut par ailleurs. Sans lui, on transférerait un dépôt
 * amputé de ce qu'il faut précisément servir.
 */
export function buildTransferCommand(
  racine: string,
  workDir: string,
  preserveDir: string | null
): TransferCommand {
  const racineValide = exigeRacineLocale(racine)
  const travailValide = exigeRepertoireDeTravail(workDir)
  // `generateDockerignore` valide lui-même `preserveDir` : un répertoire mal formé lève ici
  // plutôt que d'entrer dans un `--exclude` ou dans le `.dockerignore` de l'image.
  const exclusions = exclusionsDepuisDockerignore(generateDockerignore(preserveDir))

  return Object.freeze({
    command: "tar",
    args: Object.freeze([
      "--create",
      COMPRESSION,
      "--file",
      "-",
      "--directory",
      racineValide,
      ...exclusions.map((motif) => `--exclude=${motif}`),
      // `--` clôt les options : plus rien de ce qui suit ne peut être lu comme un drapeau,
      // même si un `tar` futur en inventait un qui s'appelle « . ».
      "--",
      ".",
    ]),
    remoteScript: scriptReception(travailValide),
  })
}

/* -------------------------------------------------------------------------- exécution --- */

export interface TransferResult {
  ok: boolean
  /** Le nombre de fichiers constatés sur le serveur après extraction, ou `null` si inconnu. */
  fichiers: number | null
  /** Ce qui s'est passé, en français, pour le rapport. */
  detail: string
  /** Diagnostic brut, borné, quand ça a échoué. Jamais rendu à l'agent tel quel. */
  diagnostic: string
}

function borne(brut: string): string {
  if (brut.length <= MAX_DIAGNOSTIC) return brut

  return `[sortie tronquée]\n${brut.slice(-MAX_DIAGNOSTIC)}`
}

/** Lit le protocole `clé<TAB>valeur` du script de réception, dans l'esprit de `parseStepOutput`. */
function litReception(stdout: string): { fichiers: number | null; fin: boolean } {
  const lignes = stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)

  let fichiers: number | null = null

  for (const ligne of lignes) {
    const tab = ligne.indexOf("\t")
    if (tab === -1) continue

    if (ligne.slice(0, tab) === "transfer.fichiers") {
      const valeur = Number.parseInt(ligne.slice(tab + 1), 10)
      if (Number.isFinite(valeur)) fichiers = valeur
    }
  }

  const derniere = lignes[lignes.length - 1]

  return { fichiers, fin: derniere !== undefined && derniere.startsWith("transfer.end\t") }
}

/**
 * Transfère l'arborescence et rend ce que le serveur a constaté.
 *
 * Deux processus, jamais un shell : `tar` écrit sur sa sortie standard, `ssh` la lit sur son
 * entrée standard. Le tuyau est monté par Node, donc aucune des deux lignes de commande n'est
 * jamais recollée en une chaîne qu'un interpréteur relirait.
 *
 * `COPYFILE_DISABLE` est posé pour le `tar` de macOS, qui glisse sinon un fichier `._nom` de
 * métadonnées à côté de chaque entrée : ils traverseraient le réseau, entreraient dans le
 * condensat, et le même dépôt donnerait deux images différentes selon la machine du
 * développeur.
 */
export async function transferProject(
  target: SshTarget,
  racine: string,
  workDir: string,
  preserveDir: string | null,
  options?: { tarBin?: string; sshBin?: string; timeoutMs?: number }
): Promise<TransferResult> {
  const commande = buildTransferCommand(racine, workDir, preserveDir)
  const tarBin = options?.tarBin ?? "tar"
  const sshBin = options?.sshBin ?? "ssh"
  const delai = options?.timeoutMs ?? DELAI_TRANSFERT_MS

  return new Promise<TransferResult>((resoudre) => {
    let rendu = false
    let tarErreur = ""
    let sshSortie = ""
    let sshErreur = ""
    let codeTar: number | null = null
    let codeSsh: number | null = null
    let echecLance: string | null = null
    let expire = false

    const tar = spawn(tarBin, [...commande.args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    })
    const ssh = spawn(sshBin, buildSshArgs(target, ["/bin/sh", "-c", commande.remoteScript]), {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const minuteur = setTimeout(() => {
      expire = true
      tar.kill("SIGKILL")
      ssh.kill("SIGKILL")
    }, delai)

    const conclure = (): void => {
      if (rendu) return
      // Les deux processus doivent avoir rendu la main : conclure sur le premier laisserait
      // l'autre orphelin sur la machine du développeur, et masquerait sa raison d'échouer.
      if (codeTar === null || codeSsh === null) return

      rendu = true
      clearTimeout(minuteur)

      const diagnostic = borne(`${sshErreur}\n${tarErreur}`.trim())

      if (expire) {
        resoudre({
          ok: false,
          fichiers: null,
          detail: `Le transfert n'a pas abouti en ${Math.round(delai / 1000)} s : rien ne garantit l'état du répertoire de travail.`,
          diagnostic,
        })
        return
      }

      if (echecLance !== null) {
        resoudre({ ok: false, fichiers: null, detail: echecLance, diagnostic })
        return
      }

      if (codeTar !== 0) {
        resoudre({
          ok: false,
          fichiers: null,
          detail: "L'archive du projet n'a pas pu être constituée : « tar » a échoué sur la machine locale.",
          diagnostic,
        })
        return
      }

      const resultatSsh: SshResult = { code: codeSsh, stdout: sshSortie, stderr: sshErreur }
      const echecSsh = explainSsh(resultatSsh)
      if (echecSsh !== null) {
        resoudre({ ok: false, fichiers: null, detail: echecSsh, diagnostic })
        return
      }

      const recu = litReception(sshSortie)
      if (!recu.fin) {
        // Sans marqueur de fin, l'archive est arrivée tronquée ou la session a coupé : le
        // répertoire de travail porte alors une arborescence partielle, qu'une construction
        // prendrait pour le projet entier.
        resoudre({
          ok: false,
          fichiers: null,
          detail: "Transfert interrompu : le serveur n'a pas rendu son marqueur de fin, l'arborescence reçue est incomplète.",
          diagnostic,
        })
        return
      }

      resoudre({
        ok: true,
        fichiers: recu.fichiers,
        detail: `Arborescence transférée dans ${workDir} (${recu.fichiers ?? 0} fichiers), sans les fichiers d'environnement ni les dépendances installées.`,
        diagnostic: "",
      })
    }

    const surErreurDeLancement =
      (role: "tar" | "ssh", quoi: string) =>
      (erreur: NodeJS.ErrnoException): void => {
        echecLance =
          erreur.code === "ENOENT"
            ? `« ${quoi} » est introuvable sur cette machine : le transfert en dépend.`
            : `« ${quoi} » n'a pas pu être lancé : ${erreur.message}`
        // Un processus qui n'a jamais démarré ne rendra pas de code de sortie ; sans cette
        // valeur de dépit, `conclure` attendrait indéfiniment celui qui n'existe pas.
        if (role === "tar") codeTar = -1
        else codeSsh = -1
        tar.kill("SIGKILL")
        ssh.kill("SIGKILL")
        conclure()
      }

    tar.stderr?.setEncoding("utf8")
    ssh.stdout?.setEncoding("utf8")
    ssh.stderr?.setEncoding("utf8")

    tar.stderr?.on("data", (bloc: string) => {
      tarErreur += bloc
    })
    ssh.stdout?.on("data", (bloc: string) => {
      sshSortie += bloc
    })
    ssh.stderr?.on("data", (bloc: string) => {
      sshErreur += bloc
    })

    // `ssh` mort avant la fin de l'archive fait émettre EPIPE au tuyau ; sans écouteur, Node
    // remonterait l'événement en exception non gérée et tuerait le serveur MCP entier.
    ssh.stdin?.on("error", () => {})
    tar.stdout?.on("error", () => {})

    tar.on("error", surErreurDeLancement("tar", tarBin))
    ssh.on("error", surErreurDeLancement("ssh", sshBin))

    tar.on("close", (code) => {
      if (codeTar === null) codeTar = code ?? -1
      conclure()
    })
    ssh.on("close", (code) => {
      if (codeSsh === null) codeSsh = code ?? -1
      conclure()
    })

    if (tar.stdout !== null && ssh.stdin !== null) tar.stdout.pipe(ssh.stdin)
  })
}
