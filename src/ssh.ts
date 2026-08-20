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
 * Résout la cible SSH d'une instance. Aucun des deux arguments ne vient jamais d'un
 * agent sous forme de texte libre : `instance` vient de l'API, `user` — quand il est
 * fourni — est validé ci-dessous avant de pouvoir désigner autre chose qu'un compte
 * local sur la machine cible.
 */
export function resolveSshTarget(instance: Instance, user?: string): SshTarget {
  if (instance.status !== "RUNNING") {
    throw new SkyNodeError(
      400,
      `Ce serveur n’est pas accessible en SSH : il est ${STATUS_LABELS[instance.status] ?? instance.status}.`
    )
  }

  if (!instance.ipv4) {
    throw new SkyNodeError(400, "Ce serveur n’a pas encore d’adresse IPv4 attribuée.")
  }

  if (!IPV4_PATTERN.test(instance.ipv4)) {
    // L'API est de confiance, mais cette valeur finit dans un tableau d'arguments passé
    // à `spawn` : mieux vaut refuser une forme inattendue que la transmettre telle quelle.
    throw new SkyNodeError(
      400,
      `L’adresse IPv4 rendue par l’API SkyNode est invalide : « ${instance.ipv4} ».`
    )
  }

  const candidate = user ?? instance.defaultUser ?? "root"

  if (!USER_PATTERN.test(candidate)) {
    throw new SkyNodeError(
      400,
      `« ${candidate} » n’est pas un utilisateur valide : lettres minuscules, chiffres, ` +
        "« _ » et « - » uniquement, sans « @ » ni espace."
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

/**
 * Traduit un échec du client `ssh` en message qu'un agent peut relayer sans deviner. Les
 * messages du client sont en anglais et parlent de la mécanique SSH ; ici on parle de ce
 * qu'il faut faire. `null` signifie « rien à expliquer », pas « pas d'explication ».
 */
export function explainSsh(result: SshResult): string | null {
  const { code, stderr } = result

  if (code === 0) return null

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

  if (code === 127 || /command not found/.test(stderr)) {
    return (
      "Le client ssh n’est pas installé sur cette machine. Installez OpenSSH " +
      "(paquet openssh-client sous Linux, déjà présent sous macOS) ; sous Windows, " +
      "passez par WSL."
    )
  }

  return `ssh a échoué (code ${code}) : ${stderr}`.trim()
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

        const finish = (result: SshResult): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          settle(result)
        }

        // `ConnectTimeout` de ssh ne couvre que la poignée de main : une machine qui
        // accepte la connexion puis ne répond plus laisserait sinon l'agent attendre
        // indéfiniment une main qui ne revient jamais.
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          finish({
            code: -1,
            stdout,
            stderr: "Délai dépassé : la session SSH n’a pas rendu la main à temps.",
          })
        }, timeoutMs)

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8")
        })

        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8")
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
          finish({ code: code ?? -1, stdout, stderr })
        })

        child.stdin?.write(script)
        child.stdin?.end()
      })
    },
  }
}
