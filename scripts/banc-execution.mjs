// Banc d'essai de l'exécuteur : joue les quatre points de l'étape 4 de la tâche 8 contre un
// vrai conteneur portant Docker.
//
// `executePlan` reçoit un `SshRunner` : le banc lui en donne un qui ajoute `-p` et `-i`,
// comme les autres pilotes. Le transfert, lui, monte son propre tuyau `tar | ssh` et passe
// donc par `options.transfer`, avec le même enrobage de `ssh`.
//
// Usage :
//   scripts/banc.sh up --with-docker
//   pnpm build
//   BANC_CLE="…/id_ed25519" node scripts/banc-execution.mjs
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))
const { executePlan } = await import(join(RACINE, "dist", "executor.js"))
const { formatExecReport } = await import(join(RACINE, "dist", "exec-render.js"))
const { transferProject } = await import(join(RACINE, "dist", "transfer.js"))

const CLE = process.env.BANC_CLE
if (!CLE) throw new Error("BANC_CLE manque : le chemin de la clé jetable émis par « scripts/banc.sh up ».")
const PORT = execFileSync("docker", ["port", "skynode-banc-docker", "22"], { encoding: "utf8" })
  .split("\n")[0].split(":").pop().trim()

const OPTIONS_SSH = [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR", "-o", "IdentitiesOnly=yes", "-i", CLE, "-p", PORT,
]

const BAC = mkdtempSync(join(tmpdir(), "skynode-banc-exec-"))
const SSH_ENROBE = join(BAC, "ssh")
writeFileSync(SSH_ENROBE, `#!/bin/sh\nexec ssh ${OPTIONS_SSH.map((o) => `'${o}'`).join(" ")} "$@"\n`)
chmodSync(SSH_ENROBE, 0o755)

const CIBLE = { host: "127.0.0.1", user: "root" }

function brut(script) {
  return new Promise((resolve) => {
    const e = spawn("ssh", [...OPTIONS_SSH, "-T", "-l", "root", "127.0.0.1", "/bin/sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let o = ""
    let r = ""
    e.stdout.setEncoding("utf8")
    e.stderr.setEncoding("utf8")
    e.stdout.on("data", (c) => (o += c))
    e.stderr.on("data", (c) => (r += c))
    e.stdin.on("error", () => {})
    e.on("close", (c) => resolve({ code: c ?? -1, stdout: o, stderr: r }))
    e.stdin.write(script)
    e.stdin.end()
  })
}

const RUNNER = { run: async (_cible, script) => brut(script) }
const TRANSFERT = (cible, racine, workDir, preserve) =>
  transferProject(cible, racine, workDir, preserve, { sshBin: SSH_ENROBE })

const PROJET = join(RACINE, "fixtures", "node-constructible")
const CTX = { projectRoot: PROJET }

const plan = (etapes) => ({
  version: 1,
  id: "plan_banc0001",
  serveur: "banc",
  regime: "docker",
  empreinte_etat: `sha256:${"0".repeat(64)}`,
  application: "boutique",
  resume: "déployer boutique sur le banc",
  etapes,
  hors_perimetre: [],
  reversible: true,
})

const COMPLET = [
  { type: "proxy.caddy.install" },
  { type: "build.generate_dockerfile", famille: "node", version: "22", gestionnaire: "pnpm", sortie: "server", port: 3000 },
  { type: "build.image", source: { type: "local", path: PROJET }, tag: "skynode/boutique" },
  { type: "env.write", depuis: ".env.production" },
  { type: "app.run", port_interne: 3000, reseau: "skynode" },
  { type: "state.record" },
]

const etat = async () => {
  const r = await brut(
    "printf 'conteneurs: '; docker ps --format '{{.Names}}' | tr '\\n' ' '; echo; " +
      "printf 'images boutique: '; docker images skynode/boutique --format '{{.Tag}}' | tr '\\n' ' '; echo; " +
      "printf 'env: '; ls /etc/skynode/env 2>/dev/null | tr '\\n' ' '; echo; " +
      "printf 'state.d: '; ls /etc/skynode/state.d 2>/dev/null | tr '\\n' ' '; echo; " +
      "printf 'sites caddy: '; ls /etc/skynode/caddy/sites 2>/dev/null | tr '\\n' ' '; echo"
  )
  return r.stdout.trim()
}

console.error("=== 0. remise à zéro du banc ===")
await brut(
  "docker rm -f boutique skynode-caddy >/dev/null 2>&1; " +
    "docker rmi -f $(docker images skynode/boutique -q | sort -u) >/dev/null 2>&1; " +
    "rm -rf /etc/skynode /opt/skynode/work; echo remis"
)
console.error(await etat())

console.error("\n=== 1. plan complet ===")
const r1 = await executePlan(plan(COMPLET), RUNNER, CIBLE, CTX, { dryRun: false, transfer: TRANSFERT })
console.error(formatExecReport(r1, plan(COMPLET)))
const reponse = await brut(
  "docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'"
)
console.error(`\nl'application répond : ${JSON.stringify(reponse.stdout.trim())}`)

console.error("\n=== 2. réapplication ===")
const r2 = await executePlan(plan(COMPLET), RUNNER, CIBLE, CTX, { dryRun: false, transfer: TRANSFERT })
console.error(`outcome : ${r2.outcome} ; étapes : ${r2.steps.map((s) => s.outcome).join(", ")}`)
const reponse2 = await brut(
  "docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'"
)
console.error(`le service ne bronche pas : ${JSON.stringify(reponse2.stdout.trim())}`)

console.error("\n=== 2 bis. simulation : rien ne doit s'exécuter ===")
let sessions = 0
const espion = { run: async (c, s) => { sessions += 1; return RUNNER.run(c, s) } }
const r2b = await executePlan(plan(COMPLET), espion, CIBLE, CTX, { dryRun: true, transfer: TRANSFERT })
console.error(`sessions ouvertes : ${sessions} ; outcome : ${r2b.outcome}`)
console.error(formatExecReport(r2b, plan(COMPLET)).split("\n")[0])

console.error("\n=== 3. app.run échoue volontairement : le retour arrière ===")
await brut("docker rm -f boutique >/dev/null 2>&1; rm -rf /etc/skynode/env /etc/skynode/state.d /etc/skynode/caddy/sites; docker rmi -f $(docker images skynode/boutique -q|sort -u) >/dev/null 2>&1; echo pret")
console.error(`avant : ${await etat()}`)
// L'image de l'application est construite normalement, puis on la rend inutilisable :
// son point d'entrée sort aussitôt. `app.run` échoue alors pour la raison prévue par le
// produit — un conteneur mort dans les trois secondes — et non pour un artefact du banc.
const PIEGE = COMPLET.map((e) =>
  e.type === "build.generate_dockerfile" ? { ...e, port: 3000 } : e
)
const r3 = await executePlan(plan(PIEGE.slice(0, 3)), RUNNER, CIBLE, CTX, { dryRun: false, transfer: TRANSFERT })
console.error(`préparation (caddy + dockerfile + image) : ${r3.outcome}`)
await brut(
  "cd /opt/skynode/work/boutique && printf 'process.exit(1)\\n' > src/server.js && " +
    "rm -f /etc/skynode/.journal-construction-boutique; echo piege-pose"
)
const r3b = await executePlan(plan(PIEGE), RUNNER, CIBLE, CTX, { dryRun: false, transfer: null ? TRANSFERT : (async () => ({ ok: true, fichiers: 0, detail: "transfert neutralisé pour conserver le piège", diagnostic: "" })) })
console.error(formatExecReport(r3b, plan(PIEGE)))

console.error("\n=== 4. ce qui reste vraiment sur la machine ===")
console.error(await etat())
console.error(`\nrésidu annoncé : ${r3b.residue.length === 0 ? "(aucun)" : r3b.residue.join(" | ")}`)

console.error("\nbanc-execution.end\t1")
