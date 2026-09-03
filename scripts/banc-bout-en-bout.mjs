// Le scénario complet, depuis le catalogue d'outils MCP et non depuis les modules :
//
//   inspect_project → inspect_server → plan_deployment → apply_plan (dry_run)
//                                                      → apply_plan
//                                                      → app_logs
//                                                      → rollback
//
// C'est le seul passage qui éprouve la couture qui compte : `plan_deployment` compose un
// plan contre l'état RÉEL du banc, et `apply_plan` le revalide — empreinte comprise. Les
// pilotes précédents appelaient les modules directement et ne prouvaient rien de cela.
//
// Usage :
//   scripts/banc.sh up --with-docker
//   pnpm build
//   BANC_CLE="…/id_ed25519" node scripts/banc-bout-en-bout.mjs
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))
const { registerTools } = await import(join(RACINE, "dist", "tools.js"))
const { transferProject } = await import(join(RACINE, "dist", "transfer.js"))

const CLE = process.env.BANC_CLE
if (!CLE) throw new Error("BANC_CLE manque.")
const PORT = execFileSync("docker", ["port", "skynode-banc-docker", "22"], { encoding: "utf8" })
  .split("\n")[0].split(":").pop().trim()
const OPTIONS_SSH = [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR", "-o", "IdentitiesOnly=yes", "-i", CLE, "-p", PORT,
  // `resolveSshTarget` refuse une adresse de bouclage rendue par l'API — à raison : une API
  // qui annonce 127.0.0.1 enverrait le client se connecter à lui-même. L'instance simulée
  // déclare donc une adresse de TEST-NET, et c'est `Hostname` qui la ramène sur le banc.
  "-o", "Hostname=127.0.0.1",
]
const BAC = mkdtempSync(join(tmpdir(), "skynode-banc-e2e-"))
const SSH_ENROBE = join(BAC, "ssh")
writeFileSync(SSH_ENROBE, `#!/bin/sh\nexec ssh ${OPTIONS_SSH.map((o) => `'${o}'`).join(" ")} "$@"\n`)
chmodSync(SSH_ENROBE, 0o755)

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

// L'API SkyNode est simulée : le banc n'a pas de compte, et ce que ce scénario éprouve est
// la chaîne locale, pas le jalon 1. L'instance déclare 127.0.0.1 parce que c'est là que
// `resolveSshTarget` enverra le client `ssh` — l'enrobage ajoute le port du banc.
const instance = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  hostname: "banc", status: "RUNNING", ipv4: "192.0.2.10", ipv6: null,
  region: "EU", osImage: "ubuntu-24-04", planId: "9a1b2c3d-4e5f-6789-abcd-ef0123456789",
  cycle: "MONTHLY", defaultUser: "root", nextRenewalAt: "2026-12-01T00:00:00.000Z",
  provisionedAt: "2026-08-01T10:00:00.000Z", createdAt: "2026-08-01T09:00:00.000Z",
}
const api = { listInstances: async () => [instance], getInstance: async () => instance }
const ssh = { run: async (_cible, script) => brut(script) }
const transfer = (c, r, w, p) => transferProject(c, r, w, p, { sshBin: SSH_ENROBE })

const serveur = new McpServer({ name: "banc", version: "0.0.0" })
const outils = new Map()
const vrai = serveur.registerTool.bind(serveur)
serveur.registerTool = (nom, _config, handler) => {
  outils.set(nom, handler)
  return undefined
}
registerTools(serveur, api, ssh, { transfer })
serveur.registerTool = vrai

// L'arborescence porte son propre Dockerfile, et ce n'est pas un détail de commodité : sans
// Dockerfile, `detectPort` ne sait pas sur quel port l'application écoute — un projet sans
// framework connu n'en déclare aucun — et `plan_deployment` refuse plutôt que de deviner.
// Ce scénario éprouve donc aussi l'invariant n°2 de bout en bout : le Dockerfile du
// développeur est conservé, jamais remplacé. Le chemin du Dockerfile ENGENDRÉ est couvert
// par les pilotes des tâches 6 à 8.
const PROJET = join(RACINE, "fixtures", "node-avec-dockerfile")
const texte = (sortie) => sortie?.content?.[0]?.text ?? ""
const erreur = (sortie) => sortie?.isError === true

async function outil(nom, args, apercu = 4) {
  const sortie = await outils.get(nom)(args)
  const t = texte(sortie)
  console.error(`\n--- ${nom}${erreur(sortie) ? " [ERREUR]" : ""} ---`)
  console.error(t.split("\n").slice(0, apercu).join("\n"))
  return { sortie, t, erreur: erreur(sortie) }
}

console.error("=== 0. remise à zéro ===")
console.error(
  (await brut(
    "docker rm -f boutique vitrine tiers skynode-caddy >/dev/null 2>&1; " +
      "docker rmi -f $(docker images 'skynode/*' -q | sort -u) >/dev/null 2>&1; " +
      "docker volume rm skynode-caddy-data skynode-caddy-config >/dev/null 2>&1; " +
      "rm -rf /etc/skynode /opt/skynode; echo remis"
  )).stdout.trim()
)

await outil("list_servers", {}, 3)
await outil("inspect_project", { path: PROJET }, 5)
await outil("inspect_server", { server_id: instance.id }, 5)
const { t: planTexte } = await outil("plan_deployment", { server_id: instance.id, project_path: PROJET, application: "boutique" }, 12)

// Le plan que l'agent transmettrait : on le recompose par le même chemin que l'outil, ce
// que ferait un agent qui a lu le texte et rend l'objet.
const { analyzeProject } = await import(join(RACINE, "dist", "project-analyze.js"))
const { scanProject } = await import(join(RACINE, "dist", "project-scan.js"))
const { composePlan } = await import(join(RACINE, "dist", "plan-compose.js"))
const { parseProbe, PROBE_SCRIPT } = await import(join(RACINE, "dist", "probe.js"))
const { classify } = await import(join(RACINE, "dist", "regime.js"))

const constat = parseProbe((await brut(PROBE_SCRIPT)).stdout)
const compose = composePlan(instance, analyzeProject(await scanProject(PROJET)), constat, classify(constat), {
  application: "boutique",
})
if (!compose.ok) throw new Error(`plan refusé : ${compose.because}`)
const PLAN = compose.plan
console.error(`\nplan composé : ${PLAN.id}, ${PLAN.etapes.length} étapes, empreinte ${PLAN.empreinte_etat.slice(0, 20)}…`)
if (!planTexte.includes(PLAN.resume)) console.error("ATTENTION : le texte rendu ne correspond pas au plan recomposé")

console.error("\n=== 1. apply_plan en simulation ===")
let sessions = 0
const espion = { run: async (c, s) => { sessions += 1; return ssh.run(c, s) } }
const serveur2 = new McpServer({ name: "banc2", version: "0.0.0" })
const outils2 = new Map()
serveur2.registerTool = (nom, _c, h) => { outils2.set(nom, h); return undefined }
registerTools(serveur2, api, espion, { transfer })
const sim = await outils2.get("apply_plan")({ server_id: instance.id, project_path: PROJET, plan: PLAN, dry_run: true })
console.error(texte(sim).split("\n")[0])
console.error(`sessions ouvertes : ${sessions} (la sonde seule)`)

console.error("\n=== 2. apply_plan, pour de vrai ===")
const app = await outil("apply_plan", { server_id: instance.id, project_path: PROJET, plan: PLAN }, 30)
const reponse = await brut("docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'")
console.error(`\nl'application répond : ${JSON.stringify(reponse.stdout.trim())}`)

console.error("\n=== 3. app_logs ===")
await outil("app_logs", { server_id: instance.id, application: "boutique", lines: 5 }, 8)

console.error("\n=== 4. idempotence : tout rejouer ===")
const constat2 = parseProbe((await brut(PROBE_SCRIPT)).stdout)
const compose2 = composePlan(instance, analyzeProject(await scanProject(PROJET)), constat2, classify(constat2), {
  application: "boutique",
})
if (!compose2.ok) throw new Error(`second plan refusé : ${compose2.because}`)
const rejeu = await outil("apply_plan", { server_id: instance.id, project_path: PROJET, plan: compose2.plan }, 30)
const reponse2 = await brut("docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'")
console.error(`\nle service ne bronche pas : ${JSON.stringify(reponse2.stdout.trim())}`)
console.error(`régime après déploiement : ${classify(constat2).regime}`)

console.error("\n=== 5. une seconde version, puis rollback ===")
// Le dépôt du développeur n'est pas modifié : on en prend une copie, et c'est elle qu'on
// déploie en version 2. Un banc qui écrirait dans les fixtures du dépôt ferait dépendre son
// résultat de l'ordre dans lequel on le lance.
const COPIE = join(mkdtempSync(join(tmpdir(), "skynode-e2e-v2-")), "projet")
cpSync(PROJET, COPIE, { recursive: true })
const serveurJs = join(COPIE, "src", "server.js")
writeFileSync(serveurJs, readFileSync(serveurJs, "utf8").replace("boutique v1", "boutique v2"))

const constat3 = parseProbe((await brut(PROBE_SCRIPT)).stdout)
const compose3 = composePlan(instance, analyzeProject(await scanProject(COPIE)), constat3, classify(constat3), {
  application: "boutique",
})
if (!compose3.ok) throw new Error(`troisième plan refusé : ${compose3.because}`)
await outil("apply_plan", { server_id: instance.id, project_path: COPIE, plan: compose3.plan }, 10)
console.error(`\nversion 2 en ligne : ${JSON.stringify((await brut("docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'")).stdout.trim())}`)

await outil("rollback", { server_id: instance.id, application: "boutique" }, 4)
console.error(`\nétat final : ${(await brut("docker inspect -f '{{.Config.Image}} {{.State.Status}}' boutique 2>/dev/null || echo 'AUCUN CONTENEUR'")).stdout.trim()}`)
console.error(`après retour arrière : ${JSON.stringify((await brut("docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'")).stdout.trim())}`)

console.error("\n=== 6. un plan dont l'empreinte est fausse ===")
const faux = await outil(
  "apply_plan",
  { server_id: instance.id, project_path: PROJET, plan: { ...compose3.plan, empreinte_etat: `sha256:${"b".repeat(64)}` } },
  6
)
console.error(faux.erreur ? "refusé, comme attendu" : "ACCEPTÉ — ANOMALIE")

console.error("\n=== état final de la machine ===")
console.error((await brut(
  "printf 'conteneurs: '; docker ps --format '{{.Names}}' | tr '\\n' ' '; echo; " +
    "printf 'images: '; docker images 'skynode/*' --format '{{.Repository}}:{{.Tag}}' | tr '\\n' ' '; echo; " +
    "printf 'state.json: '; cat /etc/skynode/state.json 2>/dev/null | tr -d '\\n '; echo"
)).stdout.trim())

console.error("\nbanc-bout-en-bout.end\t1")
