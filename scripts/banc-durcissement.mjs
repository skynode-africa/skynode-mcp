// Banc d'essai du durcissement SSH : joue les six points de l'étape 4 contre un vrai sshd.
//
// Le runner d'essai ajoute `-p` et `-i` que `buildSshArgs` ne connaît pas — le banc écoute
// sur un port éphémère avec une clé jetable. `SshTarget` et `buildSshArgs` restent intacts :
// `hardenSsh` reçoit son `SshRunner`, c'est tout ce que la conception demande.
//
// Usage :
//   scripts/banc.sh up
//   pnpm build
//   BANC_CLE="${TMPDIR:-/tmp}/skynode-banc/skynode-banc/id_ed25519" \
//     node scripts/banc-durcissement.mjs prepare | durcir | durcir-piege | etat
//
// `PIEGE_TRANSITOIRE=1` fait disparaître le piège au moment du retour arrière, pour
// éprouver la branche « la porte se rouvre » plutôt que « la cause est antérieure ».
import { execFileSync, spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Chemin déduit du fichier, jamais écrit en dur : ce dépôt est public et un chemin de
// développeur y désignerait une machine réelle.
const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))
const { hardenSsh, CHEMIN_DURCISSEMENT } = await import(join(RACINE, "dist", "ssh-harden.js"))
const { recipeFor } = await import(join(RACINE, "dist", "step.js"))

const NOM = "skynode-banc"
const CLE = process.env.BANC_CLE
if (!CLE) {
  throw new Error(
    "BANC_CLE manque : le chemin de la clé jetable, que « scripts/banc.sh up » émet en banc.cle."
  )
}
const PORT = execFileSync("docker", ["port", NOM, "22"], { encoding: "utf8" }).split("\n")[0].split(":").pop().trim()
const HOTE = "127.0.0.1"

const OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
  "-o", "IdentitiesOnly=yes",
  "-i", CLE,
  "-p", PORT,
]

function sshBrut(user, script, options = OPTIONS) {
  return new Promise((resolve) => {
    const enfant = spawn("ssh", [...options, "-T", "-l", user, HOTE, "/bin/sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    enfant.stdout.setEncoding("utf8")
    enfant.stderr.setEncoding("utf8")
    enfant.stdout.on("data", (c) => (stdout += c))
    enfant.stderr.on("data", (c) => (stderr += c))
    enfant.stdin.on("error", () => {})
    enfant.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
    enfant.stdin.write(script)
    enfant.stdin.end()
  })
}

/** Le runner d'essai. `avant` permet d'injecter un incident juste avant un appel donné. */
function runnerBanc(avant = async () => {}) {
  let n = 0
  return {
    async run(target, script) {
      n += 1
      await avant(n)
      const r = await sshBrut(target.user, script)
      journal.push({ appel: n, user: target.user, code: r.code })
      return r
    },
  }
}

let journal = []
const root = () => ({ host: HOTE, user: "root" })
const dit = (...a) => console.log(...a)

async function commande(script, user = "root") {
  const r = await sshBrut(user, script)
  return { code: r.code, sortie: (r.stdout + r.stderr).trim() }
}

async function main() {
  const quoi = process.argv[2]

  if (quoi === "prepare") {
    const s = recipeFor("host.prepare").script({ type: "host.prepare", swap_mo: 0 }, {
      application: "essai", projectRoot: "/tmp", workDir: "/tmp",
    })
    const r = await sshBrut("root", s)
    dit(r.stdout.trim())
    dit("--- code:", r.code)
    return
  }

  if (quoi === "durcir") {
    journal = []
    const r = await hardenSsh(runnerBanc(), root(), "skynode")
    dit("outcome :", r.outcome)
    dit("detail  :", r.detail)
    if (r.diagnostic) dit("diagnostic :", r.diagnostic)
    dit("appels  :", JSON.stringify(journal))
    return
  }

  if (quoi === "durcir-piege") {
    // Une configuration valide pour `sshd -t` mais qui refuse la connexion, déposée juste
    // avant l'appel qui écrit et recharge : la porte est donc ouverte au point 2 et fermée
    // au point 6, exactement le cas que le filet doit rattraper.
    journal = []
    const r = await hardenSsh(
      runnerBanc(async (n) => {
        if (n === 3) {
          await commande("printf 'DenyUsers skynode\\n' > /etc/ssh/sshd_config.d/60-piege.conf")
        }
        // Le piège disparaît au moment du retour arrière quand on veut éprouver la branche
        // « la porte se rouvre » ; sinon il reste, et le message doit dire que la cause est
        // antérieure au durcissement.
        if (n === 5 && process.env.PIEGE_TRANSITOIRE === "1") {
          await commande("rm -f /etc/ssh/sshd_config.d/60-piege.conf")
        }
      }),
      root(),
      "skynode"
    )
    dit("outcome :", r.outcome)
    dit("detail  :", r.detail)
    dit("appels  :", JSON.stringify(journal))
    return
  }

  if (quoi === "etat") {
    const r = await commande(
      "ls -l " + CHEMIN_DURCISSEMENT + " 2>&1 || echo 'ABSENT ' " + CHEMIN_DURCISSEMENT + "; " +
      "echo '--- sshd -T :'; sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '; " +
      "echo '--- fichiers :'; ls /etc/ssh/sshd_config.d/"
    )
    dit(r.sortie)
    return
  }

  throw new Error("usage : prepare | durcir | durcir-piege | etat")
}

await main()
