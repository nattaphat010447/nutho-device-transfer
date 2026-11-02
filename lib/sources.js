import { ctx, hashJson, pick, postJson } from './util.js';

const CARD_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
  'tags', 'creator', 'character_version', 'character_book', 'extensions',
];

/** Hash only the card content so re-imports (which rewrite create_date etc.) still compare equal. */
export function cardHash(card) {
  const data = card?.data ?? card ?? {};
  return hashJson(pick(data, k => CARD_FIELDS.includes(k)));
}

const GROUP_FIELDS = [
  'id', 'name', 'members', 'avatar_url', 'allow_self_responses', 'activation_strategy',
  'generation_mode', 'disabled_members', 'fav', 'chat_id', 'chats', 'auto_mode_delay',
  'generation_mode_join_prefix', 'generation_mode_join_suffix',
];

export function cleanGroup(group) {
  return pick(group, k => GROUP_FIELDS.includes(k));
}

/** [apiId, array of preset JSON strings, array of names] for presets that are stored by file name. */
const NAMED_PRESETS = [
  ['openai', 'openai_settings', 'openai_setting_names'],
  ['textgenerationwebui', 'textgenerationwebui_presets', 'textgenerationwebui_preset_names'],
  ['kobold', 'koboldai_settings', 'koboldai_setting_names'],
  ['novel', 'novelai_settings', 'novelai_setting_names'],
];

/** Presets whose name lives inside the JSON itself. */
const EMBEDDED_PRESETS = ['instruct', 'context', 'sysprompt', 'reasoning'];

/** Flat list of every preset-like small JSON the server hands out from /api/settings/get. */
export function listSmallItems(all) {
  const items = [];
  for (const [apiId, contentKey, nameKey] of NAMED_PRESETS) {
    const contents = all[contentKey] ?? [];
    const names = all[nameKey] ?? [];
    contents.forEach((text, i) => {
      try {
        items.push({ type: 'preset', apiId, name: names[i], value: JSON.parse(text) });
      } catch {
        // skip unreadable preset
      }
    });
  }
  for (const apiId of EMBEDDED_PRESETS) {
    for (const value of all[apiId] ?? []) {
      if (value?.name) items.push({ type: 'preset', apiId, name: value.name, value });
    }
  }
  for (const value of all.themes ?? []) {
    if (value?.name) items.push({ type: 'theme', name: value.name, value });
  }
  for (const value of all.quickReplyPresets ?? []) {
    if (value?.name) items.push({ type: 'quickreply', name: value.name, value });
  }
  for (const value of all.movingUIPresets ?? []) {
    if (value?.name) items.push({ type: 'movingui', name: value.name, value });
  }
  for (const item of items) {
    item.key = item.type === 'preset' ? `preset/${item.apiId}/${item.name}` : `${item.type}/${item.name}`;
  }
  return items;
}

/** Ask the server, not the page: ctx().characters is empty until ST finishes (or is blocked by) startup. */
export async function listCharacters() {
  const list = await postJson('/api/characters/all');
  return (Array.isArray(list) ? list : []).filter(c => c?.avatar);
}

export async function stVersion() {
  try {
    const res = await fetch('/version', { headers: ctx().getRequestHeaders() });
    return (await res.json()).pkgVersion ?? '';
  } catch {
    return '';
  }
}

export async function loadAllSettings() {
  return postJson('/api/settings/get');
}
