/**
 * Script de reconnaissance, envoyé sur l'entrée standard d'un `sh` distant.
 *
 * POSIX strict : `/bin/sh` est `dash` sur Debian et Ubuntu, et les constructions de bash
 * y échouent — sur le serveur du client, pas ici.
 *
 * Il ne lit que. Aucune installation, aucune écriture, aucun accès à `~/.ssh`, à
 * `/etc/shadow`, ni à un secret non demandé : `inspect_server` doit pouvoir être joué sur
 * la machine de production d'un inconnu sans qu'il ait à se demander ce qu'on y a fait.
 *
 * Un seul aller-retour : chaque connexion SSH coûte une poignée de main d'environ une
 * seconde, et le script part une fois pour rendre tout ce que la tâche 4 classera.
 *
 * Tableau joint par `\n`, jamais un littéral de gabarit : dans un gabarit TypeScript,
 * `${VAR}` serait interpolé avant d'atteindre le serveur, et le script partirait mutilé.
 */
const LINES = [
  "set -u",
  "emit() { printf '%s\\t%s\\n' \"$1\" \"$2\"; }",
  "emit probe.version 1",

  "emit host.user \"$(id -un 2>/dev/null || echo inconnu)\"",
  "emit host.uid \"$(id -u 2>/dev/null || echo -1)\"",
  "emit host.arch \"$(uname -m 2>/dev/null || echo inconnu)\"",
  "emit host.kernel \"$(uname -r 2>/dev/null || echo inconnu)\"",
  "if [ -r /etc/os-release ]; then",
  "  . /etc/os-release",
  "  emit host.os_id \"${ID:-inconnu}\"",
  "  emit host.os_version \"${VERSION_ID:-}\"",
  "  emit host.os_name \"${PRETTY_NAME:-}\"",
  "else",
  "  emit host.os_id inconnu",
  "fi",

  "emit cpu.count \"$(nproc 2>/dev/null || echo 0)\"",
  "emit mem.total_mb \"$(awk '/^MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)\"",
  "emit swap.total_mb \"$(awk '/^SwapTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)\"",
  // total, disponible, pourcentage d'occupation — sans virgule, awk sépare déjà par un espace.
  "emit disk.root \"$(df -Pk / 2>/dev/null | awk 'NR==2 {print $2, $4, $5}')\"",

  // `sudo -n true` n'exécute que `true` : la vérification est elle-même en lecture seule.
  "if [ \"$(id -u)\" = 0 ]; then",
  "  emit access.elevate root",
  "elif sudo -n true 2>/dev/null; then",
  "  emit access.elevate sudo",
  "else",
  "  emit access.elevate aucun",
  "fi",

  "if command -v docker >/dev/null 2>&1; then",
  "  emit docker.present oui",
  "  emit docker.version \"$(docker --version 2>/dev/null | head -n1)\"",
  // `docker info` échoue si le démon est arrêté ou si l'utilisateur n'est pas dans le
  // groupe : présent n'implique pas utilisable, et la distinction change la marche à suivre.
  "  if docker info >/dev/null 2>&1; then",
  "    emit docker.usable oui",
  "    docker ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}' 2>/dev/null | head -n 100 | while IFS= read -r l; do emit docker.container \"$l\"; done",
  "    docker network ls --format '{{.Name}}' 2>/dev/null | head -n 50 | while IFS= read -r l; do emit docker.network \"$l\"; done",
  "    if docker compose version >/dev/null 2>&1; then emit docker.compose oui; else emit docker.compose non; fi",
  "  else",
  "    emit docker.usable non",
  "  fi",
  "else",
  "  emit docker.present non",
  "fi",

  "if command -v podman >/dev/null 2>&1; then emit podman.present oui; fi",

  "for b in nginx apache2 httpd caddy certbot git tar rsync; do",
  "  if command -v \"$b\" >/dev/null 2>&1; then emit bin \"$b\"; fi",
  "done",

  "if command -v ss >/dev/null 2>&1; then",
  "  ss -lntpH 2>/dev/null | head -n 80 | while IFS= read -r l; do emit listen \"$l\"; done",
  "elif command -v netstat >/dev/null 2>&1; then",
  "  netstat -lntp 2>/dev/null | head -n 80 | while IFS= read -r l; do emit listen \"$l\"; done",
  "fi",

  "if command -v systemctl >/dev/null 2>&1; then",
  "  systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print $1}' | head -n 60 | while IFS= read -r l; do emit service \"$l\"; done",
  "fi",

  // Un marqueur suffit : ces outils possèdent la configuration de la machine, et la
  // priorité qu'ils prennent sur Docker se décide dans `regime.ts`, pas ici.
  "for d in /www/server/panel:aapanel /usr/local/CyberCP:cyberpanel /usr/local/psa:plesk /opt/psa:plesk /usr/local/cpanel:cpanel /data/coolify:coolify /etc/dokploy:dokploy /captain:caprover /etc/webmin:webmin /usr/local/hestia:hestia /usr/local/ispconfig:ispconfig; do",
  "  p=${d%%:*}",
  "  n=${d##*:}",
  "  if [ -d \"$p\" ]; then emit panel \"$n $p\"; fi",
  "done",

  // En base64 : l'état est du JSON, et une tabulation ou un saut de ligne y casserait
  // le format de sortie. `-w0` est propre à GNU, d'où le repli.
  "if [ -f /etc/skynode/state.json ]; then",
  "  emit skynode.present oui",
  "  emit skynode.state_b64 \"$(base64 -w0 < /etc/skynode/state.json 2>/dev/null || base64 < /etc/skynode/state.json 2>/dev/null | tr -d '\\n')\"",
  "else",
  "  emit skynode.present non",
  "fi",

  "emit probe.end 1",
]

export const PROBE_SCRIPT = LINES.join("\n") + "\n"

/** Distingue un constat exploitable d'une sortie qui ne vient pas de `PROBE_SCRIPT`. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProbeError"
  }
}

export interface ServerFacts {
  host: {
    user: string
    uid: number
    arch: string
    kernel: string
    osId: string
    osVersion: string
    osName: string
  }
  resources: {
    cpu: number
    memoryMb: number
    swapMb: number
    diskUsePercent: number
  }
  access: {
    /** "root" | "sudo" | "aucun" — jamais absent : la classification en dépend. */
    elevate: string
  }
  docker: {
    present: boolean
    usable: boolean
    version: string
    compose: boolean
    containers: { name: string; image: string; state: string; ports: string }[]
    networks: string[]
  }
  podmanPresent: boolean
  binaries: string[]
  listeners: Listener[]
  services: string[]
  panel: { id: string; path: string } | null
  skynode: {
    present: boolean
    /** JSON décodé en texte, jamais reparsé ici : la classification en fait ce qu'elle veut. */
    raw: string | null
  }
}

/** Clés dont plusieurs occurrences s'accumulent, dans l'ordre d'arrivée. */
const REPEATED_KEYS = new Set(["docker.container", "docker.network", "listen", "service", "bin", "panel"])

function toInt(value: string | undefined): number {
  if (value === undefined) return 0

  const n = Number.parseInt(value, 10)

  return Number.isFinite(n) ? n : 0
}

function isOui(value: string | undefined): boolean {
  return value === "oui"
}

/**
 * `docker.container` a la forme "nom|image|état|ports" : le séparateur `|` n'apparaît
 * dans aucun de ces champs, contrairement à `:` ou à l'espace.
 */
function parseContainer(line: string): { name: string; image: string; state: string; ports: string } {
  const parts = line.split("|")

  return {
    name: parts[0] ?? "",
    image: parts[1] ?? "",
    state: parts[2] ?? "",
    ports: parts[3] ?? "",
  }
}

type Listener = { address: string; port: number; process: string | null }

/**
 * `ss` s'entoure de crochets pour une adresse IPv6 (`[::]:80`), `netstat` ne le fait pas
 * (`:::80`) : sans normalisation, la même machine écouterait « différemment » selon
 * l'outil qui a répondu, et la tâche 4 compare l'adresse à une liste fixe.
 */
function stripBrackets(address: string): string {
  return address.replace(/^\[/, "").replace(/\]$/, "")
}

/**
 * L'adresse et le port occupent la même colonne (locale) dans `ss` et dans `netstat`,
 * séparés par le dernier `:` — un IPv6 en contient plusieurs.
 */
function addressAndPort(local: string): { address: string; port: number } {
  const lastColon = local.lastIndexOf(":")
  const address = lastColon === -1 ? local : local.slice(0, lastColon)
  const port = lastColon === -1 ? 0 : toInt(local.slice(lastColon + 1))

  return { address: stripBrackets(address), port }
}

/**
 * Les deux outils de repli produisent des formats disjoints, et le script peut avoir
 * utilisé l'un ou l'autre selon ce qui était installé sur la machine sondée :
 *
 * - `ss -lntpH` (sans en-tête) : "LISTEN <recv-q> <send-q> <local> <peer> [users:...]" —
 *   le nom de processus se lit dans `users:(("nom",`.
 * - `netstat -lntp` (avec deux lignes d'en-tête à écarter) :
 *   "tcp[6] <recv-q> <send-q> <local> <peer> LISTEN <pid>/<nom>".
 *
 * Une ligne qui ne correspond à aucun des deux formats — en-tête, ligne tronquée par une
 * connexion coupée en cours de lecture — est écartée plutôt que transformée en écouteur
 * fantôme sur le port 0.
 */
function parseListener(line: string): Listener | null {
  const fields = line.split(/\s+/).filter((f) => f.length > 0)

  if (fields[0] === "LISTEN") {
    const local = fields[3]
    if (!local) return null

    const processMatch = /users:\(\("([^"]+)"/.exec(line)

    return { ...addressAndPort(local), process: processMatch?.[1] ?? null }
  }

  if (fields[0] === "tcp" || fields[0] === "tcp6") {
    if (fields[5] !== "LISTEN") return null

    const local = fields[3]
    if (!local) return null

    const pidProgram = fields[6]
    const slash = pidProgram?.indexOf("/") ?? -1
    const process = pidProgram && pidProgram !== "-" && slash !== -1 ? pidProgram.slice(slash + 1) : null

    return { ...addressAndPort(local), process }
  }

  // Ni "LISTEN" en tête (ss) ni "tcp"/"tcp6" (netstat) : bannière, ligne d'en-tête de
  // `netstat`, ou ligne coupée — dans tous les cas, pas un écouteur.
  return null
}

/** "id chemin" — un seul espace sépare les deux, produit par la boucle du script. */
function parsePanel(line: string): { id: string; path: string } {
  const spaceIndex = line.indexOf(" ")

  if (spaceIndex === -1) return { id: line, path: "" }

  return { id: line.slice(0, spaceIndex), path: line.slice(spaceIndex + 1) }
}

// Base64 standard : le nombre de `=` de remplissage (0, 1 ou 2) dépend du reste de la
// division de la longueur des octets d'origine par 3, d'où l'intervalle `{0,2}`.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Décodage best-effort : un état corrompu ne doit pas faire perdre tout le constat.
 *
 * `Buffer.from(..., "base64")` ne lève jamais — il ignore silencieusement les octets
 * hors alphabet et complète les groupes incomplets — d'où deux vérifications en amont
 * qu'il ne fait pas lui-même : la forme (alphabet, remplissage) et la longueur, seul
 * moyen de distinguer un état tronqué d'un état bien formé, et une chaîne vide (les deux
 * tentatives du script ont échoué) d'un état vide.
 */
function decodeSkynodeState(b64: string | undefined): string | null {
  if (b64 === undefined || b64.length === 0) return null
  if (b64.length % 4 !== 0 || !BASE64_PATTERN.test(b64)) return null

  const decoded = Buffer.from(b64, "base64").toString("utf8")

  // Le caractère de remplacement Unicode signale une séquence UTF-8 invalide : l'état
  // n'était pas du texte, l'appelant ne doit pas en hériter.
  if (decoded.includes("�")) return null

  return decoded
}

export function parseProbe(rawOutput: string): ServerFacts {
  // `-T` verrouille des retours à la ligne LF côté SSH (tâche 5), mais rien ici ne doit
  // en dépendre : un `\r` résiduel contaminerait silencieusement chaque comparaison de
  // valeur ("root\r" n'est ni "root", ni "sudo", ni "aucun") sans faire échouer l'analyse.
  const lines = rawOutput.split("\n").map((l) => l.replace(/\r$/, ""))

  const headerIndex = lines.findIndex((l) => l.startsWith("probe.version\t"))

  if (headerIndex === -1) {
    throw new ProbeError(
      "Cette sortie ne vient pas de la sonde de reconnaissance SkyNode : l'en-tête est absent."
    )
  }

  const single = new Map<string, string>()
  const repeated = new Map<string, string[]>()
  let sawEnd = false

  for (const line of lines.slice(headerIndex)) {
    const tabIndex = line.indexOf("\t")
    if (tabIndex === -1) continue

    const key = line.slice(0, tabIndex)
    const value = line.slice(tabIndex + 1)

    if (key === "probe.end") {
      sawEnd = true
      continue
    }

    if (REPEATED_KEYS.has(key)) {
      const list = repeated.get(key) ?? []
      list.push(value)
      repeated.set(key, list)
    } else {
      single.set(key, value)
    }
  }

  if (!sawEnd) {
    throw new ProbeError(
      "Constat incomplet : le marqueur de fin est absent, la connexion a probablement été coupée en cours de sonde."
    )
  }

  return {
    host: {
      user: single.get("host.user") ?? "inconnu",
      uid: toInt(single.get("host.uid")),
      arch: single.get("host.arch") ?? "inconnu",
      kernel: single.get("host.kernel") ?? "inconnu",
      osId: single.get("host.os_id") ?? "inconnu",
      osVersion: single.get("host.os_version") ?? "",
      osName: single.get("host.os_name") ?? "",
    },
    resources: {
      cpu: toInt(single.get("cpu.count")),
      memoryMb: toInt(single.get("mem.total_mb")),
      swapMb: toInt(single.get("swap.total_mb")),
      diskUsePercent: toInt(single.get("disk.root")?.split(/\s+/)[2]),
    },
    access: {
      elevate: single.get("access.elevate") ?? "aucun",
    },
    docker: {
      present: isOui(single.get("docker.present")),
      usable: isOui(single.get("docker.usable")),
      version: single.get("docker.version") ?? "",
      compose: isOui(single.get("docker.compose")),
      containers: (repeated.get("docker.container") ?? []).map(parseContainer),
      networks: repeated.get("docker.network") ?? [],
    },
    podmanPresent: isOui(single.get("podman.present")),
    binaries: repeated.get("bin") ?? [],
    listeners: (repeated.get("listen") ?? [])
      .map(parseListener)
      .filter((l): l is Listener => l !== null),
    services: repeated.get("service") ?? [],
    // Plusieurs répertoires de panneaux sur une même machine sont improbables ; en cas de
    // coexistence, le premier détecté suit l'ordre du script, des panneaux les plus
    // spécifiques vers les plus génériques.
    panel: (() => {
      const first = (repeated.get("panel") ?? [])[0]
      return first === undefined ? null : parsePanel(first)
    })(),
    skynode: {
      present: isOui(single.get("skynode.present")),
      raw: decodeSkynodeState(single.get("skynode.state_b64")),
    },
  }
}
