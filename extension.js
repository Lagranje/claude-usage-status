const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const REFRESH_MS = 300_000;
const MIN_GAP_MS = 60_000;
const WARN_AT = 80;
const ERROR_AT = 95;

let item;
let timer;
let isLoading = false;
let lastUsage;
let lastFetchAt = 0;
let blockedUntil = 0;
let state;

function activate(context) {
  state = context.globalState;
  ({ lastUsage, lastFetchAt = 0, blockedUntil = 0 } = state.get('cache', {}));
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  item.command = 'claudeUsageStatus.refresh';
  item.text = '$(pulse) Claude: …';
  item.show();

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('claudeUsageStatus.refresh', refresh),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('claudeUsageStatus') && refresh()),
    vscode.window.onDidChangeWindowState(s => s.focused && Date.now() - lastFetchAt > MIN_GAP_MS && refresh()),
    { dispose: () => clearInterval(timer) },
  );

  // Show cached values first; skip fetch if they are fresh
  render(lastUsage, Date.now() < blockedUntil ? 'rate limited, waiting to retry' : undefined);
  if (Date.now() - lastFetchAt > MIN_GAP_MS) refresh();
  timer = setInterval(refresh, REFRESH_MS);
}

async function refresh() {
  if (isLoading) return;
  // Respect server backoff after a 429
  if (Date.now() < blockedUntil) return render(lastUsage, `rate limited, retry ${resetsIn(new Date(blockedUntil).toISOString())}`);
  isLoading = true;
  lastFetchAt = Date.now();
  item.text = item.text.replace('$(pulse)', '$(sync~spin)');

  try {
    lastUsage = await fetchUsage(await readToken());
    render(lastUsage);
  } catch (err) {
    render(lastUsage, err.message);
  } finally {
    isLoading = false;
    state.update('cache', { lastUsage, lastFetchAt, blockedUntil });
  }
}

// Read-only: never refresh the token, Claude Code owns it
async function readToken() {
  const found = (await Promise.all([...readKeychainAll(), readCredentialsFile()])).filter(Boolean);
  if (!found.length) throw new Error('no Claude Code login found');

  const freshest = found.reduce((a, b) => (b.expiresAt > a.expiresAt ? b : a));
  if (freshest.expiresAt < Date.now()) throw new Error('token expired, use Claude Code to renew it');
  return freshest.accessToken;
}

// macOS: Claude Code writes under the OS user; other accounts may be stale
function readKeychainAll() {
  if (process.platform !== 'darwin') return [];
  return [os.userInfo().username, 'credentials', undefined].map(readKeychain);
}

// Windows/Linux: plain file in the Claude config dir
async function readCredentialsFile() {
  const dir = configDir();
  try {
    return toLogin(await fs.readFile(path.join(dir, '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Setting, then CLAUDE_CONFIG_DIR, then ~/.claude
function configDir() {
  const setting = vscode.workspace.getConfiguration('claudeUsageStatus').get('configDir', '').trim();
  const dir = setting || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return dir.replace(/^~(?=$|[\\/])/, os.homedir());
}

function toLogin(json) {
  try {
    const oauth = JSON.parse(json.trim()).claudeAiOauth;
    return oauth?.accessToken ? { accessToken: oauth.accessToken, expiresAt: Number(oauth.expiresAt) || 0 } : null;
  } catch {
    return null;
  }
}

function readKeychain(account) {
  const args = ['find-generic-password', '-s', 'Claude Code-credentials', '-w'];
  if (account) args.push('-a', account);

  return new Promise(resolve => {
    execFile('security', args, (err, out) => resolve(err ? null : toLogin(out)));
  });
}

async function fetchUsage(token) {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || 300;
    blockedUntil = Date.now() + wait * 1000;
    throw new Error(`rate limited, retry ${resetsIn(new Date(blockedUntil).toISOString())}`);
  }
  if (res.status === 401) throw new Error('token expired, use Claude Code to renew it');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function render(usage, error) {
  if (!usage) {
    item.text = '$(pulse) Claude: —';
    item.tooltip = `Claude usage unavailable: ${error}`;
    item.backgroundColor = undefined;
    return;
  }
  const session = usage.five_hour;
  const week = usage.seven_day;
  const peak = Math.max(session?.utilization ?? 0, week?.utilization ?? 0);

  item.text = `$(pulse) Claude: ${pct(session)} | ${pct(week)}`;
  item.backgroundColor =
    peak >= ERROR_AT ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : peak >= WARN_AT ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;

  const rows = [
    ['Session (5hr)', session],
    ['Weekly (7 day)', week],
    ['Weekly Opus', usage.seven_day_opus],
    ['Weekly Sonnet', usage.seven_day_sonnet],
  ].filter(([, w]) => w);

  const tip = new vscode.MarkdownString(
    `${dim('<b>USAGE</b>')}\n\n` +
    rows.map(([name, w]) => usageBlock(name, w)).join('\n\n') +
    (error ? `\n\n${dim(`⚠ ${error}, showing last values`)}` : '') +
    `\n\n---\n\n${dim('Click to refresh')}`,
  );
  tip.supportHtml = true;
  item.tooltip = tip;
}

const BAR_WIDTH = 16;

function usageBlock(name, w) {
  const filled = Math.min(BAR_WIDTH, Math.round((w.utilization / 100) * BAR_WIDTH));
  const color = w.utilization >= ERROR_AT ? '#F14C4C' : w.utilization >= WARN_AT ? '#FF8A3D' : '#FFD866';
  // Heading enlarges the block glyphs into a thicker bar
  const bar =
    `### <span style="color:${color};">${'▃'.repeat(filled)}</span>` +
    `<span style="color:#3C3C3C;">${'▃'.repeat(BAR_WIDTH - filled)}</span>`;
  const resets = w.resets_at ? `\n\n${dim(`Resets ${resetsIn(w.resets_at, true)}`)}` : '';
  return `${name} &nbsp; <b>${pct(w)}</b>\n${bar}${resets}`;
}

function dim(html) {
  return `<span style="color:#8B8B8B;">${html}</span>`;
}

function pct(window) {
  return window ? `${Math.round(window.utilization)}%` : '—';
}

function resetsIn(iso, isShort = false) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  // Short form rounds to the largest unit, like Claude's /usage
  if (isShort) return 'in ' + (d ? `${d}d` : h ? `${h}h` : `${m}m`);
  return 'in ' + (d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`);
}

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate };
