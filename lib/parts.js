import { MODULE, hashJson, pick } from './util.js';

// Only secrets that live in plain settings.json are handled here. The real API keys are in
// secrets.json, which an extension cannot read (and must never move).
const SECRET_RE = /(api[_-]?key|secret|password|authorization|access[_-]?token|auth[_-]?token|bearer)/i;

const API_KEYS = [
  'main_api', 'amount_gen', 'max_context', 'swipes', 'world_info_settings',
  'textgenerationwebui_settings', 'nai_settings', 'kai_settings', 'horde_settings',
  'oai_settings', 'proxies', 'selected_proxy',
];

const isPersonaKey = k => k.startsWith('persona') || k === 'default_persona';

// Positions and sizes of draggable windows (zoomed avatars, panels) are in pixels of the screen
// they were saved on, so a phone's values would squash or push the windows off-screen on a PC.
const isDeviceSpecificKey = k => k === 'movingUIState';

export function scrub(value, counter) {
  if (Array.isArray(value)) return value.map(v => scrub(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_RE.test(k) && typeof v === 'string' && v) {
        counter.n++;
        continue;
      }
      out[k] = scrub(v, counter);
    }
    return out;
  }
  return value;
}

/**
 * Split settings.json into independently selectable parts.
 * Each part's value is an object of top-level settings keys; `power_user` and
 * `extension_settings` are merged one level deep when applied.
 */
export function splitSettings(settings, counter) {
  const power = settings.power_user ?? {};
  const parts = {};

  parts.ui = {
    label: 'หน้าตา / ค่าผู้ใช้ (power_user)',
    value: {
      power_user: pick(power, k => !isPersonaKey(k) && !isDeviceSpecificKey(k)),
      accountStorage: settings.accountStorage,
      background: settings.background,
    },
  };
  parts.personas = {
    label: 'Persona (ชื่อ/คำอธิบายผู้ใช้)',
    value: {
      power_user: pick(power, isPersonaKey),
      user_avatar: settings.user_avatar,
    },
  };
  parts.api = {
    label: 'ค่าการเชื่อมต่อ / พารามิเตอร์ Generate',
    value: scrub(pick(settings, k => API_KEYS.includes(k)), counter),
  };
  parts.tags = {
    label: 'แท็กตัวละคร',
    value: { tags: settings.tags, tag_map: settings.tag_map },
  };
  for (const [name, value] of Object.entries(settings.extension_settings ?? {})) {
    if (name === MODULE) continue;
    parts[`ext:${name}`] = {
      label: `ตั้งค่า Extension: ${name}`,
      value: { extension_settings: { [name]: scrub(value, counter) } },
    };
  }
  for (const part of Object.values(parts)) part.hash = hashJson(part.value);
  return parts;
}

export function applyPart(settings, value) {
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) continue;
    if (key === 'power_user' || key === 'extension_settings') {
      settings[key] = { ...(settings[key] ?? {}), ...val };
    } else {
      settings[key] = val;
    }
  }
}
