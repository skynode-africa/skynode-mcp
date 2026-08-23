import type { SshResult, SshRunner, SshTarget } from "./ssh.js"
import { explainSsh } from "./ssh.js"

/**
 * Primitif d'exécution : envoie un script sur l'entrée standard d'un `sh` distant et lit
 * son résultat structuré. Même protocole de sortie que `probe.ts` (`clé<TAB>valeur`, un
 * marqueur de fin), mais côté écriture : un script d'étape rend `step.outcome`,
 * `step.detail`, puis `step.end`. Le diagnostic d'un échec, lui, n'est pas déclaré par le
 * script — il vient de `stdout`/`stderr` bruts, bornés et assainis ici, comme `explainSsh`
 * le fait déjà pour un échec de connexion.
 *
 * Aucune commande arbitraire ne transite par ici : `runRemote` exécute ce qu'on lui passe,
 * mais tout appelant compose ce texte depuis des littéraux et des valeurs déjà validées par
 * `plan-validate.ts` — l'invariant se tient en amont, pas dans cette fonction.
 */

/** Ce qu'une étape rend une fois son script exécuté. */
export type Outcome = "applied" | "unchanged" | "failed"

export interface RemoteResult {
  outcome: Outcome
  /** Ce que le script a dit avoir fait, en français, pour le rapport. */
  detail: string
  /** Diagnostic brut, borné, quand ça a échoué. Jamais rendu à l'agent tel quel. */
  diagnostic: string
}

/** Assez pour diagnostiquer, pas assez pour noyer le contexte de l'agent. */
const MAX_DIAGNOSTIC = 1000

/**
 * Borne un diagnostic avant qu'il ne sorte de `runRemote` — même geste que `sanitizeStderr`
 * de `ssh.ts` (troncature marquée plutôt que silencieuse), pour les trois branches qui en
 * produisent un : échec de connexion, sortie incomplète, échec déclaré par le script.
 */
function boundedDiagnostic(raw: string): string {
  if (raw.length <= MAX_DIAGNOSTIC) return raw

  return `[sortie tronquée]\n${raw.slice(-MAX_DIAGNOSTIC)}`
}

/**
 * Masque un chemin de clé SSH dans un diagnostic, à la manière de `sanitizeStderr` côté
 * SSH : ce texte vient de la machine du client, et un chemin de clé qui y apparaît n'aide
 * en rien l'agent à comprendre l'échec.
 */
function maskKeyPaths(raw: string): string {
  return raw.replace(/[^\s"'()]*\.ssh[^\s"'()]*/g, "‹chemin masqué›")
}

/** `stdout` et `stderr` sans séparateur se lisent comme un seul flux confus : un `\n` les distingue. */
function combinedOutput(stdout: string, stderr: string): string {
  if (stdout === "") return stderr
  if (stderr === "") return stdout

  return `${stdout}\n${stderr}`
}

/** Lit le protocole `clé<TAB>valeur` d'un script d'étape, dans l'esprit de `parseProbe`. */
function parseStepOutput(stdout: string): { outcome: Outcome | null; detail: string; end: boolean } {
  const lines = stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)

  let outcome: Outcome | null = null
  let detail = ""

  for (const line of lines) {
    const tabIndex = line.indexOf("\t")
    if (tabIndex === -1) continue

    const key = line.slice(0, tabIndex)
    const value = line.slice(tabIndex + 1)

    if (key === "step.outcome" && (value === "applied" || value === "unchanged" || value === "failed")) {
      outcome = value
    } else if (key === "step.detail") {
      detail = value
    }
  }

  // Le marqueur de fin ne compte que s'il clôt réellement la sortie : ailleurs, il pourrait
  // n'être qu'un fragment traversé avant que la connexion coupe pour de bon. Le lire comme
  // un signal de complétion où qu'il tombe ferait passer une sortie coupée pour complète.
  const lastLine = lines[lines.length - 1]
  const end = lastLine !== undefined && lastLine.startsWith("step.end\t")

  return { outcome, detail, end }
}

export async function runRemote(ssh: SshRunner, target: SshTarget, script: string): Promise<RemoteResult> {
  const result: SshResult = await ssh.run(target, script)

  // `explainSsh` couvre les deux cas d'un code non nul : le 255 réservé à `ssh` lui-même
  // (poignée de main, clé, réseau) et tout autre code, celui de la commande exécutée sur
  // le serveur distant. Un script d'étape n'a donc jamais à refaire cette distinction —
  // la confondre enverrait déboguer le mauvais bout, exactement l'écueil que le jalon 2
  // a déjà fermé côté sonde.
  const sshFailure = explainSsh(result)
  if (sshFailure !== null) {
    return {
      outcome: "failed",
      detail: sshFailure,
      diagnostic: boundedDiagnostic(maskKeyPaths(result.stderr)),
    }
  }

  const parsed = parseStepOutput(result.stdout)

  if (!parsed.end || parsed.outcome === null) {
    // Sans marqueur de fin, la connexion a coupé le script en cours de route : interpréter
    // ce qui est arrivé ferait croire une étape jouée jusqu'au bout, et l'exécuteur
    // enchaînerait sur la suivante sur un serveur laissé à mi-chemin.
    return {
      outcome: "failed",
      detail: "Constat interrompu : le script n'a pas rendu son marqueur de fin, résultat incomplet.",
      diagnostic: boundedDiagnostic(maskKeyPaths(combinedOutput(result.stdout, result.stderr))),
    }
  }

  return {
    outcome: parsed.outcome,
    detail: parsed.detail,
    diagnostic:
      parsed.outcome === "failed"
        ? boundedDiagnostic(maskKeyPaths(combinedOutput(result.stdout, result.stderr)))
        : "",
  }
}

/**
 * Seule forme sûre en `sh` : un guillemet simple protège tout ce qu'il enferme, y compris
 * `$`, les accents graves et les sauts de ligne. La seule séquence qu'il ne peut pas
 * enfermer est lui-même, d'où la substitution — fermer, échapper un guillemet littéral,
 * rouvrir.
 */
export function shellQuote(value: string): string {
  // Un octet nul survit à cette substitution mais pas à un aller-retour par `sh` : `dash`
  // et `busybox ash` le suppriment silencieusement en repassant la valeur, ce qui écrirait
  // un contenu différent de celui demandé sans qu'aucune erreur ne le signale. Refuser vaut
  // mieux qu'un octet perdu en root sans témoin.
  if (value.includes("\0")) {
    throw new Error("Valeur invalide : un octet nul ne peut pas être mis en sécurité pour un script shell.")
  }

  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Mode POSIX de fichier : trois ou quatre chiffres octaux, jamais autre chose. */
const MODE_PATTERN = /^[0-7]{3,4}$/

// Le préfixe, pas seulement la chaîne complète : `writeFileScript` refuse tout contenu qui
// en porte un dérivé, pas seulement une collision exacte avec le délimiteur du jour. Le
// suffixe rend une collision accidentelle avec un `.env` réel pratiquement impossible sans
// rétrécir ce que la fonction refuse.
const HEREDOC_PREFIX = "SKYNODE_EOF"
const HEREDOC = `${HEREDOC_PREFIX}_9f3a`

/**
 * Un fichier que SkyNode possède entièrement : écrit par heredoc quoté (aucune expansion
 * de variable ou de substitution de commande dans le contenu), au mode demandé.
 */
export function writeFileScript(path: string, content: string, mode: string): string {
  // Un contenu portant le délimiteur — ou un préfixe qui s'en approche — couperait le
  // heredoc en deux : tout ce qui suit dans le script deviendrait des commandes exécutées
  // sur la machine du client. Refuser plutôt que d'échapper : le délimiteur est un choix
  // interne, pas une valeur qu'on doit pouvoir faire cohabiter avec n'importe quel contenu.
  if (content.split("\n").some((line) => line.startsWith(HEREDOC_PREFIX))) {
    throw new Error(`Le contenu porte le délimiteur du heredoc (préfixe ${HEREDOC_PREFIX}) : écriture refusée.`)
  }

  // `mode` n'a aucun contrôle en amont — aucune règle de `plan-rules.ts` ne le borne
  // aujourd'hui — et un mode invalide n'est pas un détail cosmétique : `"0600 /etc/passwd"`
  // change le mode d'un autre fichier, `"0600; …"` exécute une deuxième commande. Une
  // regex avant toute interpolation, comme pour le délimiteur ci-dessus.
  if (!MODE_PATTERN.test(mode)) {
    throw new Error(`« ${mode} » n'est pas un mode de fichier valide : trois ou quatre chiffres octaux attendus.`)
  }

  // `path`, lui, n'a pas de forme aussi étroite à valider ici — un chemin absolu légitime
  // porte des lettres, des chiffres, `/`, `-`, `_`, `.` dans a peu près n'importe quel ordre.
  // `shellQuote` le protège donc au même titre que `content` : rien dans cette fonction ne
  // suppose que `path` est sûr par construction.
  const slashIndex = path.lastIndexOf("/")
  const dir = slashIndex === -1 ? "." : path.slice(0, slashIndex) || "/"

  // Un heredoc ne représente que du texte ligne par ligne : le délimiteur doit occuper sa
  // propre ligne pour être reconnu. Un contenu vide n'a donc besoin d'aucun séparateur (le
  // délimiteur suit directement l'ouverture), un contenu qui se termine déjà par un saut de
  // ligne non plus (il fournit déjà la fin de sa dernière ligne) ; seul un contenu qui n'en
  // a pas en réclame un — au prix, dans ce seul cas, d'un octet que le heredoc ne peut pas
  // éviter d'ajouter : sans lui, le délimiteur se collerait à la dernière ligne du contenu
  // et ne serait plus reconnu comme tel.
  // Un octet nul ne traverse pas un heredoc : `sh` le laisse tomber en silence, et le
  // fichier écrit diffère de celui demandé — treize octets réclamés, douze posés, sur un
  // fichier qui peut porter des secrets. Refuser vaut mieux qu'écrire à côté.
  if (content.includes("\0")) {
    throw new Error(
      "Le contenu à écrire porte un octet nul, qu'un heredoc ne peut pas transporter : " +
        "le fichier écrit différerait silencieusement de celui demandé."
    )
  }

  const separator = content === "" || content.endsWith("\n") ? "" : "\n"

  return (
    `mkdir -p ${shellQuote(dir)}\n` +
    `cat > ${shellQuote(path)} <<'${HEREDOC}'\n` +
    content +
    separator +
    `${HEREDOC}\n` +
    `chmod ${mode} ${shellQuote(path)}`
  )
}

/** Nom des marqueurs qui encadrent le bloc géré par SkyNode dans un fichier partagé. */
function markerLines(marker: string): { start: string; end: string } {
  return { start: `# >>> ${marker} >>>`, end: `# <<< ${marker} <<<` }
}

/**
 * Retire le bloc marqué s'il existe déjà. Jamais de redirection qui écraserait le fichier
 * entier : c'est l'invariant de la spec §6.4, un fichier que SkyNode n'a pas créé n'est
 * modifié que par ce bloc.
 */
export function removeMarkerBlockScript(path: string, marker: string): string {
  const { start, end } = markerLines(marker)
  const tmp = `${path}.skynode-tmp`

  return [
    // Un fichier que ce bloc n'a jamais touché reste absent après un retrait : défaire une
    // étape ne doit pas faire apparaître un fichier qui n'existait pas avant elle.
    `if [ -f ${shellQuote(path)} ]; then`,
    // Un marqueur d'ouverture sans marqueur de fermeture correspondant — laissé par une pose
    // interrompue en cours de route, le bloc du bas n'étant pas atomique — ferait supprimer
    // jusqu'à la fin du fichier si l'on lançait `sed` sans y regarder : une plage `/start/,
    // /end/d` dont la deuxième adresse ne se trouve jamais continue jusqu'à EOF. Compter les
    // deux marqueurs avant d'y toucher : un compte différent signale un état déjà corrompu,
    // et mieux vaut laisser le fichier intact que deviner ce qu'il faut en retirer.
    `  n_start=$(grep -c -F -x -- ${shellQuote(start)} ${shellQuote(path)} || true)`,
    `  n_end=$(grep -c -F -x -- ${shellQuote(end)} ${shellQuote(path)} || true)`,
    `  if [ "$n_start" = "$n_end" ]; then`,
    // Jamais `sed -i` : sa syntaxe diverge entre GNU (en place directement) et BSD (un
    // suffixe de sauvegarde est obligatoire) — un fichier temporaire suivi d'un `mv` est la
    // seule forme qui se comporte pareil partout, y compris sur la machine d'un développeur.
    // `mv` ne remplace pas le contenu de l'inode visé : il y met le fichier temporaire,
    // avec SA métadonnée. Un Caddyfile `caddy:caddy 640` deviendrait `root:root 644`, et
    // sous un umask permissif un `600` deviendrait `666` — une configuration rendue
    // inscriptible par tout le monde, sans que rien ne le signale. On relève donc les trois
    // valeurs avant, et on les repose après.
    `    meta=$(stat -c '%u %g %a' ${shellQuote(path)} 2>/dev/null || echo '')`,
    `    sed '/^${sedPattern(start)}$/,/^${sedPattern(end)}$/d' ${shellQuote(path)} > ${shellQuote(tmp)} && mv ${shellQuote(tmp)} ${shellQuote(path)}`,
    `    if [ -n "$meta" ]; then`,
    `      chown "$(echo "$meta" | cut -d' ' -f1):$(echo "$meta" | cut -d' ' -f2)" ${shellQuote(path)} 2>/dev/null || true`,
    `      chmod "$(echo "$meta" | cut -d' ' -f3)" ${shellQuote(path)}`,
    `    fi`,
    `  fi`,
    `fi`,
  ].join("\n")
}

/**
 * Retire le bloc marqué s'il existe déjà, puis en ajoute un nouveau en fin de fichier.
 */
export function markerBlockScript(path: string, marker: string, content: string): string {
  const { start, end } = markerLines(marker)

  return [
    removeMarkerBlockScript(path, marker),
    // Un fichier existant sans saut de ligne final collerait notre marqueur à la dernière
    // ligne humaine (`}# >>> …`) : la ligne d'origine se corrompt, et le `sed` ancré en
    // début de ligne du retrait ne retrouve alors plus jamais ce marqueur — il resterait
    // orphelin pour toujours. `-s` évite ce test sur un fichier vide ou absent : y ajouter
    // une ligne vide n'apporterait rien.
    `[ -s ${shellQuote(path)} ] && [ -n "$(tail -c1 -- ${shellQuote(path)})" ] && printf '\\n' >> ${shellQuote(path)}`,
    `{ printf '%s\\n' ${shellQuote(start)}; printf '%s\\n' ${shellQuote(content)}; printf '%s\\n' ${shellQuote(end)}; } >> ${shellQuote(path)}`,
  ].join("\n")
}

/**
 * Le marqueur ne contient que des caractères choisis par SkyNode (`markerLines`), jamais de
 * texte d'agent — mais `sed` traite `.` `*` `[` `]` `^` `$` `\` comme des métacaractères
 * d'adresse : les échapper garde l'intention littérale même si un futur marqueur en portait.
 */
function sedPattern(literal: string): string {
  return literal.replace(/[.*[\]^$\\]/g, "\\$&")
}
