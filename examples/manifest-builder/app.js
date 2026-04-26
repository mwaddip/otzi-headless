import { h, render } from 'preact';
import { signal, computed } from '@preact/signals';
import htm from 'htm';
import schemaData from './schema.js';
import {
  emptyManifest,
  exportManifest,
  contractTypeRequiresDecimals,
  contractTypeRequiresAbi,
} from './model.js';
import { validateManifest } from './validation.js';
import { slugify } from './slugify.js';

const html = htm.bind(h);

const state = signal(emptyManifest());
const activeSection = signal('meta');
const schema = signal(schemaData);
const banner = signal(null);

const validation = computed(() => {
  if (!schema.value) return { errors: [], warnings: [] };
  return validateManifest(state.value, schema.value);
});

const errorsBySection = computed(() => {
  const map = { meta: 0, contracts: 0 };
  for (const e of validation.value.errors) {
    if (e.path.startsWith('contracts')) map.contracts++;
    else map.meta++;
  }
  return map;
});

function update(fn) {
  state.value = fn(structuredClone(state.value));
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!schema.value) {
        banner.value = { kind: 'error', text: 'Schema not loaded yet — try again.' };
        return;
      }
      const r = validateManifest(parsed, schema.value);
      if (r.errors.length > 0) {
        banner.value = {
          kind: 'error',
          text: `Invalid manifest: ${r.errors[0].message} at ${r.errors[0].path || '<root>'}`,
        };
        return;
      }
      state.value = parsed;
      banner.value = { kind: 'ok', text: `Loaded ${file.name}` };
    } catch (err) {
      banner.value = { kind: 'error', text: `Parse error: ${err.message}` };
    }
  };
  reader.readAsText(file);
}

function exportFile() {
  if (validation.value.errors.length > 0) return;
  const out = exportManifest(state.value);
  const json = JSON.stringify(out, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(state.value.name)}.otzi.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function Sidebar() {
  const errs = errorsBySection.value;
  const counts = {
    contracts: state.value.contracts.length,
  };
  const sectionItem = (key, label, count, errCount) => html`
    <button
      class=${`nav-item ${activeSection.value === key ? 'active' : ''}`}
      onClick=${() => (activeSection.value = key)}>
      ${label}${count != null ? ` (${count})` : ''}${errCount > 0 ? html`<span class="err-badge">⚠ ${errCount}</span>` : null}
    </button>`;
  return html`
    <aside class="sidebar">
      <label class="load-btn">
        Load .otzi.json
        <input type="file" accept=".json" onChange=${(e) => e.target.files[0] && loadFile(e.target.files[0])}/>
      </label>
      <hr/>
      ${sectionItem('meta', 'Meta', null, errs.meta)}
      ${sectionItem('contracts', 'Contracts', counts.contracts, errs.contracts)}
    </aside>`;
}

function ExportPanel() {
  const errCount = validation.value.errors.length;
  return html`
    <aside class="export-panel">
      <button class="export-btn" disabled=${errCount > 0} onClick=${exportFile}>
        Download .otzi.json
      </button>
      ${errCount > 0 ? html`<p class="hint">${errCount} error${errCount === 1 ? '' : 's'} — fix to enable export.</p>` : null}
    </aside>`;
}

function FieldErrors({ path }) {
  const errs = validation.value.errors.filter((e) => e.path === path);
  if (errs.length === 0) return null;
  return html`<ul class="field-errors">${errs.map((e) => html`<li>${e.message}</li>`)}</ul>`;
}

function MetaSection() {
  return html`
    <section>
      <h2>Project metadata</h2>
      <label>Project name <input value=${state.value.name}
        onInput=${(e) => update((s) => ({ ...s, name: e.target.value }))}/></label>
      <${FieldErrors} path="name"/>
      <label>Description <input value=${state.value.description ?? ''}
        onInput=${(e) => update((s) => ({ ...s, description: e.target.value }))}/></label>
      <${FieldErrors} path="description"/>
    </section>`;
}

function ContractCard({ index, contract }) {
  const setContract = (mut) => update((s) => {
    const contracts = [...s.contracts];
    contracts[index] = mut(contracts[index]);
    return { ...s, contracts };
  });
  const onTypeChange = (newType) => setContract((c) => {
    const next = { ...c, type: newType };
    // Drop fields that are invalid for the new type. Pre-release: no
    // UX subtlety needed — user re-enters if they switch back.
    if (!contractTypeRequiresDecimals(newType)) delete next.decimals;
    if (!contractTypeRequiresAbi(newType)) delete next.abi;
    if (contractTypeRequiresDecimals(newType) && typeof next.decimals !== 'number') {
      next.decimals = 18;
    }
    if (contractTypeRequiresAbi(newType) && !Array.isArray(next.abi)) {
      next.abi = [];
    }
    return next;
  });
  return html`
    <div class="card">
      <header><strong>${contract.name || '(unnamed)'}</strong> — ${contract.type}</header>
      <label>Name <input value=${contract.name}
        placeholder="identifier (max 64 chars)"
        onInput=${(e) => setContract((c) => ({ ...c, name: e.target.value }))}/></label>
      <${FieldErrors} path=${`contracts.${index}.name`}/>
      <label>Address <input value=${contract.address}
        placeholder="0x + 64 hex"
        onInput=${(e) => setContract((c) => ({ ...c, address: e.target.value }))}/></label>
      <${FieldErrors} path=${`contracts.${index}.address`}/>
      <label>Type <select value=${contract.type}
        onChange=${(e) => onTypeChange(e.target.value)}>
        <option>OP20</option><option>OP20S</option><option>OP721</option><option>Custom</option>
      </select></label>
      <${FieldErrors} path=${`contracts.${index}.type`}/>
      ${contractTypeRequiresDecimals(contract.type) ? html`
        <label>Decimals <input type="number" min="0" max="38"
          value=${contract.decimals ?? ''}
          onInput=${(e) => setContract((c) => ({
            ...c,
            decimals: e.target.value === '' ? undefined : Number(e.target.value),
          }))}/></label>
        <${FieldErrors} path=${`contracts.${index}.decimals`}/>
      ` : null}
      ${contractTypeRequiresAbi(contract.type) ? html`
        <label>ABI (JSON array of <code>{ name, params: [{ name, type }] }</code>)
          <textarea rows="8" value=${JSON.stringify(contract.abi ?? [], null, 2)}
            onChange=${(e) => {
              try {
                const v = JSON.parse(e.target.value);
                setContract((c) => ({ ...c, abi: v }));
              } catch (err) {
                banner.value = { kind: 'error', text: `ABI JSON: ${err.message}` };
              }
            }}></textarea></label>
        <${FieldErrors} path=${`contracts.${index}.abi`}/>
      ` : null}
      <button class="delete" onClick=${() => update((s) => ({
        ...s,
        contracts: s.contracts.filter((_, i) => i !== index),
      }))}>Delete</button>
    </div>`;
}

function ContractsSection() {
  return html`
    <section>
      <h2>Contracts</h2>
      ${state.value.contracts.map((contract, i) => html`
        <${ContractCard} index=${i} contract=${contract}/>
      `)}
      <button onClick=${() => update((s) => ({
        ...s,
        contracts: [...s.contracts, { name: '', address: '', type: 'OP20', decimals: 18 }],
      }))}>+ Add Contract</button>
    </section>`;
}

function App() {
  let body;
  switch (activeSection.value) {
    case 'meta': body = html`<${MetaSection}/>`; break;
    case 'contracts': body = html`<${ContractsSection}/>`; break;
  }
  return html`
    <div class="layout">
      <${Sidebar}/>
      <main>
        ${banner.value ? html`<div class=${`banner ${banner.value.kind}`}>${banner.value.text} <button onClick=${() => (banner.value = null)}>×</button></div>` : null}
        ${body}
      </main>
      <${ExportPanel}/>
    </div>`;
}

render(html`<${App}/>`, document.body);
