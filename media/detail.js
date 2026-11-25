"use strict";

const host = acquireVsCodeApi();
const get = name => document.getElementById(name);
const splitter = get("splitter");
const note = get("note");
let state = {};
let editingId;
let submitting = false;
const rendered = new Map();

function element(tag, text, className) {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
}

function lineLabel(side, start, end) {
    return (side === "old" ? "旧版 " : "新版 ") + start + (start === end ? "" : "–" + end) + " 行";
}

function rangeButton(fileId, range) {
    const button = element("button", lineLabel(range.side, range.start, range.end), "link");
    button.type = "button";
    const comparison = state.comparison;
    button.onclick = () => host.postMessage({
        type: "reveal", comparison, fileId, side: range.side, start: range.start, end: range.end,
    });
    return button;
}

function showDraft() {
    const selection = state.selection;
    get("selection").textContent = selection ? lineLabel(selection.side, selection.start, selection.end) : "";
    get("send").textContent = editingId ? "保存意见" : "添加意见";
    get("discard").hidden = !editingId;
    get("send").disabled = submitting || !note.value.trim() || !(selection || editingId);
}

function thread(opinion, current) {
    const card = element("article", undefined, "thread");
    const header = element("div", undefined, "actions");
    if (current && !opinion.stale) header.append(rangeButton(state.file.id, opinion));
    else header.append(element("span", (current ? "" : opinion.path + " · ") +
        lineLabel(opinion.side, opinion.start, opinion.end), "meta"));
    if (opinion.stale) header.append(element("span", "历史快照", "meta"));
    if (opinion.pending) header.append(element("span", state.updating ? "等待本轮回复" : "待 Agent 回复", "meta"));
    if (!state.historical) {
        const edit = element("button", "编辑", "link");
        edit.type = "button";
        edit.onclick = () => {
            editingId = opinion.id;
            note.value = opinion.text;
            showDraft();
            note.focus();
        };
        header.append(edit);
    }
    card.append(header, element("p", opinion.text));
    for (const reply of opinion.replies) {
        const response = element("div", undefined, "reply");
        const time = new Date(reply.at).toLocaleString();
        response.append(element("strong", "Agent · " + time + (reply.revision === opinion.revision ? "" : " · 编辑前")),
            element("p", reply.text));
        card.append(response);
    }
    return card;
}

function renderList(id, items, render, ...dependencies) {
    // Editor focus changes can send state between pointer down and click.
    const key = JSON.stringify([state.comparison, state.file?.id, items, ...dependencies]);
    if (rendered.get(id) === key) return;
    rendered.set(id, key);
    get(id).replaceChildren(...items.map(render));
}

window.addEventListener("message", event => {
    if (event.data.type === "submitted") {
        submitting = false;
        editingId = undefined;
        note.value = "";
        showDraft();
        return;
    }
    if (event.data.type === "submissionError") {
        submitting = false;
        showDraft();
        return;
    }
    if (event.data.type !== "state") return;
    if (state.comparison && event.data.state.comparison !== state.comparison) {
        editingId = undefined;
        submitting = false;
        note.value = "";
    }
    state = event.data.state;
    get("file-name").textContent = [state.version, state.file?.path].filter(Boolean).join(" · ");
    const summary = get("change-summary");
    summary.classList.toggle("empty", !state.summary.length);
    summary.textContent = state.summary.length ? state.summary.join(" ")
        : !state.file ? "从左侧选择文件。"
            : !state.maxSentences ? "无文本行变更。" : "导出修改澄清需求后生成摘要。";
    get("form").hidden = state.historical;
    get("clarifications-empty").hidden = Boolean(state.points.length);
    get("clarifications-empty").textContent = state.file
        ? "可在左侧导出修改澄清需求。"
        : "";
    renderList("points", state.points, point => {
        const item = element("li");
        if (point.start) item.append(rangeButton(state.file.id, point));
        item.append(element("p", point.text));
        return item;
    });
    renderList("threads", state.opinions, opinion => thread(opinion, true), state.historical, state.updating);
    get("archived").hidden = !state.archived.length;
    renderList("old-threads", state.archived, opinion => thread(opinion, false), state.historical, state.updating);
    showDraft();
});

get("form").addEventListener("submit", event => {
    event.preventDefault();
    if (get("send").disabled) return;
    submitting = true;
    showDraft();
    host.postMessage({ type: "opinion", comparison: state.comparison, selection: state.selection, text: note.value, editingId });
});
get("discard").onclick = () => {
    editingId = undefined;
    note.value = "";
    showDraft();
};
note.addEventListener("input", showDraft);

function resize(percent) {
    const top = Math.max(12, Math.min(72, percent));
    splitter.setAttribute("aria-valuenow", String(Math.round(top)));
    document.body.style.gridTemplateRows = "minmax(36px, " + top + "fr) 7px minmax(75px, " + (100 - top) + "fr)";
    host.setState({ top });
}
splitter.addEventListener("pointerdown", event => splitter.setPointerCapture(event.pointerId));
splitter.addEventListener("pointermove", event => {
    if (splitter.hasPointerCapture(event.pointerId)) resize(event.clientY * 100 / document.body.clientHeight);
});
splitter.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resize(Number(splitter.getAttribute("aria-valuenow")) + (event.key === "ArrowUp" ? -2 : 2));
});
resize(host.getState()?.top || 20);
host.postMessage({ type: "ready" });
