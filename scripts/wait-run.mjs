// Waits for the GitHub Actions run of a pushed tag or branch and prints how it ended (there is no `gh` on the development PC).
//   node scripts/wait-run.mjs <tag or branch> [commit sha prefix]      e.g.  node scripts/wait-run.mjs android-v0.9.1
// Prints every job and any step that did not succeed; on failure also the compiler / Gradle messages that the workflow
// published as annotations. Exit code 0 = the run succeeded.
const REPO = 'CyttoRak-J/Oli'
const [ref, sha] = process.argv.slice(2)
if (!ref) {
  console.error('usage: node scripts/wait-run.mjs <tag or branch> [sha prefix]')
  process.exit(2)
}
const api = async (url) => {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'oli-release' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const deadline = Date.now() + 45 * 60_000
let run = null
while (Date.now() < deadline) {
  const runs = (await api(`https://api.github.com/repos/${REPO}/actions/runs?per_page=15`)).workflow_runs
  run = runs.find((r) => r.head_branch === ref && (!sha || r.head_sha.startsWith(sha))) ?? null
  if (run && run.status === 'completed') break
  process.stdout.write(run ? `  ${run.name}: ${run.status}...\n` : '  waiting for the run to appear...\n')
  await sleep(25_000)
}
if (!run || run.status !== 'completed') {
  console.log('not finished in time', run && run.html_url)
  process.exit(1)
}
console.log(`${run.name} (${ref}): ${run.conclusion}   ${run.html_url}`)
const jobs = (await api(run.jobs_url)).jobs
for (const j of jobs) {
  console.log(`  ${j.conclusion === 'success' ? 'ok  ' : (j.conclusion ?? '?').padEnd(4)} ${j.name}`)
  for (const s of j.steps) if (s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped') console.log(`        step "${s.name}": ${s.conclusion}`)
  if (j.conclusion === 'failure') {
    const ann = await api(`https://api.github.com/repos/${REPO}/check-runs/${j.id}/annotations`).catch(() => [])
    for (const a of ann.slice(0, 20)) console.log(`        ${a.annotation_level}: ${String(a.message).slice(0, 300)}`)
  }
}
process.exit(run.conclusion === 'success' ? 0 : 1)
