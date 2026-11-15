using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace AIQuota {
 internal static class Tests {
  static int count;
  static object Parse(string s) { return Json.Serializer().DeserializeObject(s); }
  static void Check(bool value, string label) { if (!value) throw new Exception("FAIL: " + label); Console.WriteLine("PASS " + (++count) + " " + label); }
  static string Limits = "{\"rateLimits\":{\"primary\":{\"usedPercent\":30,\"windowDurationMins\":10080,\"resetsAt\":2000000000},\"secondary\":null}}";
  class Fake : IQuotaRpc {
   internal List<string> Methods = new List<string>(); internal int Accounts, Disposals; internal bool Change, Error, Reorder;
   internal ManualResetEvent Entered = new ManualResetEvent(false), Release = new ManualResetEvent(true);
   public object Request(string method, object args, int timeout) {
    Methods.Add(method); if (method == "initialize") { Entered.Set(); Release.WaitOne(); }
    if (Error) throw new IOException("secret-provider-error");
    if (method == "account/read") { Accounts++; return Parse(Accounts > 1 && Change ? "{\"account\":{\"id\":\"other\"}}" : Accounts > 1 && Reorder ? "{\"account\":{\"plan\":\"pro\",\"id\":\"one\"}}" : "{\"account\":{\"id\":\"one\",\"plan\":\"pro\"}}"); }
    return method == "account/rateLimits/read" ? Parse(Limits) : Parse("{}");
   }
   public void Notify(string method, object args) { Methods.Add(method); }
   public void Dispose() { Disposals++; Release.Set(); }
  }
  public static int Main(string[] args) {
   if (args.Contains("--childwait")) { Thread.Sleep(30000); return 0; }
   // Separate synthetic stdio server. Never present in production build.
   if (args.Contains("app-server")) { Server(); return 0; }
   try {
    var now = new DateTimeOffset(2026,11,15,0,0,0,TimeSpan.Zero);
    var quotas = QuotaParser.Parse(Parse(Limits));
    Check(quotas.Count == 2 && quotas[0].Remaining == 70 && quotas[0].Label == "每周额度" && !quotas[1].Remaining.HasValue, "actual duration, snapshot-only null window remains unknown");
    var multi = QuotaParser.Parse(Parse("{\"rateLimitsByLimitId\":{\"a\":{\"primary\":{\"usedPercent\":100,\"windowDurationMins\":300}},\"b\":{\"secondary\":{\"usedPercent\":0,\"windowDurationMins\":10080}}},\"rateLimits\":{\"primary\":{\"usedPercent\":50}}}"));
    Check(multi.Count == 2 && multi[0].Remaining == 0 && multi[1].Remaining == 100 && multi[0].Key != multi[1].Key, "multiple pools are separate; 0 and 100 real endpoints");
    var invalid = QuotaParser.Parse(Parse("{\"rateLimits\":{\"primary\":{\"usedPercent\":\"0\",\"resetsAt\":1e30}}}"));
    Check(!invalid[0].Remaining.HasValue && !invalid[0].Reset.HasValue && invalid[0].Window.StartsWith("unknown"), "invalid numeric and reset fields remain unknown");
    Check(quotas[0].Fresh(now,now.AddSeconds(179)) && !quotas[0].Fresh(now,now.AddSeconds(180)) && !quotas[0].Fresh(now,now.AddSeconds(-1)), "three-minute expiry and backward clock");
    quotas[0].Reset=now; Check(!quotas[0].Fresh(now,now), "reset boundary invalidates old balance");
    int spawns=0; var f=new Fake { Reorder=true }; f.Release.Reset();
    using(var reader=new BalanceReader(()=>{spawns++;return f;},()=>now)) {
     var first=reader.Refresh(); f.Entered.WaitOne(); var second=reader.Refresh();
     Check(object.ReferenceEquals(first,second) && spawns==1,"concurrent calls share one probe"); f.Release.Set(); first.Wait();
     Check(reader.Current.Quotas[0].Remaining==70 && f.Disposals==1,"same account reordered fields succeeds and probe disposed");
     Check(string.Join(",",f.Methods)=="initialize,initialized,account/read,account/rateLimits/read,account/read","only allowed quota RPC sequence");
     reader.Refresh().Wait(); Check(spawns==1,"success throttle");
     now=now.AddSeconds(61); f.Accounts=0; f.Change=true; reader.Refresh().Wait();
     Check(reader.Current.Quotas.Count==0 && reader.Current.Error!="" && f.Disposals==2,"account switch clears prior balance");
     now=now.AddSeconds(61); f.Error=true; reader.Refresh().Wait();
     Check(reader.NextAllowed==now.AddSeconds(120) && !reader.Current.Error.Contains("secret"),"failure backoff and safe user error");
    }
    var closing=new Fake(); closing.Release.Reset(); var closedReader=new BalanceReader(()=>closing,()=>now); var pending=closedReader.Refresh(); closing.Entered.WaitOne(); closedReader.Dispose(); pending.Wait();
    Check(closedReader.Current.Quotas.Count==0 && closedReader.Refresh().IsCompleted,"exit during request never publishes late balance");
    string dir=Path.Combine(Path.GetTempPath(),"aiqw-native-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir); string file=Path.Combine(dir,"settings.json");
    try {
     File.WriteAllText(file,"null");var prefs=Settings.Load(file);Check(prefs.Pinned && prefs.Motion && Directory.GetFiles(dir,"*.damaged-*").Length==1,"null settings preserved and defaults restored");
     prefs.Scale=.7;prefs.Pinned=false;prefs.Motion=false;prefs.QuotaKey="a/primary";prefs.Left=15;prefs.Top=30;prefs.Save(file);
     var loaded=Settings.Load(file);Check(!loaded.Pinned && !loaded.Motion && loaded.Scale==.7 && loaded.QuotaKey=="a/primary" && loaded.Left==15,"settings persist without quota or account data");
     File.WriteAllText(file,"{broken");loaded=Settings.Load(file);Check(loaded.Scale==1 && Directory.GetFiles(dir,"*.damaged-*").Length==2,"malformed settings preserved");
    } finally { if (Path.GetDirectoryName(Path.GetFullPath(dir)).TrimEnd(Path.DirectorySeparatorChar) != Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) || !Path.GetFileName(dir).StartsWith("aiqw-native-")) throw new InvalidOperationException("unsafe-test-cleanup"); Directory.Delete(dir,true); }
    var ownExe=System.Reflection.Assembly.GetExecutingAssembly().Location;
    foreach(string mode in new[]{"normal","active","oversized","timeout","missing","exit","child"}) {
     Environment.SetEnvironmentVariable("AIQW_FIXTURE",mode);
     using(var rpc=new QuotaRpc(ownExe)) {
      int pid=rpc.ProcessId, childId=0; bool failed=false;
      try { var reply=rpc.Request("initialize",new{}, mode=="timeout"?150:2000); if(mode=="child") childId=Convert.ToInt32(Json.Get(reply,"child")); else Check(mode=="normal" && Json.Get(reply,"ok") is bool,"real stdio ignores wrong id, rejects server requests, drains stderr"); }
      catch(TimeoutException){failed=true;}catch(InvalidOperationException){failed=true;}
      if(mode!="normal" && mode!="child")Check(failed,"real stdio fails closed: "+mode);
      rpc.Dispose();bool gone=false;try { using(var p=Process.GetProcessById(pid))gone=p.HasExited; } catch(ArgumentException){gone=true;} Check(gone,"owned process stopped: "+mode);
      if(mode=="child") { bool childGone=false; try { using(var p=Process.GetProcessById(childId)) childGone=p.WaitForExit(2000); }catch(ArgumentException){childGone=true;} Check(childId>0 && childGone,"owned probe descendants killed by job, without touching other processes"); }
     }
    }
    Environment.SetEnvironmentVariable("AIQW_FIXTURE",null);
    Check(QuotaRpc.Arguments.Contains("features.hooks=false") && QuotaRpc.Arguments.Contains("read-only") && !QuotaRpc.Arguments.Contains("usage"),"probe flags preserve read-only boundary");
    Console.WriteLine("Native checks: "+count+" passed");return 0;
   } catch(Exception ex) { Console.Error.WriteLine(ex); return 1; }
  }
  static void Server() {
   string mode=Environment.GetEnvironmentVariable("AIQW_FIXTURE"); string line=Console.ReadLine(); var req=Json.Object(Parse(line));
   if(mode=="exit")return;
   if(mode=="timeout" || mode=="active") { Thread.Sleep(10000);return; }
   if(mode=="oversized") { Console.Write(new string('x',2097153)); Console.Out.Flush();Thread.Sleep(10000);return; }
   if(mode=="missing") { Console.WriteLine(Json.Serializer().Serialize(new{id=req["id"]}));Thread.Sleep(10000);return; }
   if(mode=="child") { var p=Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,"--childwait"){UseShellExecute=false,CreateNoWindow=true}); Console.WriteLine(Json.Serializer().Serialize(new{id=req["id"],result=new{child=p.Id}}));Thread.Sleep(10000);return; }
   Console.Error.Write(new string('e',100000));
   Console.WriteLine("{\"id\":99,\"result\":{}}");
   Console.WriteLine("{\"id\":\"server\",\"method\":\"approval\"}");
   var refusal=Json.Object(Parse(Console.ReadLine()));
   if(Json.Get(Json.Get(refusal,"error"),"code").ToString()!="-32601")return;
   Console.WriteLine(Json.Serializer().Serialize(new{id=req["id"],result=new{ok=true}})); Thread.Sleep(10000);
  }
 }
}
