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
    const register = this.registered
      ? ''
      : `$k='HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'; if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }; Set-ItemProperty -Path $k -Name DisplayName -Value 'Tether';`;
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
