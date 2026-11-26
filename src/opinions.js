"use strict";

const vscode = require("vscode");
const icons = { version: "history", file: "file", opinion: "comment", reply: "reply" };

function preview(text) {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 160 ? line.slice(0, 159) + "…" : line;
}

class AllOpinions {
    constructor(review) {
        this.review = review;
        this.roots = [];
        this.change = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.change.event;
    }

    refresh() {
        const { data, record, reviewKey } = this.review;
        const history = data?.versions || [];
        this.roots = history.toReversed().map((version, index) =>
            this.versionNode(reviewKey, version, version === record, index === 0));
        this.change.fire();
    }

    versionNode(reviewKey, version, current, latest) {
        const opinions = version.opinions || [];
        const root = {
            id: JSON.stringify([reviewKey, version.number]), kind: "version", label: version.number, expanded: current,
            description: opinions.length + " 条评论" + (latest ? " · 最新" : "") + (current ? " · 当前" : ""),
        };
        const byFile = new Map();
        for (const opinion of opinions) {
            const file = current ? this.review.fileFor(opinion) : undefined;
            const name = file?.path || opinion.path;
            if (!byFile.has(name)) {
                byFile.set(name, { label: name, id: root.id + ":file:" + name, kind: "file", parent: root, children: [] });
            }
            const parent = byFile.get(name);
            const start = opinion.start;
            const lines = start === opinion.end ? String(start) : start + "–" + opinion.end;
            const replies = opinion.replies || [];
            const stale = current && file?.digest !== opinion.digest;
            const key = root.id + ":opinion:" + opinion.id;
            const command = { command: "workspacePrReview.revealOpinion", title: "在评阅详情查看",
                arguments: [reviewKey, version.number, opinion.id] };
            const node = {
                id: key, kind: "opinion", label: preview(opinion.text), tooltip: opinion.text, command, parent,
                description: (opinion.side === "old" ? "旧版 " : "新版 ") + lines + " 行"
                    + (stale ? " · 历史位置" : "") + (replies.length ? " · " + replies.length + " 条回复" : ""),
            };
            node.children = replies.map((reply, index) => ({
                id: key + ":" + index, kind: "reply", label: preview(reply.text), tooltip: reply.text, command, parent: node,
                description: reply.revision === opinion.revision ? "Agent" : "Agent · 编辑前",
            }));
            parent.children.push(node);
        }
        root.children = [...byFile.values()];
        return root;
    }

    getChildren(node) { return node ? node.children || [] : this.roots; }

    getParent(node) { return node.parent; }

    getTreeItem(node) {
        const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
        const state = node.children?.length ? (node.expanded || node.kind === "file" ? Expanded : Collapsed) : None;
        const item = new vscode.TreeItem(node.label, state);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon(icons[node.kind]);
        item.description = node.description;
        item.command = node.command;
        item.tooltip = node.tooltip || node.label;
        return item;
    }

    dispose() { this.change.dispose(); }
}

module.exports = { AllOpinions };
