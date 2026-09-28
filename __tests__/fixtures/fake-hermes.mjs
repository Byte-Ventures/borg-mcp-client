// A fake `hermes` CLI for installer tests. The real Hermes binary is never run
// by any test (decision ebbfb45c): it performs self-update work against the
// live install whatever HERMES_HOME says.
//
// It models the documented commands the installer uses, with Hermes's value
// coercion for `config set` (hermes_cli/config.py _coerce_config_set_value):
//   config set <key> <value> | config get <key> [--json] [--raw] | config unset <key>
//   plugins enable <name> | gateway status | gateway restart | serve --stop
// config.yaml is stored as JSON (valid YAML). Every call is appended to
// $FAKE_HERMES_LOG. $FAKE_HERMES_RULES names a JSON file of per-call overrides:
//   [{ "match": "<argv prefix>", "code": 1, "stderr": "...", "store": <value>, "touch": true }]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const home = process.env.HERMES_HOME;
const root = process.env.FAKE_HERMES_ROOT;
if (!home || !root || !(resolve(home) + sep).startsWith(resolve(root) + sep)) {
  process.stderr.write('fake hermes: HERMES_HOME must be inside FAKE_HERMES_ROOT\n');
  process.exit(90);
}

if (process.env.FAKE_HERMES_LOG) {
  appendFileSync(process.env.FAKE_HERMES_LOG, `${JSON.stringify({
    argv,
    home,
    allowAllEnv: Object.keys(process.env).filter((name) => name.endsWith('ALLOW_ALL_USERS')),
  })}\n`);
}
if (process.env.FAKE_HERMES_NOISE === '1') process.stdout.write('hermes: completing source-update dependencies...\n→ Syncing bundled skills...\n');

const configPath = join(home, 'config.yaml');
const envPath = join(home, '.env');
const loadConfig = () => {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, 'utf8').trim();
  return text ? JSON.parse(text) : {};
};
const saveConfig = (config) => writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

const rules = process.env.FAKE_HERMES_RULES && existsSync(process.env.FAKE_HERMES_RULES)
  ? JSON.parse(readFileSync(process.env.FAKE_HERMES_RULES, 'utf8'))
  : [];
const joined = argv.join(' ');
const rule = rules.find((candidate) => joined.startsWith(candidate.match));
if (rule?.touch) {
  const config = loadConfig();
  config.touched_by_someone_else = true;
  saveConfig(config);
}
if (rule && rule.code !== undefined) fail(rule.stderr ?? 'fake hermes: injected failure', rule.code);

const DEFAULTS = { gateway: { allow_all_users: false } };
const envKey = (key) => /^[A-Z][A-Z0-9_]*$/.test(key);
const segments = (key) => key.split('.');

function coerce(text) {
  if (/^[[{]/.test(text) || text.includes('\n')) {
    try { return JSON.parse(text); } catch { fail(`Invalid value for config set: ${text}`); }
  }
  const word = text.toLowerCase();
  if (['true', 'yes', 'on'].includes(word)) return true;
  if (['false', 'no', 'off'].includes(word)) return false;
  if (['null', 'none', '~'].includes(word)) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text) && String(Number(text)) === text) return Number(text);
  return text;
}

function lookup(config, key) {
  let node = config;
  for (const part of segments(key)) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function readEnvFile() {
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

const [group, action, ...rest] = argv;
if (group === 'config' && action === 'get') {
  const key = rest[0];
  const json = rest.includes('--json');
  let value;
  if (envKey(key)) value = process.env[key] ?? readEnvFile()[key];
  else value = lookup(loadConfig(), key) ?? lookup(DEFAULTS, key);
  if (value === undefined) fail(`Config key not set: ${key}`);
  process.stdout.write(`${json ? JSON.stringify(value) : String(value)}\n`);
  process.exit(0);
}
if (group === 'config' && action === 'set') {
  const [key, text] = rest;
  if (key === undefined || text === undefined) fail('usage: hermes config set <key> <value>', 2);
  const value = rule && 'store' in rule ? rule.store : coerce(text);
  if (envKey(key)) {
    appendFileSync(envPath, `${key}=${text}\n`);
  } else {
    const config = loadConfig();
    const parts = segments(key);
    let node = config;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = value;
    saveConfig(config);
  }
  process.stdout.write(`✓ Set ${key} = ${text} in ${configPath}\n`);
  process.exit(0);
}
if (group === 'config' && action === 'unset') {
  const key = rest[0];
  const config = loadConfig();
  const parts = segments(key);
  const parent = parts.length === 1 ? config : lookup(config, parts.slice(0, -1).join('.'));
  if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, parts.at(-1))) {
    fail(`Config key not set: ${key}`);
  }
  delete parent[parts.at(-1)];
  saveConfig(config);
  process.stdout.write(`✓ Removed ${key}\n`);
  process.exit(0);
}
if (group === 'plugins' && action === 'enable') {
  const name = rest[0];
  if (!existsSync(join(home, 'plugins', name, 'plugin.yaml'))) fail(`Plugin not found: ${name}`);
  const config = loadConfig();
  config.plugins ??= {};
  const enabled = Array.isArray(config.plugins.enabled) ? config.plugins.enabled : [];
  if (!enabled.includes(name)) enabled.push(name);
  config.plugins.enabled = enabled;
  if (Array.isArray(config.plugins.disabled)) config.plugins.disabled = config.plugins.disabled.filter((entry) => entry !== name);
  saveConfig(config);
  process.stdout.write(`✓ Enabled ${name}\n`);
  process.exit(0);
}
// The gateway as `hermes gateway status` shows it, from $HERMES_HOME/fake-gateway.json:
// { "mode": "launchd" | "systemd" | "manual" | "multiplexed" | "stopped" | "odd", "pid": 100,
//   "restartKeepsPid": false, "hang": false }
const gatewayPath = join(home, 'fake-gateway.json');
const gateway = existsSync(gatewayPath) ? JSON.parse(readFileSync(gatewayPath, 'utf8')) : { mode: 'launchd', pid: 100 };
if (group === 'gateway' && action === 'status') {
  const text = {
    launchd: `Launchd plist: /fake/ai.hermes.gateway.plist\n✓ Gateway is supervised by launchd (PID ${gateway.pid})\n`,
    systemd: `✓ User gateway service is running\n   Main PID: ${gateway.pid} (python)\n`,
    manual: `✓ Gateway is running (PID: ${gateway.pid})\n  (Running manually, not as a system service)\n`,
    multiplexed: '✓ Gateway is running via the default-profile multiplexer\n',
    stopped: '✗ Gateway is not running\n\nTo start:\n  hermes gateway run      # Run in foreground\n',
    odd: 'something this fake does not describe\n',
  }[gateway.mode];
  process.stdout.write(text);
  process.exit(0);
}
if (group === 'gateway' && action === 'restart') {
  if (gateway.hang || (gateway.mode !== 'launchd' && gateway.mode !== 'systemd')) {
    // Hermes runs the gateway in the foreground without a service: never returns.
    appendFileSync(join(home, 'fake-foreground-gateway'), `${process.pid}\n`);
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  } else {
    if (!gateway.restartKeepsPid) gateway.pid += 1;
    writeFileSync(gatewayPath, JSON.stringify(gateway));
    process.stdout.write(`fake ${joined}\n`);
    process.exit(0);
  }
}
if (group === 'serve' && action === '--stop') {
  process.stdout.write('No hermes dashboard processes running for this profile.\n');
  process.exit(0);
}
fail(`fake hermes: unsupported command: ${joined}`, 2);
