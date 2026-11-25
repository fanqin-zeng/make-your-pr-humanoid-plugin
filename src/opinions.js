"use strict";

const vscode = require("vscode");

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
        const { record, snapshot } = this.review;
        const byFile = new Map();
        for (const opinion of record?.opinions || []) {
            const file = this.review.fileFor(opinion);
            const name = file?.path || opinion.path;
            if (!byFile.has(name)) {
                byFile.set(name, { label: name, id: JSON.stringify([snapshot.token, name]), kind: "file", children: [] });
            }
            const start = opinion.start;
            const lines = start === opinion.end ? String(start) : start + "–" + opinion.end;
            const replies = opinion.replies || [];
            const stale = file?.digest !== opinion.digest;
            const key = snapshot.token + ":" + opinion.id;
            const command = { command: "workspacePrReview.revealOpinion", title: "在评阅详情查看",
                arguments: [snapshot.token, opinion.id] };
            byFile.get(name).children.push({
                id: key, kind: "opinion", label: preview(opinion.text), tooltip: opinion.text, command,
                description: (opinion.side === "old" ? "旧版 " : "新版 ") + lines + " 行"
                    + (stale ? " · 历史位置" : "") + (replies.length ? " · " + replies.length + " 条回复" : ""),
                children: replies.map((reply, index) => ({
                    id: key + ":" + index, kind: "reply", label: preview(reply.text), tooltip: reply.text, command,
                    description: reply.revision === opinion.revision ? "Agent" : "Agent · 编辑前",
                })),
            });
        }
        this.roots = [...byFile.values()];
        this.change.fire();
    }

    getChildren(node) { return node ? node.children || [] : this.roots; }

    getTreeItem(node) {
        const state = node.kind === "file" ? vscode.TreeItemCollapsibleState.Expanded
            : node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.label, state);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon(node.kind === "file" ? "file" : node.kind === "reply" ? "reply" : "comment");
        item.description = node.description;
        item.command = node.command;
        item.tooltip = node.tooltip || node.label;
        return item;
    }

    dispose() { this.change.dispose(); }
}

module.exports = { AllOpinions };
