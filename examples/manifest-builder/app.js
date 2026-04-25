import { h, render } from 'preact';
import { signal, computed } from '@preact/signals';
import htm from 'htm';
import schemaData from './schema.js';
import { emptyManifest, renameContractKey, exportManifest, resolveAbiMethods } from './model.js';
import { validateManifest } from './validation.js';
import { slugify } from './slugify.js';

const html = htm.bind(h);

const state = signal(emptyManifest());
const mode = signal('headless'); // 'headless' | 'full'
const activeSection = signal('meta');
const schema = signal(schemaData);
const banner = signal(null);

const validation = computed(() => {
  if (!schema.value) return { errors: [], warnings: [] };
  return validateManifest(state.value, mode.value, schema.value);
});

const errorsBySection = computed(() => {
  const map = { meta: 0, contracts: 0, operations: 0 };
  for (const e of validation.value.errors) {
    if (e.path.startsWith('contracts')) map.contracts++;
    else if (e.path.startsWith('operations')) map.operations++;
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
      const r = validateManifest(parsed, mode.value, schema.value);
      if (r.errors.length > 0) {
        banner.value = { kind: 'error', text: `Invalid manifest: ${r.errors[0].message} at ${r.errors[0].path || '<root>'}` };
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
  const out = exportManifest(state.value, mode.value);
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
    contracts: Object.keys(state.value.contracts).length,
    operations: state.value.operations.length,
  };
  const sectionItem = (key, label, count, errCount, disabled) => html`
    <button
      class=${`nav-item ${activeSection.value === key ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
      onClick=${() => !disabled && (activeSection.value = key)}
      disabled=${disabled}>
      ${label}${count != null ? ` (${count})` : ''}${errCount > 0 ? html`<span class="err-badge">⚠ ${errCount}</span>` : null}
    </button>`;
  const fullDisabled = mode.value === 'headless';
  return html`
    <aside class="sidebar">
      <div class="mode">
        <label><input type="radio" name="mode" checked=${mode.value === 'headless'}
          onChange=${() => (mode.value = 'headless')}/> Headless</label>
        <label><input type="radio" name="mode" checked=${mode.value === 'full'}
          onChange=${() => (mode.value = 'full')}/> Full</label>
      </div>
      <label class="load-btn">
        Load .otzi.json
        <input type="file" accept=".json" onChange=${(e) => e.target.files[0] && loadFile(e.target.files[0])}/>
      </label>
      <hr/>
      ${sectionItem('meta', 'Meta', null, errs.meta, false)}
      ${sectionItem('contracts', 'Contracts', counts.contracts, errs.contracts, false)}
      ${sectionItem('operations', 'Operations', counts.operations, errs.operations, false)}
      ${sectionItem('reads', 'Reads', null, 0, fullDisabled)}
      ${sectionItem('status', 'Status', null, 0, fullDisabled)}
      ${sectionItem('theme', 'Theme', null, 0, fullDisabled)}
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
  const isFull = mode.value === 'full';
  return html`
    <section>
      <h2>Project metadata</h2>
      <label>Project name <input value=${state.value.name}
        onInput=${(e) => update((s) => ({ ...s, name: e.target.value }))}/></label>
      <label>Description <input value=${state.value.description ?? ''}
        onInput=${(e) => update((s) => ({ ...s, description: e.target.value }))}/></label>
      ${isFull ? html`
        <label>Icon URL <input value=${state.value.icon ?? ''}
          onInput=${(e) => update((s) => ({ ...s, icon: e.target.value }))}/></label>
      ` : null}
    </section>`;
}

function ContractCard({ key, contract }) {
  const abiMode = typeof contract.abi === 'string' ? 'shorthand' : Array.isArray(contract.abi) ? 'mixed' : 'custom';
  return html`
    <div class="card">
      <header><strong>${key || '(unnamed)'}</strong> — ${contract.label || ''}</header>
      <label>Key <input value=${key} onChange=${(e) => {
        try { update((s) => renameContractKey(s, key, e.target.value)); }
        catch (err) { banner.value = { kind: 'error', text: err.message }; }
      }}/></label>
      <label>Label <input value=${contract.label}
        onInput=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], label: e.target.value } } }))}/></label>
      <label>Address <input value=${contract.address}
        onInput=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], address: e.target.value } } }))}/></label>
      <div class="abi-tabs">
        <label><input type="radio" name=${`abi-${key}`} checked=${abiMode === 'shorthand'}
          onChange=${() => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: 'OP_20' } } }))}/> Shorthand</label>
        <label><input type="radio" name=${`abi-${key}`} checked=${abiMode === 'custom'}
          onChange=${() => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: [] } } }))}/> Custom</label>
      </div>
      ${abiMode === 'shorthand' ? html`
        <select value=${contract.abi}
          onChange=${(e) => update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: e.target.value } } }))}>
          <option>OP_20</option><option>OP_20S</option><option>OP_721</option>
        </select>` : html`
        <textarea rows="6" value=${JSON.stringify(contract.abi, null, 2)}
          onChange=${(e) => {
            try { const v = JSON.parse(e.target.value); update((s) => ({ ...s, contracts: { ...s.contracts, [key]: { ...s.contracts[key], abi: v } } })); }
            catch (err) { banner.value = { kind: 'error', text: `ABI JSON: ${err.message}` }; }
          }}></textarea>`}
      <button class="delete" onClick=${() => update((s) => {
        const next = { ...s, contracts: { ...s.contracts } };
        delete next.contracts[key];
        return next;
      })}>Delete</button>
    </div>`;
}

function ContractsSection() {
  return html`
    <section>
      <h2>Contracts</h2>
      ${Object.entries(state.value.contracts).map(([key, contract]) => html`<${ContractCard} key=${key} contract=${contract}/>`)}
      <button onClick=${() => {
        let i = 1;
        while (`contract${i}` in state.value.contracts) i++;
        update((s) => ({ ...s, contracts: { ...s.contracts, [`contract${i}`]: { label: '', abi: 'OP_20', address: '' } } }));
      }}>+ Add Contract</button>
    </section>`;
}

function ParamCard({ opIndex, paramIndex, param }) {
  const setParam = (mut) => update((s) => {
    const ops = [...s.operations];
    const op = { ...ops[opIndex] };
    const params = [...op.params];
    params[paramIndex] = mut(params[paramIndex]);
    op.params = params;
    ops[opIndex] = op;
    return { ...s, operations: ops };
  });
  const isFull = mode.value === 'full';
  return html`
    <div class="param-card">
      <label>Name <input value=${param.name} onInput=${(e) => setParam((p) => ({ ...p, name: e.target.value }))}/></label>
      <label>Type <select value=${param.type} onChange=${(e) => setParam((p) => ({ ...p, type: e.target.value }))}>
        <option>uint256</option><option>address</option><option>bool</option><option>bytes</option>
      </select></label>
      ${isFull ? html`
        <label>Label <input value=${param.label ?? ''} onInput=${(e) => setParam((p) => ({ ...p, label: e.target.value }))}/></label>
        <label>Placeholder <input value=${param.placeholder ?? ''} onInput=${(e) => setParam((p) => ({ ...p, placeholder: e.target.value }))}/></label>
      ` : null}
      <label>Scale <input type="number" value=${param.scale ?? ''} onInput=${(e) => setParam((p) => ({ ...p, scale: e.target.value === '' ? undefined : Number(e.target.value) }))}/></label>
      <label>Source <input value=${param.source ?? ''} placeholder="contract:foo or setting:bar"
        onInput=${(e) => setParam((p) => ({ ...p, source: e.target.value || undefined }))}/></label>
      <${FieldErrors} path=${`operations.${opIndex}.params.${paramIndex}.source`}/>
    </div>`;
}

function OperationCard({ index, op }) {
  const setOp = (mut) => update((s) => {
    const ops = [...s.operations];
    ops[index] = mut(ops[index]);
    return { ...s, operations: ops };
  });
  const contractKeys = Object.keys(state.value.contracts);
  const methods = op.contract && op.contract !== '$dynamic' && state.value.contracts[op.contract]
    ? resolveAbiMethods(state.value.contracts[op.contract].abi)
    : [];
  const isFull = mode.value === 'full';
  return html`
    <div class="card">
      <header><strong>${op.id || '(unnamed)'}</strong> — ${op.label || ''}</header>
      <label>ID <input value=${op.id} onInput=${(e) => setOp((o) => ({ ...o, id: e.target.value }))}/></label>
      <label>Label <input value=${op.label} onInput=${(e) => setOp((o) => ({ ...o, label: e.target.value }))}/></label>
      <label>Description <input value=${op.description ?? ''} onInput=${(e) => setOp((o) => ({ ...o, description: e.target.value }))}/></label>
      ${isFull ? html`
        <label>Confirm prompt <input value=${op.confirm ?? ''} onInput=${(e) => setOp((o) => ({ ...o, confirm: e.target.value }))}/></label>
      ` : null}
      <label>Contract <select value=${op.contract} onChange=${(e) => setOp((o) => ({ ...o, contract: e.target.value }))}>
        <option value="">(pick)</option>
        ${contractKeys.map((k) => html`<option>${k}</option>`)}
        <option value="$dynamic">$dynamic</option>
      </select></label>
      <${FieldErrors} path=${`operations.${index}.contract`}/>
      <label>Method ${op.contract === '$dynamic' || methods.length === 0
        ? html`<input value=${op.method} onInput=${(e) => setOp((o) => ({ ...o, method: e.target.value }))}/>`
        : html`<select value=${op.method} onChange=${(e) => setOp((o) => ({ ...o, method: e.target.value }))}>
            <option value="">(pick)</option>
            ${methods.map((m) => html`<option>${m}</option>`)}
          </select>`}
      </label>
      <${FieldErrors} path=${`operations.${index}.method`}/>
      <h4>Params</h4>
      ${(op.params ?? []).map((p, j) => html`<${ParamCard} opIndex=${index} paramIndex=${j} param=${p}/>`)}
      <button onClick=${() => setOp((o) => ({ ...o, params: [...(o.params ?? []), { name: '', type: 'uint256' }] }))}>+ Add Param</button>
      <button class="delete" onClick=${() => update((s) => ({ ...s, operations: s.operations.filter((_, i) => i !== index) }))}>Delete Operation</button>
    </div>`;
}

function OperationsSection() {
  return html`
    <section>
      <h2>Operations</h2>
      ${state.value.operations.map((op, i) => html`<${OperationCard} index=${i} op=${op}/>`)}
      <button onClick=${() => update((s) => {
        let i = 1;
        const ids = new Set(s.operations.map((o) => o.id));
        while (ids.has(`op${i}`)) i++;
        return { ...s, operations: [...s.operations, { id: `op${i}`, label: '', contract: '', method: '', params: [] }] };
      })}>+ Add Operation</button>
    </section>`;
}

function App() {
  let body;
  switch (activeSection.value) {
    case 'meta': body = html`<${MetaSection}/>`; break;
    case 'contracts': body = html`<${ContractsSection}/>`; break;
    case 'operations': body = html`<${OperationsSection}/>`; break;
    default: body = html`<section><p class="hint">Full mode — coming in v2.</p></section>`;
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
