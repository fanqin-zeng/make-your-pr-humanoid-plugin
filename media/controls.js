"use strict";

const host = acquireVsCodeApi();
const get = name => document.getElementById(name);
let state = {};
const automationFields = ["edit", "commit", "push"];

function automationValues() {
    return Object.fromEntries(automationFields.map(field => [field, get("auto-" + field).checked]));
}

function fill(select, options, selected, placeholder) {
    const matched = options.some(item => item.id === selected);
    const items = matched ? options : [{ id: "", label: placeholder }, ...options];
    select.replaceChildren(...items.map(item => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        return option;
    }));
    select.value = matched ? selected : "";
}

window.addEventListener("message", event => {
    if (event.data.type === "directory") get("directory").value = event.data.value;
    if (event.data.type !== "state") return;
    state = event.data.state;
    fill(get("repository"), state.repositories, state.repository, "没有 Git 仓库");
    fill(get("target"), state.refs, state.target, "选择目标分支");
    fill(get("source"), state.refs, state.source, "选择来源分支");
    fill(get("version"), state.versions, state.version, "暂无版本");
    for (const id of ["repository", "target", "source", "version", "discover", "refresh"]) get(id).disabled = state.busy;
    const directory = get("directory");
    if (document.activeElement !== directory && directory.dataset.saved !== state.directory) {
        directory.value = state.directory;
        directory.dataset.saved = state.directory;
    }
    directory.disabled = state.busy || !state.comparison;
    get("browse").disabled = directory.disabled;
    for (const field of automationFields) {
        const checkbox = get("auto-" + field);
        checkbox.checked = Boolean(state.automation[field]);
        checkbox.disabled = state.busy || !state.comparison || state.historical;
    }
    get("export").disabled = !state.ready || state.busy;
    get("export-clarifications").disabled = !state.clarificationReady || state.busy;
    get("waiting").hidden = !state.waiting;
    get("waiting").textContent = state.waiting ? state.waiting + " 项需求等待 Agent 回传" : "";
    get("status").dataset.kind = state.status.kind;
    get("status").textContent = state.status.text;
    get("comparison").hidden = !state.comparison;
    if (state.comparison) {
        const { base, head, working } = state.comparison;
        get("comparison").textContent = "PR 基点 " + base + " → " + state.version
            + (working ? " · 工作树" : " · " + head);
    }
});

function select(repository, target, source) {
    host.postMessage({ type: "select", repository, target, source });
}

get("repository").addEventListener("change", event => select(event.target.value));
get("target").addEventListener("change", event => select(state.repository, event.target.value, state.source));
get("source").addEventListener("change", event => select(state.repository, state.target, event.target.value));
get("version").addEventListener("change", event => host.postMessage({ type: "version", version: event.target.value }));
get("discover").onclick = () => host.postMessage({ type: "discover" });
get("refresh").onclick = () => host.postMessage({ type: "refresh" });
for (const [index, field] of automationFields.entries()) {
    get("auto-" + field).addEventListener("change", event => {
        const checked = event.target.checked;
        const dependent = checked ? automationFields.slice(0, index) : automationFields.slice(index + 1);
        for (const name of dependent) get("auto-" + name).checked = checked;
        host.postMessage({ type: "automation", automation: automationValues() });
    });
}
get("browse").onclick = () => host.postMessage({ type: "browseDirectory", directory: get("directory").value });
get("export").onclick = () => host.postMessage({ type: "export", directory: get("directory").value, automation: automationValues() });
get("export-clarifications").onclick = () => host.postMessage({ type: "exportClarifications", directory: get("directory").value });
host.postMessage({ type: "ready" });
