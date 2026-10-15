// Desktop notifications for things people should know about when no terminal is open:
// reverts, conflicts, lost live sessions, revoked access, sign-in and update problems.
// Windows: toast notifications (registered as "Tether"); Linux: notify-send when available.
// Events are batched for a few seconds so a burst becomes one notification.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { isWindows } from './paths.js';

const AUMID = 'Tether.Sync';
const FLUSH_MS = 3000;
const LEVELS = { info: 0, warn: 1, error: 2 };

/** PowerShell that creates a Start menu shortcut carrying the AppUserModelID; Windows only shows
 * toast banners for an unpackaged app that has one. */
const SHORTCUT_SCRIPT = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace TetherShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int cch, IntPtr fd, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short k);
    void SetHotkey(short k);
    void GetShowCmd(out int c);
    void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int cch, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  public static class Maker {
    public static void Create(string lnk, string aumid, string url) {
      var link = (IShellLinkW)new CShellLink();
      link.SetPath(Environment.ExpandEnvironmentVariables("%SystemRoot%\\explorer.exe"));
      link.SetArguments(url);
      link.SetDescription("Tether");
      link.SetIconLocation(Environment.ExpandEnvironmentVariables("%SystemRoot%\\System32\\imageres.dll"), 228);
      var store = (IPropertyStore)link;
      var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
      var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
      store.SetValue(ref key, ref v);
      store.Commit();
      ((IPersistFile)link).Save(lnk, true);
      Marshal.FreeCoTaskMem(v.p);
    }
  }
}
'@
`;

export class Notifier {
  /** setting: 'all' | 'errors' | 'off' (config key `notifications`). */
  constructor({ setting = () => 'all', consoleUrl = () => '', log = () => {} } = {}) {
    this.setting = setting;
    this.consoleUrl = consoleUrl;
    this.log = log;
    this.pending = new Map(); // kind -> events
    this.cooldown = new Map(); // key -> until
    this.timer = null;
    this.registered = false;
  }

  /**
   * event: { kind, level: 'info'|'warn'|'error', title, body, path?, artifactId?, key?, cooldownMs? }
   * Events sharing `key` are suppressed for cooldownMs (default: no cooldown).
   */
  notify(event) {
    const s = this.setting();
    if (s === 'off' || (s === 'errors' && LEVELS[event.level] < LEVELS.warn)) return;
    if (event.key) {
      if ((this.cooldown.get(event.key) ?? 0) > Date.now()) return;
      if (event.cooldownMs) this.cooldown.set(event.key, Date.now() + event.cooldownMs);
    }
    if (!this.pending.has(event.kind)) this.pending.set(event.kind, []);
    this.pending.get(event.kind).push(event);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.timer = null;
    for (const events of this.pending.values()) {
      const first = events[0];
      const more = events.length - 1;
      const title = more ? `${first.title} (+${more} more)` : first.title;
      const body = more ? `${first.body}\nAlso: ${events.slice(1, 4).map((e) => e.short ?? e.title).join('; ')}${more > 3 ? '…' : ''}` : first.body;
      const base = this.consoleUrl().replace(/\/$/, '');
      const url = base ? (first.artifactId && !more ? `${base}/artifacts/${first.artifactId}` : base) : '';
      this.show({ title, body, url, level: first.level });
    }
    this.pending.clear();
  }

  show(n) {
    this.log(`notify [${n.level}] ${n.title}: ${n.body.replace(/\n/g, ' ')}`);
    if (process.env.TETHER_NOTIFY_LOG) {
      fs.appendFileSync(process.env.TETHER_NOTIFY_LOG, JSON.stringify(n) + '\n');
      return;
    }
    try {
      if (isWindows) this.toast(n);
      else spawn('notify-send', ['--app-name=Tether', n.level === 'info' ? '--urgency=low' : '--urgency=normal', n.title, n.body], { stdio: 'ignore' }).on('error', () => {});
    } catch (e) {
      this.log(`notification failed: ${e.message}`);
    }
  }

  toast({ title, body, url }) {
    const esc = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
    const launch = url ? ` activationType="protocol" launch="${esc(url)}"` : '';
    const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>`;
    // First notification of this daemon: register the app ID and make sure the Start menu
    // shortcut exists (without it Windows only files the toasts in the Notification Center).
    const consoleUrl = (this.consoleUrl() || 'https://tether-b10cf.web.app').replace(/'/g, "''");
    const register = this.registered
      ? ''
      : `$k='HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'; if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }; Set-ItemProperty -Path $k -Name DisplayName -Value 'Tether';
$lnk = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Tether.lnk'
if (-not (Test-Path $lnk)) { try {
${SHORTCUT_SCRIPT}
[TetherShortcut.Maker]::Create($lnk, '${AUMID}', '${consoleUrl}') } catch {} }`;
    this.registered = true;
    const script = `${register}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('${xml.replace(/'/g, "''")}')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show((New-Object Windows.UI.Notifications.ToastNotification $x))`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => this.log(`notification failed: ${e.message}`));
  }
}
