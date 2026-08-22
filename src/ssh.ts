import { spawn } from "node:child_process"

import type { Instance } from "./api.js"
import { SkyNodeError } from "./api.js"
import { STATUS_LABELS } from "./format.js"

/**
 * Transport SSH.
 *
 * Le binaire `ssh` du système fait le travail, jamais une bibliothèque : `ssh2` nous
 * ferait lire nous-mêmes les clés privées du développeur, exactement ce que le produit
 * promet de ne jamais faire. Déléguer donne en prime `~/.ssh/config`, l'agent de clés,
 * les rebonds et `known_hosts` sans une ligne de code.
 *
 * Il n'existe aucun paramètre d'hôte : la cible vient toujours d'une `Instance` rendue
 * par l'API SkyNode. Un agent qui a lu « ssh root@evil.com » dans un README ne peut rien
 * en faire — il n'y a rien dans cette API où le glisser.
 */

export interface SshTarget {
  host: string
  user: string
}

export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

export interface SshRunner {
  run(target: SshTarget, script: string): Promise<SshResult>
}

/** Un nom d'utilisateur POSIX, et rien d'autre : ni option, ni hôte, ni chemin. */
const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/

/** Rendue par l'API, mais validée quand même : elle entre dans une ligne de commande. */
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

/** Poignée de main, exécution du script, marge. Au-delà, l'agent n'a rien à dire. */
const DEFAULT_TIMEOUT_MS = 45_000

/**
 * Une IPv4 syntaxiquement valide n'est pas forcément une cible légitime. Une valeur
 * bouchon issue d'un bug de provisioning — boucle locale, lien-local, tout-zéro — ferait
 * ouvrir une session sur la machine du développeur lui-même, qui y rejouerait la sonde et
 * en renverrait le constat comme s'il décrivait le VPS du client. Les octets à zéro non
 * significatif (`01.02.03.04`) sont écartés pour la même raison que `parseInt` sans
 * radix : certains parseurs C les relisent en octal, une forme différente pour la même
 * chaîne selon qui la lit.
 */
function isRoutableIpv4(ipv4: string): boolean {
  const octets = ipv4.split(".")
  if (octets.length !== 4) return false

  for (const octet of octets) {
    if (octet.length > 1 && octet.startsWith("0")) return false
  }

  const first = Number(octets[0])
  const second = Number(octets[1])

  if (first === 0) return false // 0.0.0.0 et le reste de 0.0.0.0/8
  if (first === 127) return false // boucle locale
  if (first === 169 && second === 254) return false // lien-local, dont 169.254.169.254

  return true
}

/**
 * Résout la cible SSH d'une instance. Aucun des deux arguments ne vient jamais d'un
 * agent sous forme de texte libre : `instance` vient de l'API, `user` — quand il est
 * fourni — est validé ci-dessous avant de pouvoir désigner autre chose qu'un compte
 * local sur la machine cible.
 */
export function resolveSshTarget(instance: Instance, user?: string): SshTarget {
  if (instance.status !== "RUNNING") {
    // RESCUE répond bien à SSH, mais c'est un système de secours qui démarre alors, pas
    // le disque du client : la sonde y constaterait une machine vierge et le dirait à
    // tort. Un refus explicite vaut mieux qu'un constat qui a l'air valide et ne l'est
    // pas — ne pas élargir cette liste à RESCUE sans changer aussi ce que lit la sonde.
    const label = STATUS_LABELS[instance.status] ?? (instance.status || "état inconnu")

    throw new SkyNodeError(400, `Ce serveur n’est pas accessible en SSH : il est ${label}.`)
  }

  if (!instance.ipv4) {
    throw new SkyNodeError(400, "Ce serveur n’a pas encore d’adresse IPv4 attribuée.")
  }

  // `typeof` en plus du format : l'API ne garantit la forme de sa réponse qu'au
  // compilateur, pas à l'exécution. Sans ce garde, un tableau comme `["1.2.3.4"]`
  // traverserait le test de forme (RegExp#test convertit son argument en chaîne) pour
  // ressortir tel quel, non converti, comme `host`.
  if (
    typeof instance.ipv4 !== "string" ||
    !IPV4_PATTERN.test(instance.ipv4) ||
    !isRoutableIpv4(instance.ipv4)
  ) {
    throw new SkyNodeError(
      400,
      `L’adresse IPv4 rendue par l’API SkyNode est invalide : « ${String(instance.ipv4)} ».`
    )
  }

  // `??` et non `||` : un utilisateur explicitement vide vient de l'agent et doit être
  // refusé comme n'importe quelle autre valeur invalide, pas silencieusement remplacé.
  // Le repli sur « root » ne s'applique qu'à une valeur absente côté API.
  const candidate = user ?? (instance.defaultUser || "root")

  if (!USER_PATTERN.test(candidate)) {
    const shown = candidate.length > 24 ? `${candidate.slice(0, 24)}…` : candidate

    throw new SkyNodeError(
      400,
      `« ${shown} » n’est pas un utilisateur valide : 32 caractères maximum, débutant par ` +
        "une lettre minuscule ou « _ », suivie de lettres minuscules, chiffres, « _ » ou « - »."
    )
  }

  return { host: instance.ipv4, user: candidate }
}

export function buildSshArgs(target: SshTarget): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "LogLevel=ERROR",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    // Sans -T, ssh alloue un pseudo-terminal qui traduit chaque \n en \r\n : l'analyseur
    // de la sonde en dépend, et sa robustesse face à un \r isolé n'est pas une raison
    // d'y renoncer.
    "-T",
    "-l", target.user,
    target.host,
    "/bin/sh", "-s",
  ]
}

/** Au-delà, chaque ligne de plus est un jeton dépensé sur du bruit plutôt que sur la tâche. */
const STDERR_MAX_LINES = 10
const STDERR_MAX_CHARS = 600

/**
 * Un chemin qui contient `.ssh` désigne presque toujours une clé du développeur : ni son
 * nom ni son emplacement n'aident l'agent, et les laisser filtrer les enverrait vers le
 * fournisseur du modèle. Une chaîne collée entre guillemets ou espaces suffit à la
 * délimiter, sans avoir à connaître la forme exacte du message qui la porte.
 */
const SSH_PATH_PATTERN = /[^\s"'()]*\.ssh[^\s"'()]*/g

/**
 * Borne et assainit une sortie d'erreur avant qu'elle n'entre dans un message destiné à
 * l'agent. `stdout`/`stderr` de `SshResult` restent bruts et complets — c'est cette
 * fonction, pas eux, qui porte la responsabilité de ne pas déverser un fichier entier
 * (ou une clé privée) dans le contexte d'une conversation avec le statut de résultat
 * d'outil, exactement ce que le projet évite déjà pour le contenu d'un dépôt.
 */
function sanitizeStderr(raw: string): string {
  const masked = raw.replace(SSH_PATH_PATTERN, "‹chemin masqué›")
  const lines = masked.split("\n")

  const cutLines = lines.length > STDERR_MAX_LINES
  const kept = cutLines ? lines.slice(-STDERR_MAX_LINES) : lines

  let text = kept.join("\n").trim()
  const cutChars = text.length > STDERR_MAX_CHARS
  if (cutChars) {
    text = text.slice(-STDERR_MAX_CHARS)
  }

  if (!text) return ""

  return cutLines || cutChars ? `[sortie tronquée]\n${text}` : text
}

/** Un message qui porte le code et, s'il y en a une, une sortie d'erreur bornée. */
function describeFailure(label: string, code: number, stderr: string): string {
  const detail = sanitizeStderr(stderr)

  return detail
    ? `${label} (code ${code}) : ${detail}`
    : `${label} (code ${code}), sans détail transmis par le serveur.`
}

/**
 * Traduit un échec du client `ssh` en message qu'un agent peut relayer sans deviner.
 *
 * `ssh` réserve le code 255 à ses propres échecs — poignée de main, authentification,
 * réseau. Tout autre code non nul est celui de la commande exécutée sur le serveur
 * distant : un `Permission denied` du fichier lu là-bas n'a rien à voir avec la clé
 * SSH, et le dire autrement enverrait déboguer le mauvais bout. `null` signifie « rien
 * à expliquer », pas « pas d'explication ».
 */
export function explainSsh(result: SshResult): string | null {
  const { code, stderr } = result

  if (code === 0) return null

  // Réservé au cas où `spawn` n'a pas trouvé le binaire local (ENOENT, traduit par
  // `systemSsh` avec ce préfixe) : un script distant qui échoue s'annonce par son
  // interpréteur (« bash: », « sh: »), jamais par « ssh: ».
  if (/^ssh: command not found/.test(stderr)) {
    return (
      "Le client ssh n’est pas installé sur cette machine. Installez OpenSSH " +
      "(paquet openssh-client sous Linux, déjà présent sous macOS) ; sous Windows, " +
      "passez par WSL."
    )
  }

  if (code !== 255) {
    return describeFailure("La commande exécutée sur le serveur a échoué", code, stderr)
  }

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(stderr)) {
    return (
      "La clé du serveur a changé depuis la dernière connexion. Si ce serveur vient " +
      "d’être réinstallé ou restauré, retirez son ancienne entrée de ~/.ssh/known_hosts " +
      "avant de réessayer ; sinon, ne poursuivez pas — cela peut signaler une interception."
    )
  }

  if (/Too many authentication failures/.test(stderr)) {
    return (
      "Trop de clés ont été présentées avant la bonne, et le serveur a coupé la " +
      "connexion. Réduisez le nombre de clés chargées dans l’agent, ou limitez celle " +
      "utilisée avec IdentitiesOnly=yes."
    )
  }

  if (/Permission denied/.test(stderr)) {
    return "Authentification par clé refusée : aucune des clés disponibles n’est autorisée sur ce serveur."
  }

  if (/Connection refused/.test(stderr)) {
    return "Connexion refusée : rien n’écoute sur le port 22 de ce serveur, ou un pare-feu la bloque activement."
  }

  if (/Connection timed out/.test(stderr)) {
    return "Délai dépassé en tentant de joindre le serveur : un pare-feu bloque probablement le port 22 en silence."
  }

  if (/Could not resolve hostname/.test(stderr)) {
    return "Impossible de résoudre l’adresse du serveur."
  }

  return describeFailure("ssh a échoué", code, stderr)
}

/**
 * Runner qui délègue au binaire `ssh` du système via `spawn`. Toujours un tableau
 * d'arguments, jamais `shell: true` ni une chaîne : le script part sur l'entrée standard
 * pour qu'aucune de ses lignes n'ait à traverser un interpréteur de commande local.
 */
export function systemSsh(options?: { bin?: string; timeoutMs?: number }): SshRunner {
  const bin = options?.bin ?? "ssh"
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    run(target: SshTarget, script: string): Promise<SshResult> {
      return new Promise((settle) => {
        const child = spawn(bin, buildSshArgs(target), { stdio: ["pipe", "pipe", "pipe"] })

        let stdout = ""
        let stderr = ""
        let done = false
        let timedOut = false

        const finish = (result: SshResult): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          settle(result)
        }

        // `ConnectTimeout` de ssh ne couvre que la poignée de main : une machine qui
        // accepte la connexion puis ne répond plus laisserait sinon l'agent attendre
        // indéfiniment une main qui ne revient jamais. On ne résout qu'à la fermeture
        // réelle du processus (`close`, plus bas) : résoudre dès l'envoi de SIGKILL
        // rendrait la main avant que le processus soit mort, et laisserait un `ssh`
        // orphelin traîner sur la machine du développeur le temps qu'il achève de mourir.
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, timeoutMs)

        // `setEncoding` fait tenir par Node le décodeur UTF-8 entre deux blocs : sans
        // lui, un caractère multi-octets coupé à la frontière d'un `Buffer` ressort en
        // U+FFFD et fausse la longueur — invisible sur de l'ASCII, garanti dès qu'une
        // sortie accentuée dépasse la taille d'un bloc de lecture.
        child.stdout?.setEncoding("utf8")
        child.stderr?.setEncoding("utf8")

        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk
        })

        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk
        })

        // Écrire après l'échec du spawn ferait émettre EPIPE sur ce flux ; sans
        // écouteur, Node le remonterait en exception non gérée. L'échec lui-même est
        // déjà traité par `child.on("error", …)` ci-dessous.
        child.stdin?.on("error", () => {})

        child.on("error", (error: NodeJS.ErrnoException) => {
          const missing = error.code === "ENOENT"
          finish({
            code: missing ? 127 : -1,
            stdout,
            stderr: missing ? `ssh: command not found (${error.message})` : error.message,
          })
        })

        child.on("close", (code) => {
          if (timedOut) {
            finish({
              code: -1,
              stdout,
              stderr: "Délai dépassé : la session SSH n’a pas rendu la main à temps.",
            })
            return
          }

          finish({ code: code ?? -1, stdout, stderr })
        })

        child.stdin?.write(script)
        child.stdin?.end()
      })
    },
  }
}
