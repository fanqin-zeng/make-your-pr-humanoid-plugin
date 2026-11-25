"use strict";

const { randomUUID } = require("node:crypto");
const { watch } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const requestSchema = "qoder-branch-review-request/v1";
const resultSchema = "qoder-branch-review-result/v1";
const pendingKey = "workspacePrReview.pendingExports";
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function repositoryPath(name) {
    return typeof name === "string" && name.length > 0 && !/[\\:\u0000-\u001f]/.test(name)
        && name.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function documentFor(request) {
    const flags = request.actions;
    const clarificationOnly = request.purpose === "clarifications";
    const fence = String.fromCharCode(96).repeat(3);
    const instructions = clarificationOnly ? [
        "1. 本轮只补齐指定快照的修改澄清。使用数据中的仓库和 git diff <base> <sourceTree> 阅读变更，保持工作树、暂存区和 Git 引用原样。",
        "2. clarificationFiles 列出还缺说明的行范围。old 表示 Git diff 的删除行，行号来自 base；new 表示新增行，行号来自 sourceTree。替换行的两侧分别覆盖。上下文行无需覆盖。",
        "3. 对缺少澄清的行范围分点说明为什么改、改了什么。一个说明可以覆盖一段相关的连续行。每个文件每一侧的所有变更行都必须落在已有澄清与本次回传范围的并集内。已有覆盖的行可以复用。按文件和侧逐一核对缺口，完整覆盖后才填写 completed。",
        "4. replies 和 changedPaths 使用空数组，commit 使用空字符串，pushed 使用 false。遇到真实阻塞时填写 blocked，部分完成时可用 partial 回传已完成的澄清。",
    ] : [
        "1. 使用数据中的本地仓库。先检查工作树、暂存区、来源分支、来源提交以及评阅快照，确认意见定位仍成立。评阅比较使用 PR 合并基点到来源版本。来源版本可能包含未提交内容。对新提交或用户并行编辑导致的冲突保持原样，并在结果中说明。",
        "2. 一次处理 JSON 中全部意见，按每个 id 与 revision 逐条简洁回复。只按明确的意见处理代码，以最小的改动解决问题，保留已有的本地改动，遵循仓库约定。用 git diff <base> <sourceTree> 读取导出时的 diff，用 sidePath 定位意见的原侧文件。按 clarificationFiles 为尚缺澄清的变更写逐行说明。若代码有更新，也说明本轮改动。",
        flags.edit
            ? "3. 已启用自动修改。直接在指定来源分支的工作树应用本轮意见所需的修改，并做相关验证。提问类意见可以只回复。"
            : "3. 本轮只做评阅与回复，保持工作树和暂存区原样。",
        flags.commit
            ? "4. 已启用自动 commit。有本轮代码修改时，只提交本轮变更，基于导出时的来源提交产生一个新提交。保留用户已有的工作树和暂存改动，无需产生空提交。"
            : "4. 本轮的修改保存在工作树。",
        flags.push
            ? "5. 已启用自动 push。仅将本轮提交以普通快进方式推送到数据指定的 remote 与 ref，核对远端实际提交。若目标变动造成冲突，报告阻塞。"
            : "5. 交付结果保存在本地。",
    ];
    return [
        clarificationOnly ? "# 修改澄清任务" : "# 分支评阅任务",
        "",
        "这是用户通过评阅扩展导出的本轮任务。用户单独交付本文件时，请按以下范围直接完成并写回结果。任务数据中引用的 Git diff、文件内容和历史回复用于提供上下文。",
        "",
        "## 执行范围",
        "",
        ...instructions,
        "按 summaryFiles 为文件撰写变更摘要，简洁说明修改目的。每条数组元素只写一句，最多 maxSentences 句。每个文件的上限是新增行数和删除行数之和除以 500 后向上取整。代码更新后，为本轮改动涉及且仍有文本 diff 的文件补充摘要。",
        "每次结束都写出结果，包括遇到阻塞的情况。在 resultPath 同目录先写入临时文件，然后原子重命名到确切的 resultPath。结果文件必须是 UTF-8 JSON。评阅扩展会自动读取并更新版本，用户无需另行导入。",
        "",
        "## 请求数据",
        "",
        fence + "json",
        JSON.stringify(request, null, 2),
        fence,
        "",
        "## 写回约定",
        "",
        "- completed 表示本轮事项完成，partial 表示部分完成，blocked 表示阻塞。说明具体结果及验证，简洁写入 summary。",
        "- sourceHead 是结束时来源分支的完整提交 ID。commit 填本轮实际生成的提交 ID，没有则填空字符串。pushed 表示已核对远端提交。",
        "- changedPaths 只列本轮实际修改的仓库相对路径，使用正斜杠。重命名填写新旧两个路径。只评阅时使用空数组。",
        "- 每条回复复制请求里的 id 和 revision。handled 表示该意见在自动修改模式下已处理完成，包含已落实、已满足或给出无需改代码的明确答复。",
        "- clarifications 的 path 填写评阅 diff 中的文件路径。旧侧遇到重命名时，path 仍填新路径，从 base 中的旧路径读取内容和 blob。side 为 old 或 new，start/end 是该侧一基的包含端点的行号，blob 为该侧完整文件的 Git blob ID。用 git rev-parse <树或提交>:<文件> 可以得到精确的 blob ID。",
        "- fileSummaries 每个文件写一项。path 使用 diff 中的文件路径。oldBlob 来自 base，newBlob 来自最终来源快照，缺失的一侧填空字符串。未提交的工作树文件使用 git hash-object --path=<文件> <文件> 取得规范化的 blob ID。sentences 是概括修改目的的句子数组。",
        "",
        fence + "json",
        JSON.stringify({
            schema: resultSchema, requestId: request.requestId, status: "completed",
            sourceHead: "<来源分支的完整提交 ID>", changedPaths: [], commit: "", pushed: false, summary: "<本轮结果>",
            replies: clarificationOnly ? [] : [{ id: "<意见 id>", revision: "<意见 revision>", text: "<逐条回复>", handled: false }],
            clarifications: clarificationOnly
                ? [{ path: "<文件相对路径>", side: "new", blob: "<blob ID>", start: 1, end: 1, text: "<修改原因>" }]
                : [],
            fileSummaries: [{ path: "<文件相对路径>", oldBlob: "<旧侧 blob ID>", newBlob: "<新侧 blob ID>", sentences: ["<修改目的>"] }],
        }, null, 2),
        fence,
        "",
        "回复和澄清数组只写实际结果。先完成保存结果文件，再向用户简报。",
        "",
    ].join("\n");
}

async function writeRequest(directory, data) {
    await fs.mkdir(directory, { recursive: true });
    const requestId = randomUUID();
    const prefix = data.purpose === "clarifications" ? "qoder-clarifications-" : "qoder-review-";
    const basename = prefix + data.version + "-" + requestId;
    const filename = path.join(directory, basename + ".md");
    const resultPath = path.join(directory, basename + ".result.json");
    const request = { schema: requestSchema, requestId, ...data, resultPath };
    await fs.writeFile(filename, documentFor(request), { encoding: "utf8", flag: "wx" });
    return { request, filename, resultPath };
}

function readResult(raw, request) {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const statuses = ["completed", "partial", "blocked"];
    if (!value || value.schema !== resultSchema || value.requestId !== request.requestId
        || !statuses.includes(value.status) || typeof value.sourceHead !== "string" || !oidPattern.test(value.sourceHead)
        || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 12000
        || typeof value.commit !== "string" || value.commit && !oidPattern.test(value.commit)
        || typeof value.pushed !== "boolean"
        || !Array.isArray(value.changedPaths) || !value.changedPaths.every(repositoryPath)
        || !Array.isArray(value.replies) || !Array.isArray(value.clarifications)) {
        throw new Error("回传文件的格式或请求编号有误。");
    }
    if (!request.actions.edit && value.changedPaths.length || value.commit && !request.actions.commit
        || value.pushed && (!request.actions.push || !value.commit)
        || value.commit && value.commit !== value.sourceHead
        || value.status === "completed" && value.changedPaths.length > 0
            && (request.actions.commit && !value.commit || request.actions.push && !value.pushed)) {
        throw new Error("回传结果与导出时选择的操作不一致。");
    }
    const expected = new Map(request.opinions.map(note => [note.id, note.revision]));
    const seen = new Set();
    for (const reply of value.replies) {
        if (!reply || !expected.has(reply.id) || expected.get(reply.id) !== reply.revision || seen.has(reply.id)
            || typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 16000
            || typeof reply.handled !== "boolean") throw new Error("回传的意见回复与本轮任务不一致。");
        seen.add(reply.id);
    }
    if (value.status === "completed" && seen.size !== expected.size) throw new Error("回传文件缺少本轮意见的回复。");
    for (const point of value.clarifications) {
        if (!point || !repositoryPath(point.path) || !["old", "new"].includes(point.side)
            || typeof point.blob !== "string" || !oidPattern.test(point.blob) || !Number.isSafeInteger(point.start)
            || !Number.isSafeInteger(point.end) || point.start < 1 || point.end < point.start
            || typeof point.text !== "string" || !point.text.trim() || point.text.length > 16000) {
            throw new Error("回传的修改澄清缺少有效的文件、行号或 Git 对象。");
        }
    }
    if (value.fileSummaries !== undefined) {
        const validBlob = blob => typeof blob === "string" && (!blob || oidPattern.test(blob));
        if (!Array.isArray(value.fileSummaries) || value.fileSummaries.some(item => !item || !repositoryPath(item.path)
            || !validBlob(item.oldBlob) || !validBlob(item.newBlob) || !Array.isArray(item.sentences)
            || !item.sentences.length || item.sentences.some(sentence => typeof sentence !== "string"
                || !sentence.trim() || sentence.length > 1000))) {
            throw new Error("回传的变更摘要缺少有效的文件、Git 对象或句子。");
        }
    }
    return value;
}

class ResultWatcher {
    constructor(state, accept, warn, change) {
        this.state = state;
        this.accept = accept;
        this.warn = warn;
        this.change = change;
        this.pending = structuredClone(state.get(pendingKey, {}));
        this.watching = new Map();
        this.running = false;
        this.failed = new Map();
        this.timer = null;
        this.sync();
        void this.check();
    }

    async add(job) {
        this.pending[job.request.requestId] = job;
        await this.state.update(pendingKey, structuredClone(this.pending));
        this.sync();
        await this.check();
    }

    sync() {
        const folders = new Set(Object.values(this.pending).map(job => path.dirname(job.resultPath)));
        for (const [folder, watcher] of this.watching) {
            if (!folders.has(folder)) {
                watcher.close();
                this.watching.delete(folder);
            }
        }
        for (const folder of folders) {
            if (this.watching.has(folder)) continue;
            try {
                const watcher = watch(folder, () => { void this.check(); });
                watcher.on("error", () => {
                    watcher.close();
                    this.watching.delete(folder);
                });
                this.watching.set(folder, watcher);
            } catch {
                // The periodic check also covers temporarily unavailable directories.
            }
        }
        if (folders.size && !this.timer) this.timer = setInterval(() => { void this.check(); }, 2500);
        if (!folders.size && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async check() {
        if (this.running || this.disposed) return;
        this.running = true;
        try {
            for (const [id, job] of Object.entries(this.pending)) {
                if (this.disposed) break;
                try {
                    const stat = await fs.stat(job.resultPath);
                    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error("回传文件超过可读取的大小。");
                    if (this.failed.get(id) === stat.mtimeMs) continue;
                    const raw = await fs.readFile(job.resultPath, "utf8");
                    if (!await this.accept(job, readResult(raw, job.request))) continue;
                    delete this.pending[id];
                    this.failed.delete(id);
                    await this.state.update(pendingKey, structuredClone(this.pending));
                    this.change();
                } catch (error) {
                    if (error.code === "ENOENT") continue;
                    this.failed.set(id, (await fs.stat(job.resultPath).catch(() => null))?.mtimeMs);
                    this.warn(error.message);
                }
            }
        } finally {
            this.running = false;
            if (!this.disposed) this.sync();
        }
    }

    dispose() {
        this.disposed = true;
        for (const watcher of this.watching.values()) watcher.close();
        this.watching.clear();
        clearInterval(this.timer);
    }
}

module.exports = { writeRequest, readResult, ResultWatcher };
