$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json

function Result($ok, $verified, $code, $message) {
  return @{ ok = $ok; verified = $verified; code = $code; message = $message }
}

function AppKey($kind, $target) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($kind + ':' + $target).ToLowerInvariant())))).Replace('-', '') } finally { $hash.Dispose() }
}

function Get-AppCatalog {
  $items = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  function Add-App($name, $kind, $target, $aliases) {
    if (-not $name -or -not $target) { return }
    $key = AppKey $kind $target
    if ($seen.ContainsKey($key)) { return }; $seen[$key] = $true
    $items.Add(@{ key=$key; name=[string]$name; kind=$kind; target=[string]$target; aliases=@($aliases) })
  }
  foreach ($item in @(Get-StartApps -ErrorAction SilentlyContinue)) {
    $aliases = @()
    if ($item.AppID -like 'OpenAI.Codex_*!App') { $aliases = @('Codex') }; $name = $item.Name
    if ($item.AppID -match '^steam://rungameid/(\d+)$') { Add-App $name 'steam' $Matches[1] $aliases }
    else { Add-App $name 'startapp' $item.AppID $aliases }
  }
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base=$null; $root=$null
      try {
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
        $root=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths')
        if ($root) { foreach ($sub in $root.GetSubKeyNames()) {
          $entry=$root.OpenSubKey($sub)
          try { $target=[Environment]::ExpandEnvironmentVariables(([string]$entry.GetValue('')).Trim('"')); if ($target -match '\.exe$' -and (Test-Path -LiteralPath $target -PathType Leaf)) { Add-App ([IO.Path]::GetFileNameWithoutExtension($sub)) 'exe' $target @() } } finally { if($entry){$entry.Dispose()} }
        } }
      } catch {} finally { if($root){$root.Dispose()}; if($base){$base.Dispose()} }
    }
  }
  $steam=Get-SteamExe
  if($steam){
    Add-App 'Steam' 'exe' $steam @('Steam')
    $libraries=New-Object System.Collections.Generic.List[string];$libraries.Add([IO.Path]::GetDirectoryName($steam))
    $folders=Join-Path ([IO.Path]::GetDirectoryName($steam)) 'steamapps\libraryfolders.vdf'
    if(Test-Path -LiteralPath $folders){try{$text=[IO.File]::ReadAllText($folders);foreach($match in [regex]::Matches($text,'"path"\s+"([^"]+)"')){$libraries.Add($match.Groups[1].Value.Replace('\\','\'))}}catch{}}
    foreach($library in @($libraries | Select-Object -Unique)){
      $steamapps=Join-Path $library 'steamapps'
      foreach($manifest in @(Get-ChildItem -LiteralPath $steamapps -Filter 'appmanifest_*.acf' -File -ErrorAction SilentlyContinue)){
        try{if($manifest.Length -gt 200000){continue};$text=[IO.File]::ReadAllText($manifest.FullName);$app=[regex]::Match($text,'"appid"\s+"(\d+)"');$name=[regex]::Match($text,'"name"\s+"([^"]+)"');if($app.Success -and $name.Success){Add-App $name.Groups[1].Value 'steam' $app.Groups[1].Value @()}}catch{}
      }
    }
  }
  return @($items.ToArray())
}

function Load-WindowsApi {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace SynapsesNative {
 public class WindowInfo { public string hwnd; public int pid; public string started; public string title; public string app; public bool foreground; public bool minimized; public object bounds; }
 public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk,wScan;public uint dwFlags,time;public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)]public MOUSEINPUT mi;[FieldOffset(0)]public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type;public UNION U; }
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc cb,IntPtr p);
  [DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")]public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
  [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int command);
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")]static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetApplicationUserModelId(IntPtr h,ref uint length,StringBuilder value);
  public static void PhysicalDpi(){try{SetThreadDpiAwarenessContext(new IntPtr(-4));}catch{}}
  public static WindowInfo Info(IntPtr h){
   uint pid;GetWindowThreadProcessId(h,out pid);if(!IsWindow(h)||pid==0)return null;
   try{var p=Process.GetProcessById((int)pid);var s=new StringBuilder(2048);GetWindowText(h,s,s.Capacity);RECT r;if(!GetWindowRect(h,out r))return null;
    return new WindowInfo{hwnd=h.ToInt64().ToString(),pid=(int)pid,started=p.StartTime.ToUniversalTime().Ticks.ToString(),title=s.ToString(),app=p.ProcessName,foreground=GetForegroundWindow()==h,minimized=IsIconic(h),bounds=new {x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top}};
   }catch{return null;}
  }
  public static WindowInfo[] Windows(){var list=new List<WindowInfo>();EnumWindows((h,p)=>{if(IsWindowVisible(h)){var v=Info(h);if(v!=null&&!String.IsNullOrWhiteSpace(v.title))list.Add(v);}return true;},IntPtr.Zero);return list.ToArray();}
  public static bool Focus(IntPtr h){if(IsIconic(h))ShowWindow(h,9);if(GetForegroundWindow()==h)return true;SetForegroundWindow(h);System.Threading.Thread.Sleep(100);return GetForegroundWindow()==h;}
  static INPUT KeyInput(ushort vk,ushort scan,uint flags){var i=new INPUT();i.type=1;i.U.ki=new KEYBDINPUT{wVk=vk,wScan=scan,dwFlags=flags};return i;}
  public static bool Key(ushort vk,bool ctrl,bool shift){var a=new List<INPUT>();if(ctrl)a.Add(KeyInput(17,0,0));if(shift)a.Add(KeyInput(16,0,0));a.Add(KeyInput(vk,0,0));a.Add(KeyInput(vk,0,2));if(shift)a.Add(KeyInput(16,0,2));if(ctrl)a.Add(KeyInput(17,0,2));return SendInput((uint)a.Count,a.ToArray(),Marshal.SizeOf(typeof(INPUT)))==a.Count;}
  public static bool Text(string text){var a=new List<INPUT>();foreach(char c in text){a.Add(KeyInput(0,c,4));a.Add(KeyInput(0,c,6));}return SendInput((uint)a.Count,a.ToArray(),Marshal.SizeOf(typeof(INPUT)))==a.Count;}
  public static bool Click(IntPtr h,int x,int y){if(!Focus(h)||GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=h)return false;if(!SetCursorPos(x,y))return false;var a=new INPUT[2];a[0].type=0;a[0].U.mi.dwFlags=2;a[1].type=0;a[1].U.mi.dwFlags=4;return SendInput(2,a,Marshal.SizeOf(typeof(INPUT)))==2;}
  public static bool AppRunning(string id){foreach(var p in Process.GetProcesses()){IntPtr h=IntPtr.Zero;try{h=OpenProcess(0x1000,false,(uint)p.Id);if(h==IntPtr.Zero)continue;uint n=0;GetApplicationUserModelId(h,ref n,null);if(n==0||n>4096)continue;var b=new StringBuilder((int)n);if(GetApplicationUserModelId(h,ref n,b)==0&&String.Equals(id,b.ToString(),StringComparison.OrdinalIgnoreCase))return true;}catch{}finally{if(h!=IntPtr.Zero)CloseHandle(h);p.Dispose();}}return false;}
 }
}
'@ | Out-Null
  [SynapsesNative.Win]::PhysicalDpi()
}

function Get-Target($expected) {
  if (-not $expected -or [string]$expected.hwnd -notmatch '^\d+$') { throw 'invalid_window' }
  $handle = [IntPtr]::new([long]$expected.hwnd)
  $info = [SynapsesNative.Win]::Info($handle)
  if (-not $info -or $info.pid -ne [int]$expected.pid -or $info.started -ne [string]$expected.started) { throw 'stale_window' }
  if ($info.app -match '^(Synapses|powershell|pwsh|cmd|WindowsTerminal|regedit|mmc|consent|CredentialUIBroker|runas)$' -or $info.title -match '^(Run|Windows Security|User Account Control)$') { throw 'unsupported_window' }
  if ($request.op -in @('click','type','key') -and $info.title -match '\bdoor\s*dash\b') { throw 'door_dash_review_required' }
  return @{ handle=$handle; info=$info }
}

function Get-WindowRoot($target) { return [System.Windows.Automation.AutomationElement]::FromHandle($target.handle) }
function Get-WindowGeneration($target) {
  $root=Get-WindowRoot $target;$doc=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)))
  $id=if($doc){@($doc.GetRuntimeId()) -join ','}else{@($root.GetRuntimeId()) -join ','}
  return AppKey 'window-generation' ($id+':'+[string]$root.Current.Name)
}
function Get-VisibleControls($root) {
  $list = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue($root); $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker; $visited=0; $text=0
  while ($queue.Count -gt 0 -and $list.Count -lt 150 -and $visited -lt 1200) {
    $node=$queue.Dequeue(); $visited++
    try {
      $current=$node.Current
      if (-not $current.IsOffscreen -and $current.BoundingRectangle.Width -gt 0 -and $current.BoundingRectangle.Height -gt 0) {
        $password=$current.IsPassword; $name=if($password){''}else{[string]$current.Name};$nameHash=AppKey 'control-name' $name
        $risky=$name -match '\b(buy|purchase|pay|payment|checkout|order|delete|remove|send|submit|publish|install|uninstall|transfer|password|credential|security|confirm)\b'
        $limit=[Math]::Max(0,[Math]::Min(300,6000-$text)); if($name.Length -gt $limit){$name=$name.Substring(0,$limit)}; $text+=$name.Length
        $r=$current.BoundingRectangle
        $list.Add(@{ runtimeId=@($node.GetRuntimeId());name=$name;nameHash=$nameHash;risky=$risky;type=$current.ControlType.ProgrammaticName;password=$password;enabled=$current.IsEnabled;bounds=@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height} })
      }
      $child=$walker.GetFirstChild($node); while($child -and $queue.Count -lt 1200){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
    } catch {}
  }
  return @{controls=@($list.ToArray());truncated=($queue.Count -gt 0)}
}

function Get-ObservedControl($target,$expected) {
  if([string]$request.windowGeneration -cne (Get-WindowGeneration $target)){throw 'stale_window_snapshot'}
  $root=Get-WindowRoot $target
  $all=$root.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
  for($i=0;$i -lt [Math]::Min($all.Count,5000);$i++) {
    $node=$all.Item($i)
    try {
      if ((@($node.GetRuntimeId()) -join ',') -ne (@($expected.runtimeId) -join ',')) { continue }
      $c=$node.Current; $r=$c.BoundingRectangle
      if($c.IsPassword -or $c.IsOffscreen -or -not $c.IsEnabled -or $c.ControlType.ProgrammaticName -ne $expected.type -or (AppKey 'control-name' ([string]$c.Name)) -cne [string]$expected.nameHash){throw 'stale_control'}
      foreach($key in @('x','y','width','height')) { $actual=switch($key){x{$r.X};y{$r.Y};width{$r.Width};height{$r.Height}};if([Math]::Abs([double]$expected.bounds.$key-$actual) -gt 3){throw 'stale_control'} }
      return $node
    } catch { if($_.Exception.Message -eq 'stale_control'){throw} }
  }
  throw 'stale_control'
}

function Invoke-Control($target,$node) {
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return 'delivered'}
  if($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$pattern.Select();return $pattern.Current.IsSelected}
  if($node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$before=$pattern.Current.ToggleState;$pattern.Toggle();return $pattern.Current.ToggleState -ne $before}
  $r=$node.Current.BoundingRectangle
  if($node.Current.ControlType -in @([System.Windows.Automation.ControlType]::Window,[System.Windows.Automation.ControlType]::Pane,[System.Windows.Automation.ControlType]::Document)){return $false}
  $point=New-Object Windows.Point(($r.X+$r.Width/2),($r.Y+$r.Height/2));$hit=[System.Windows.Automation.AutomationElement]::FromPoint($point);$matches=$false;$expectedId=@($node.GetRuntimeId()) -join ','
  for($depth=0;$hit -and $depth -lt 64;$depth++){if((@($hit.GetRuntimeId()) -join ',') -eq $expectedId){$matches=$true;break};$hit=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($hit)}
  if(-not $matches){return $false}
  if([SynapsesNative.Win]::Click($target.handle,[int]$point.X,[int]$point.Y)){return 'delivered'};return $false
}

function Get-UiState($target) {
  $snapshot=Get-VisibleControls (Get-WindowRoot $target)
  $shape=@($snapshot.controls | ForEach-Object {$_.nameHash+':'+$_.type+':'+(@($_.runtimeId)-join ',')}) -join '|'
  $focus=[System.Windows.Automation.AutomationElement]::FocusedElement;$focusId='';$value='';$inside=$false;$parent=$focus;$rootId=@((Get-WindowRoot $target).GetRuntimeId()) -join ','
  for($depth=0;$parent -and $depth -lt 64;$depth++){if((@($parent.GetRuntimeId()) -join ',') -eq $rootId){$inside=$true;break};$parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)}
  if($focus -and $inside){$focusId=@($focus.GetRuntimeId()) -join ',';if(-not $focus.Current.IsPassword){$pattern=$null;if($focus.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$value=AppKey 'value' ([string]$pattern.Current.Value)}}}
  return AppKey 'ui-state' ($shape+':'+$focusId+':'+$value)
}

function Wait-UiChange($target,$before) {
  for($attempt=0;$attempt -lt 8;$attempt++){Start-Sleep -Milliseconds 100;$null=Get-Target $request.window;if((Get-UiState $target) -cne $before){return $true}}
  return $false
}

function Set-ControlText($target,$node,$value) {
  if($node.Current.IsPassword){throw 'password_unsupported'}
  $pattern=$null
  if($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
    if($pattern.Current.IsReadOnly){return $false};$pattern.SetValue($value);return $pattern.Current.Value -ceq $value
  }
  $textPattern=$null
  if(-not $node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$textPattern)){return $false}
  if(-not [SynapsesNative.Win]::Focus($target.handle)){return $false};$node.SetFocus()
  if((@([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId()) -join ',') -ne (@($node.GetRuntimeId()) -join ',')){return $false}
  if(-not [SynapsesNative.Win]::Key(65,$true,$false) -or -not [SynapsesNative.Win]::Text($value)){return $false}
  Start-Sleep -Milliseconds 100
  return $textPattern.DocumentRange.GetText(6001).TrimEnd("`r","`n") -ceq $value
}

function Get-SteamExe {
  foreach($registry in @('HKLM:\SOFTWARE\WOW6432Node\Valve\Steam','HKLM:\SOFTWARE\Valve\Steam','HKCU:\Software\Valve\Steam')) {
    try{$data=Get-ItemProperty -LiteralPath $registry -ErrorAction Stop;foreach($candidate in @($data.SteamExe, $(if($data.InstallPath){Join-Path $data.InstallPath 'steam.exe'}),$(if($data.SteamPath){Join-Path $data.SteamPath 'steam.exe'}))){if($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)){return [string]$candidate}}}catch{}
  }
  return $null
}

function Start-ObservedApp($entry) {
  $processName=if($entry.kind -eq 'exe'){[IO.Path]::GetFileNameWithoutExtension($entry.target)}elseif($entry.kind -eq 'steam' -and $entry.target -eq '570'){'dota2'}elseif($entry.target -like 'OpenAI.Codex_*!App'){'Codex'}elseif($entry.name -eq 'Steam'){'steam'}else{''}
  if($entry.kind -eq 'exe'){Start-Process -FilePath $entry.target | Out-Null}
  elseif($entry.kind -eq 'steam'){$steam=Get-SteamExe;if(-not $steam -or $entry.target -notmatch '^\d+$'){return Result $false $false 'app_unavailable' 'Steam could not be found.'};Start-Process -FilePath $steam -ArgumentList @('-applaunch',[string]$entry.target) | Out-Null}
  else{Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList @('shell:AppsFolder\'+[string]$entry.target) | Out-Null}
  for($attempt=0;$attempt -lt 24;$attempt++) {
    if($entry.kind -eq 'startapp' -and $entry.target -like '*!*' -and [SynapsesNative.Win]::AppRunning($entry.target)){return Result $true $true 'app_identity_observed' 'The selected app identity is running.'}
    if($processName -and @(Get-Process -Name $processName -ErrorAction SilentlyContinue).Count -gt 0){return Result $true $true 'app_running' 'The selected app is running.'}
    $match=@([SynapsesNative.Win]::Windows() | Where-Object {$_.title.IndexOf($entry.name,[StringComparison]::OrdinalIgnoreCase) -ge 0})
    if($match.Count -gt 0){return Result $true $true 'window_observed' 'The selected app has a visible window.'}
    Start-Sleep -Milliseconds 250
  }
  return Result $false $false 'launch_unconfirmed' 'Launch was requested, but a matching process or window was not confirmed.'
}

try {
  switch ([string]$request.op) {
    'selftest' { Load-WindowsApi;$size=[Runtime.InteropServices.Marshal]::SizeOf([type][SynapsesNative.Win+INPUT]);$result=@{ok=($size -eq 40);driverReady=($size -eq 40);inputSize=$size;architecture=([IntPtr]::Size*8);uiaLoaded=([bool]('System.Windows.Automation.AutomationElement' -as [type]))} }
    'catalog' { $result=@{ok=$true;apps=@(Get-AppCatalog)} }
    'windows' { Load-WindowsApi;$result=@{ok=$true;windows=@([SynapsesNative.Win]::Windows() | Where-Object {$_.pid -ne $request.excludePid -and $_.app -ine 'Synapses'})} }
    'launch' { $entry=@(Get-AppCatalog | Where-Object {$_.key -ceq [string]$request.appKey}) | Select-Object -First 1;if(-not $entry){$result=Result $false $false 'stale_app' 'Refresh the installed app catalog first.'}else{Load-WindowsApi;$result=Start-ObservedApp $entry} }
    'move' {
      Load-WindowsApi;$target=Get-Target $request.window;$a=$request.area
      if($a.width -lt 100 -or $a.height -lt 100){throw 'invalid_bounds'}
      $wasMaximized=[SynapsesNative.Win]::IsZoomed($target.handle)
      [SynapsesNative.Win]::ShowWindow($target.handle,9) | Out-Null
      $rect=New-Object SynapsesNative.Win+RECT;[SynapsesNative.Win]::GetWindowRect($target.handle,[ref]$rect) | Out-Null
      $width=[Math]::Min($rect.Right-$rect.Left,[int]$a.width);$height=[Math]::Min($rect.Bottom-$rect.Top,[int]$a.height)
      $x=[int]$a.x+[int](($a.width-$width)/2);$y=[int]$a.y+[int](($a.height-$height)/2)
      $sent=[SynapsesNative.Win]::SetWindowPos($target.handle,[IntPtr]::Zero,$x,$y,$width,$height,0x14)
      if($wasMaximized){[SynapsesNative.Win]::ShowWindow($target.handle,3) | Out-Null}
      Start-Sleep -Milliseconds 120;$after=Get-Target $request.window;$r=New-Object SynapsesNative.Win+RECT;[SynapsesNative.Win]::GetWindowRect($target.handle,[ref]$r) | Out-Null
      if($wasMaximized){$cx=($r.Left+$r.Right)/2;$cy=($r.Top+$r.Bottom)/2;$verified=$sent -and [SynapsesNative.Win]::IsZoomed($target.handle) -and $cx -ge $a.x -and $cx -lt ($a.x+$a.width) -and $cy -ge $a.y -and $cy -lt ($a.y+$a.height)}else{$verified=$sent -and [Math]::Abs($r.Left-$x) -le 3 -and [Math]::Abs($r.Top-$y) -le 3 -and [Math]::Abs(($r.Right-$r.Left)-$width) -le 3 -and [Math]::Abs(($r.Bottom-$r.Top)-$height) -le 3}
      $result=Result $verified $verified 'window_move' $(if($verified){'The window was moved to the selected display.'}else{'Windows did not confirm the requested move.'})
    }
    'read' { Load-WindowsApi;$target=Get-Target $request.window;$snapshot=Get-VisibleControls (Get-WindowRoot $target);$result=@{ok=$true;controls=$snapshot.controls;truncated=$snapshot.truncated;windowGeneration=(Get-WindowGeneration $target)} }
    'click' { Load-WindowsApi;$target=Get-Target $request.window;$node=Get-ObservedControl $target $request.control;$before=Get-UiState $target;$delivery=Invoke-Control $target $node;$verified=($delivery -eq $true) -or ($delivery -eq 'delivered' -and (Wait-UiChange $target $before));$result=Result $verified $verified 'control_readback' $(if($verified){'The observed control changed the app state. Read the window to verify the resulting page.'}else{'No resulting UI change was confirmed. The action may have been delivered; do not repeat it blindly.'}) }
    'type' { Load-WindowsApi;$target=Get-Target $request.window;$node=Get-ObservedControl $target $request.control;$verified=Set-ControlText $target $node ([string]$request.text);$result=Result $verified $verified 'text_readback' $(if($verified){'The field contains the requested text.'}else{'The field did not provide a matching text readback.'}) }
    'key' {
      Load-WindowsApi;$target=Get-Target $request.window
      $keys=@{ENTER=13;ESCAPE=27;TAB=9;SHIFT_TAB=9;SPACE=32;ARROW_UP=38;ARROW_DOWN=40;ARROW_LEFT=37;ARROW_RIGHT=39;HOME=36;END=35;PAGE_UP=33;PAGE_DOWN=34;CTRL_L=76;CTRL_A=65;CTRL_F=70;BACKSPACE=8;DELETE=46}
      if(-not $keys.ContainsKey([string]$request.key)){throw 'unsupported_key'}
      $focused=[SynapsesNative.Win]::Focus($target.handle);$before=Get-UiState $target;$sent=$focused -and [SynapsesNative.Win]::Key($keys[[string]$request.key],([string]$request.key).StartsWith('CTRL_'),$request.key -eq 'SHIFT_TAB');$verified=$sent -and (Wait-UiChange $target $before)
      $result=Result $verified $verified 'key_readback' $(if($verified){'The key produced an observed UI change.'}else{'No resulting UI change was confirmed. The key may have been delivered; do not repeat it blindly.'})
    }
    'scroll' {
      Load-WindowsApi;$target=Get-Target $request.window;$root=Get-WindowRoot $target
      $element=$root.FindFirst([System.Windows.Automation.TreeScope]::Subtree,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsScrollPatternAvailableProperty,$true)))
      if(-not $element){$result=Result $false $false 'scroll_unsupported' 'This window does not expose a verifiable scroll control.';break}
      $pattern=$element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern);$before=$pattern.Current;$horizontal=[System.Windows.Automation.ScrollAmount]::NoAmount;$vertical=$horizontal
      switch($request.direction){up{$vertical=[System.Windows.Automation.ScrollAmount]::SmallDecrement};down{$vertical=[System.Windows.Automation.ScrollAmount]::SmallIncrement};left{$horizontal=[System.Windows.Automation.ScrollAmount]::SmallDecrement};right{$horizontal=[System.Windows.Automation.ScrollAmount]::SmallIncrement};default{throw 'invalid_direction'}}
      for($i=0;$i -lt [Math]::Min(10,[Math]::Max(1,[int]$request.amount));$i++){$pattern.Scroll($horizontal,$vertical)}
      $after=$pattern.Current;$verified=$after.HorizontalScrollPercent -ne $before.HorizontalScrollPercent -or $after.VerticalScrollPercent -ne $before.VerticalScrollPercent
      $result=Result $verified $verified 'scroll_readback' $(if($verified){'The scroll position changed.'}else{'The scroll control did not move, or it is already at the boundary.'})
    }
    default { $result=Result $false $false 'unsupported' 'The requested Windows operation is not available.' }
  }
  $result | ConvertTo-Json -Depth 15 -Compress
} catch {
  (Result $false $false 'windows_action_failed' 'Windows could not complete this action. No elevation was requested.') | ConvertTo-Json -Compress
}
