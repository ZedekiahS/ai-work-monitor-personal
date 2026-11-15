// Build-time Node only, reusing the repository's build orchestration pattern.
// No JS engine, Node executable or npm package enters the native distribution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const output = path.join(root, 'release/quota-native/0.2.0-native.1');
const stage = path.join(output, 'app');
const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
const refs = ['System.dll','System.Core.dll','System.Web.Extensions.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Xaml.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll'].map(x=>'/r:'+path.join(framework,x));
const common = ['Quota.cs','QuotaRpc.cs','Settings.cs'].map(x=>path.join(source,x));
const run = (exe,args) => { const r=spawnSync(exe,args,{stdio:'inherit',shell:false}); if(r.error) throw r.error; if(r.status!==0) throw Error('Build/check failed: '+r.status); };
fs.mkdirSync(stage,{recursive:true});
run(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/out:'+path.join(stage,'AIQuotaWindow.exe'),'/win32icon:'+path.join(root,'desktop/assets/icon.ico'),'/win32manifest:'+path.join(source,'app.manifest'),'/resource:'+path.join(source,'Window.xaml')+',Window.xaml',...refs,...common,path.join(source,'App.cs')]);
for(const [from,to] of [['desktop/assets/icon.ico','icon.ico'],['LICENSE','LICENSE'],['third_party/codex-usage-desktop-LICENSE','licenses/codex-usage-desktop-LICENSE'],...['THIRD_PARTY_NOTICES.md','README.md','AIQuotaWindow.exe.config'].map(x=>['apps/quota-native/'+x,x]),['apps/quota-native/codex-quota-orb-LICENSE','licenses/codex-quota-orb-LICENSE']]) { const dest=path.join(stage,to); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,from),dest); }
const hashFile=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sourceFiles=fs.readdirSync(source).filter(x=>fs.statSync(path.join(source,x)).isFile()).sort();
const git=(...args)=>spawnSync('git',args,{cwd:root,encoding:'utf8',shell:false}).stdout.trim();
fs.writeFileSync(path.join(stage,'SOURCE_INVENTORY.json'),JSON.stringify({version:'0.2.0-native.1',baseCommit:git('rev-parse','HEAD'),workingTreeChanges:git('status','--porcelain','--','apps/quota-native')!=='',sourceFiles:sourceFiles.map(file=>({file:'apps/quota-native/'+file,sha256:hashFile(path.join(source,file))})),binarySha256:hashFile(path.join(stage,'AIQuotaWindow.exe'))},null,2)+'\n');
if(process.argv.includes('--test')) {
 const dir=path.join(root,'work/quota-native-tests');fs.mkdirSync(dir,{recursive:true});
 run(compiler,['/nologo','/target:exe','/platform:x64','/utf8output','/out:'+path.join(dir,'NativeTests.exe'),...refs,...common,path.join(source,'Tests.cs')]);
 run(path.join(dir,'NativeTests.exe'),[]);
}
if(process.argv.includes('--package')) {
 const index=process.argv.indexOf('--makensis'); if(index<0 || !process.argv[index+1]) throw Error('Provide --makensis <path>');
 run(path.resolve(process.argv[index+1]),['/INPUTCHARSET','UTF8','/OUTPUTCHARSET','UTF8','/DSTAGE='+stage,'/DOUTPUT='+output,path.join(source,'installer.nsi')]);
 const exe=path.join(output,'AI.Quota.Window.Native.Setup.0.2.0-native.1.exe');
 const sum=createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
 fs.writeFileSync(path.join(output,'SHA256SUMS.txt'),sum+'  '+path.basename(exe)+'\n');
 console.log(JSON.stringify({installer:exe,bytes:fs.statSync(exe).size,sha256:sum}));
}
