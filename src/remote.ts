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
 * `stderr` d'un script distant porte les mêmes risques que celui de la sonde : chemins de
 * clé, sorties à rallonge. `explainSsh` sait déjà distinguer un échec de connexion (255) —
 * on lui délègue ce cas plutôt que de redire la logique, et on ne tronque nous-mêmes que
 * pour le cas restant, l'échec du script lui-même.
 */
function boundedDiagnostic(raw: string): string {
  if (raw.length <= MAX_DIAGNOSTIC) return raw

  return raw.slice(-MAX_DIAGNOSTIC)
}

/**
 * Masque un chemin de clé SSH dans un diagnostic, à la manière de `sanitizeStderr` côté
 * SSH : ce texte vient de la machine du client, et un chemin de clé qui y apparaît n'aide
 * en rien l'agent à comprendre l'échec.
 */
function maskKeyPaths(raw: string): string {
  return raw.replace(/[^\s"'()]*\.ssh[^\s"'()]*/g, "‹chemin masqué›")
}

/** Lit le protocole `clé<TAB>valeur` d'un script d'étape, dans l'esprit de `parseProbe`. */
function parseStepOutput(stdout: string): { outcome: Outcome | null; detail: string; end: boolean } {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, ""))

  let outcome: Outcome | null = null
  let detail = ""
  let end = false

  for (const line of lines) {
    const tabIndex = line.indexOf("\t")
    if (tabIndex === -1) continue

    const key = line.slice(0, tabIndex)
    const value = line.slice(tabIndex + 1)

    if (key === "step.outcome" && (value === "applied" || value === "unchanged" || value === "failed")) {
      outcome = value
    } else if (key === "step.detail") {
      detail = value
    } else if (key === "step.end") {
      end = true
    }
  }

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
      diagnostic: boundedDiagnostic(maskKeyPaths(result.stdout + result.stderr)),
    }
  }

  return {
    outcome: parsed.outcome,
    detail: parsed.detail,
    diagnostic: parsed.outcome === "failed" ? boundedDiagnostic(maskKeyPaths(result.stdout + result.stderr)) : "",
  }
}

/**
 * Seule forme sûre en `sh` : un guillemet simple protège tout ce qu'il enferme, y compris
 * `$`, les accents graves et les sauts de ligne. La seule séquence qu'il ne peut pas
 * enfermer est lui-même, d'où la substitution — fermer, échapper un guillemet littéral,
 * rouvrir.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

// Entièrement majuscules et « _ » : c'est aussi la forme que `writeFileScript` doit
// produire pour son heredoc, condition posée par le test de forme. Improbable dans un
// fichier de configuration, et vérifié absent avant écriture.
const HEREDOC = "SKYNODE_EOF"

/**
 * Un fichier que SkyNode possède entièrement : écrit par heredoc quoté (aucune expansion
 * de variable ou de substitution de commande dans le contenu), au mode demandé.
 */
export function writeFileScript(path: string, content: string, mode: string): string {
  // Un contenu portant le délimiteur couperait le heredoc en deux : tout ce qui suit dans
  // le script deviendrait des commandes exécutées sur la machine du client. Refuser plutôt
  // que d'échapper : le délimiteur est un choix interne, pas une valeur qu'on doit pouvoir
  // faire cohabiter avec n'importe quel contenu.
  if (content.split("\n").includes(HEREDOC)) {
    throw new Error(`Le contenu porte le délimiteur du heredoc (${HEREDOC}) : écriture refusée.`)
  }

  // `path` n'est jamais du texte d'agent : il vient d'un gabarit interne (les répertoires
  // que SkyNode connaît, validés par `plan-rules.ts` dans les tâches qui composent ces
  // scripts), au même titre que `host`/`user` dans `resolveSshTarget`. `shellQuote` reste
  // le rempart pour `content`, seule valeur qui peut porter n'importe quel caractère.
  const dir = path.slice(0, path.lastIndexOf("/")) || "/"

  return [
    `mkdir -p ${dir}`,
    `cat > ${path} <<'${HEREDOC}'`,
    content,
    HEREDOC,
    `chmod ${mode} ${path}`,
  ].join("\n")
}

/** Nom des marqueurs qui encadrent le bloc géré par SkyNode dans un fichier partagé. */
function markerLines(marker: string): { start: string; end: string } {
  return { start: `# >>> ${marker} >>>`, end: `# <<< ${marker} <<<` }
}

/**
 * Retire le bloc marqué s'il existe déjà, puis en ajoute un nouveau en fin de fichier.
 * Jamais de redirection qui écraserait le fichier entier : c'est l'invariant de la spec
 * §6.4, un fichier que SkyNode n'a pas créé n'est modifié que par ce bloc.
 */
export function markerBlockScript(path: string, marker: string, content: string): string {
  const { start, end } = markerLines(marker)

  return [
    removeMarkerBlockScript(path, marker),
    `{ printf '%s\\n' ${shellQuote(start)}; printf '%s\\n' ${shellQuote(content)}; printf '%s\\n' ${shellQuote(end)}; } >> ${shellQuote(path)}`,
  ].join("\n")
}

/**
 * `sed` ne touche que les lignes du bloc, jamais le reste du fichier. `touch` avant : un
 * fichier absent ferait échouer `sed -i` plutôt que le laisser vide et prêt à recevoir le
 * bloc — c'est le cas d'un fichier que SkyNode pose pour la première fois.
 */
export function removeMarkerBlockScript(path: string, marker: string): string {
  const { start, end } = markerLines(marker)

  return [
    `touch ${shellQuote(path)}`,
    `sed -i '/^${sedPattern(start)}$/,/^${sedPattern(end)}$/d' ${shellQuote(path)}`,
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
