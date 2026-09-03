// Banc d'essai des trois dernières étapes d'un déploiement : joue les cinq points de
// l'étape 4 de la tâche 7 contre un vrai conteneur portant Docker.
//
// Il suppose le banc monté avec Docker et une image applicative déjà construite — d'où
// l'enchaînement transfert + build.generate_dockerfile + build.image en préparation, le
// même que celui de scripts/banc-construction.mjs.
//
// Usage :
//   scripts/banc.sh up --with-docker
//   pnpm build
//   BANC_CLE="…/id_ed25519" node scripts/banc-application.mjs
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)))
const { transferProject } = await import(join(RACINE, "dist", "transfer.js"))
const { recipeFor } = await import(join(RACINE, "dist", "step.js"))

const NOM = "skynode-banc-docker"
const CLE = process.env.BANC_CLE
if (!CLE) {
  throw new Error(
    "BANC_CLE manque : le chemin de la clé jetable, que « scripts/banc.sh up » émet en banc.cle."
  )
}
const PORT = execFileSync("docker", ["port", NOM, "22"], { encoding: "utf8" })
  .split("\n")[0]
  .split(":")
  .pop()
  .trim()

const OPTIONS_SSH = [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
  "-o", "IdentitiesOnly=yes",
  "-i", CLE,
  "-p", PORT,
]

const BAC = mkdtempSync(join(tmpdir(), "skynode-banc-app-"))
const SSH_ENROBE = join(BAC, "ssh")
writeFileSync(SSH_ENROBE, `#!/bin/sh\nexec ssh ${OPTIONS_SSH.map((o) => `'${o}'`).join(" ")} "$@"\n`)
chmodSync(SSH_ENROBE, 0o755)

const CIBLE = { host: "127.0.0.1", user: "root" }

function ssh(script) {
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

const statut = (s) => {
  const l = s.split("\n").find((x) => x.startsWith("step.outcome\t"))
  return l ? l.slice("step.outcome\t".length) : "(aucun)"
}
const detail = (s) => {
  const l = s.split("\n").find((x) => x.startsWith("step.detail\t"))
  return l ? l.slice("step.detail\t".length) : ""
}

const PROJET = join(RACINE, "fixtures", "node-constructible")
const ctxDe = (app) => ({ application: app, projectRoot: PROJET, workDir: `/opt/skynode/work/${app}` })
const GEN = { type: "build_gen" }
const ETAPE_GEN = {
  type: "build.generate_dockerfile",
  famille: "node",
  version: "22",
  gestionnaire: "pnpm",
  sortie: "server",
  port: 3000,
}
const ETAPE_IMG = { type: "build.image", source: { type: "local", path: PROJET }, tag: "boutique" }
const ETAPE_ENV = { type: "env.write", depuis: ".env.production" }
const ETAPE_RUN = { type: "app.run", port_interne: 3000, reseau: "skynode" }
const ETAPE_ETAT = { type: "state.record" }

async function joue(nom, type, etape, ctx) {
  const r = await ssh(recipeFor(type).script(etape, ctx))
  console.error(`${nom} → ${statut(r.stdout)} : ${detail(r.stdout)}`)
  if (statut(r.stdout) === "failed") console.error(r.stderr.slice(-1500))
  return statut(r.stdout)
}

async function prepare(app) {
  const ctx = ctxDe(app)
  const t = await transferProject(CIBLE, PROJET, ctx.workDir, null, { sshBin: SSH_ENROBE })
  if (!t.ok) throw new Error(`transfert ${app} : ${t.detail}\n${t.diagnostic}`)
  await joue(`[${app}] generate_dockerfile`, "build.generate_dockerfile", ETAPE_GEN, ctx)
  await joue(`[${app}] build.image`, "build.image", ETAPE_IMG, ctx)
  return ctx
}

console.error("=== préparation : transfert et construction de « boutique » ===")
const ctxBoutique = await prepare("boutique")

console.error("\n=== 1. env.write : 0600, propriétaire, et rien qui fuit ===")
await joue("env.write", "env.write", ETAPE_ENV, ctxBoutique)
const modes = await ssh("stat -c '%a %U:%G %n' /etc/skynode/env /etc/skynode/env/boutique.env")
console.error(modes.stdout.trim())
const fuite = await ssh(
  "grep -rl 'VALEUR_FICTIVE_C' /etc/skynode/env/boutique.env >/dev/null 2>&1 && echo 'contenu présent (attendu)' || echo 'contenu ABSENT (anormal)'"
)
console.error(fuite.stdout.trim())
console.error(`rejeu : ${await joue("env.write (rejeu)", "env.write", ETAPE_ENV, ctxBoutique)}`)

console.error("\n=== 2. app.run : le conteneur tourne et répond depuis le réseau interne ===")
await joue("app.run", "app.run", ETAPE_RUN, ctxBoutique)
const etat = await ssh(
  "docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{.Config.Labels}} {{.NetworkSettings.Ports}}' boutique"
)
console.error(etat.stdout.trim())
const reponse = await ssh(
  "docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'"
)
console.error(`réponse depuis le réseau interne : ${JSON.stringify(reponse.stdout.trim())}`)

console.error("\n=== 3. rejeu de app.run ===")
await joue("app.run (rejeu)", "app.run", ETAPE_RUN, ctxBoutique)
const reponse2 = await ssh(
  "docker run --rm --network skynode curlimages/curl:8.11.1 -s -m 10 http://boutique:3000/ || echo 'PAS DE REPONSE'"
)
console.error(`le service répond toujours : ${JSON.stringify(reponse2.stdout.trim())}`)

console.error("\n=== 4. un conteneur tiers du même nom n'est PAS touché ===")
// La préparation d'abord : sans arborescence ni image, l'étape échouerait sur ce prérequis
// et la garde de propriété — la seule chose que ce point éprouve — ne serait jamais atteinte.
const ctxTiers = await prepare("tiers")
await ssh("docker rm -f tiers >/dev/null 2>&1; docker run -d --name tiers busybox:latest sleep 3600 >/dev/null")
const avant = await ssh("docker inspect -f '{{.Id}}' tiers")
const r4 = await ssh(recipeFor("app.run").script(ETAPE_RUN, ctxTiers))
console.error(`app.run sur « tiers » → ${statut(r4.stdout)} : ${detail(r4.stdout)}`)
const apres = await ssh("docker inspect -f '{{.Id}} {{.State.Running}} {{.Config.Image}}' tiers")
console.error(`identifiant avant : ${avant.stdout.trim()}`)
console.error(`identifiant après : ${apres.stdout.trim()}`)
console.error(
  avant.stdout.trim() === apres.stdout.trim().split(" ")[0]
    ? "le conteneur tiers est intact"
    : "LE CONTENEUR TIERS A ÉTÉ REMPLACÉ"
)
// Et l'annulation non plus ne doit pas y toucher : elle joue après un échec, donc sur une
// machine dont on sait déjà qu'elle n'est pas dans l'état prévu.
const u4 = await ssh(recipeFor("app.run").undoScript(ETAPE_RUN, ctxTiers))
console.error(`undo app.run sur « tiers » → ${statut(u4.stdout)} : ${detail(u4.stdout)}`)
const apres4 = await ssh("docker inspect -f '{{.Id}}' tiers")
console.error(
  avant.stdout.trim() === apres4.stdout.trim()
    ? "le conteneur tiers survit aussi à l'annulation"
    : "L'ANNULATION A RETIRÉ LE CONTENEUR TIERS"
)
await ssh("docker rm -f tiers >/dev/null 2>&1; rm -rf /opt/skynode/work/tiers")

console.error("\n=== 5. state.record : la seconde application n'efface pas la première ===")
await joue("state.record (boutique)", "state.record", ETAPE_ETAT, ctxBoutique)
console.error((await ssh("cat /etc/skynode/state.json")).stdout)

const ctxVitrine = await prepare("vitrine")
await joue("env.write (vitrine)", "env.write", ETAPE_ENV, ctxVitrine)
await joue("app.run (vitrine)", "app.run", { ...ETAPE_RUN, port_interne: 3000 }, ctxVitrine)
await joue("state.record (vitrine)", "state.record", ETAPE_ETAT, ctxVitrine)
const final = await ssh("cat /etc/skynode/state.json; echo '--- modes ---'; stat -c '%a %U:%G %n' /etc/skynode/state.json /etc/skynode/state.d")
console.error(final.stdout)

console.error("=== annulation de state.record sur vitrine : boutique doit survivre ===")
const u = await ssh(recipeFor("state.record").undoScript(ETAPE_ETAT, ctxVitrine))
console.error(`undo → ${statut(u.stdout)} : ${detail(u.stdout)}`)
console.error((await ssh("cat /etc/skynode/state.json")).stdout)

// L'état doit être du JSON valide, pas seulement un texte qui y ressemble : c'est ce que
// la sonde renvoie et ce sur quoi `rollback` s'appuiera.
const brut = (await ssh("cat /etc/skynode/state.json")).stdout
try {
  const objet = JSON.parse(brut)
  console.error(`state.json analysé : ${objet.apps.length} application(s), version ${objet.version}`)
} catch (e) {
  console.error(`STATE.JSON N'EST PAS DU JSON VALIDE : ${e.message}`)
}

console.error("banc-application.end\t1")
