// CB Editor version: update this value when releasing a new version.
const APP_VERSION = "2.8.24";

let tabs = [];
let activeTabId = null;
let currentWorkspaceMode = "none";
let editorLastPercent = 50;
let currentDirectoryHandle = null;
let workspaceRoots = [];
let workspaceRootExpanded = new Map();
let defaultExtension = "html";
let wrapEnabled = false;
let maxWrapLength = 80;
let wrapLengthUnit = "half";
let previewTextTheme = "light";
let mainPreviewHandle = null;
let previewMode = "default";
let rightClickedItemData = null;
let activeDiagnostics = [];
let dbPromise = null;
let statusTimer = null;
let initialUntitledTabId = null;
let previewUpdateToken = 0;
let previewUpdateTimer = null;
let previewDocumentPath = "";
let localAssetUrlCache = new WeakMap();
let localAssetObjectUrls = new Set();
let localScriptUrlCache = new WeakMap();
let localScriptObjectUrls = new Set();

const editor = document.getElementById("code-editor");
const tabsBar = document.getElementById("tabs-bar");
const fileTree = document.getElementById("file-tree");
const sidebar = document.getElementById("sidebar");
const previewPane = document.getElementById("preview-pane");
const previewFrame = document.getElementById("preview-frame");
const previewConsole = document.getElementById("preview-console");
const previewConsoleOutput = document.getElementById("preview-console-output");
const previewConsoleResizer = document.getElementById("resizer-preview-console");
const terminalPanel = document.getElementById("terminal-panel");
const terminalOutput = document.getElementById("terminal-output");
const terminalForm = document.getElementById("terminal-form");
const terminalInput = document.getElementById("terminal-input");
const resizerSidebar = document.getElementById("resizer-sidebar");
const resizerPreview = document.getElementById("resizer-preview");
const editorPane = document.getElementById("editor-pane");
const lineNumbersWrapper = document.getElementById("line-numbers");
const syntaxHighlight = document.getElementById("syntax-highlight");
const diagnosticsPanel = document.getElementById("diagnostics-panel");
const imageViewerContainer = document.getElementById("image-viewer");
const imageViewerImg = document.getElementById("viewer-img");
const statusMode = document.getElementById("status-mode");
const statusPath = document.getElementById("status-path");
const statusInfo = document.getElementById("status-info");
const statusCount = document.getElementById("status-count");
const statusCountAll = document.getElementById("status-count-all");
const statusMsg = document.getElementById("status-msg");
const codeRunnerFrame = document.getElementById("code-runner-frame");

document.title = `CBE v${APP_VERSION}`;
document.querySelectorAll(".version").forEach((element) => {
    element.textContent = `v${APP_VERSION}`;
});

const DB_NAME = "cb_editor_storage";
const DB_VERSION = 1;
const DB_STORE = "workspace";

function openStorage() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE))
                db.createObjectStore(DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}
async function storageSet(key, value) {
    try {
        const db = await openStorage();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { }
}
async function storageGet(key) {
    try {
        const db = await openStorage();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        return null;
    }
}
async function storageDelete(key) {
    try {
        const db = await openStorage();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).delete(key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { }
}

async function persistWorkspaceHandle() {
    try {
        if (currentWorkspaceMode === "project" && workspaceRoots.length) {
            await storageSet("workspace", {
                mode: "project",
                roots: workspaceRoots.map((r) => ({
                    handle: r.handle,
                    name: r.name,
                    expanded: r.expanded !== false,
                })),
                mainPreviewHandle,
                previewMode,
            });
        } else if (currentWorkspaceMode === "file") {
            const t = tabs.find((x) => x.id === activeTabId);
            if (t && t.handle)
                await storageSet("workspace", { mode: "file", handle: t.handle });
        }
    } catch (e) {
        console.warn("workspace persistence failed", e);
    }
}
async function restoreWorkspace() {
    const saved = await storageGet("workspace");
    if (!saved) return;
    let permissionRequired = false;
    try {
        if (
            saved.mode === "project" &&
            Array.isArray(saved.roots) &&
            saved.roots.length
        ) {
            workspaceRoots = [];
            for (const r of saved.roots) {
                if (!r?.handle) continue;
                const permission = await r.handle.queryPermission({ mode: "readwrite" });
                if (permission === "granted")
                    workspaceRoots.push({
                        handle: r.handle,
                        name: r.name || r.handle.name,
                        expanded: r.expanded !== false,
                    });
                else permissionRequired = true;
            }
            if (workspaceRoots.length) {
                currentDirectoryHandle = workspaceRoots[0].handle;
                currentWorkspaceMode = "project";
                workspaceRoots.forEach((r) =>
                    workspaceRootExpanded.set(r.handle, r.expanded !== false),
                );
                await refreshExplorerSync();
                updateUI();
                showStatusMessage("前回のワークスペースを復元しました");
                return;
            }
        }
        if (permissionRequired) {
            showStatusMessage("前回のフォルダーは、メニューから再接続してください");
            return;
        }
        if (saved.mode === "project" && saved.handle) {
            const permission = await saved.handle.queryPermission({
                mode: "readwrite",
            });
            if (permission === "granted") {
                workspaceRoots = [
                    { handle: saved.handle, name: saved.handle.name, expanded: true },
                ];
                currentDirectoryHandle = saved.handle;
                currentWorkspaceMode = "project";
                await refreshExplorerSync();
                updateUI();
                showStatusMessage("前回のワークスペースを復元しました");
                return;
            }
            showStatusMessage("前回のフォルダーは、メニューから再接続してください");
            return;
        }
        if (saved.mode === "file" && saved.handle) {
            const permission = await saved.handle.queryPermission({
                mode: "readwrite",
            });
            if (permission === "granted") {
                const file = await saved.handle.getFile(),
                    isImg = isImageName(file.name);
                const t = makeTab(
                    saved.handle,
                    file.name,
                    isImg ? "" : await file.text(),
                    isImg,
                    isImg ? URL.createObjectURL(file) : null,
                );
                tabs.push(t);
                currentWorkspaceMode = "file";
                switchTab(t.id);
                fileTree.innerHTML =
                    '<div class="tree-placeholder">単体ファイルモード</div>';
                updateUI();
                showStatusMessage("前回のファイルを復元しました");
                return;
            }
            showStatusMessage("前回のファイルは、メニューから再接続してください");
            return;
        }
    } catch (e) {
        console.warn("workspace restore failed", e);
        showStatusMessage("前回のワークスペースを再接続してください");
        return;
    }
}
async function openDirectoryAsWorkspace(handle) {
    workspaceRoots = [{ handle, name: handle.name, expanded: true }];
    workspaceRootExpanded = new Map([[handle, true]]);
    currentDirectoryHandle = handle;
    currentWorkspaceMode = "project";
    await persistWorkspaceHandle();
    await refreshExplorerSync();
    updateUI();
}
async function addWorkspaceFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
        alert("このブラウザはフォルダー選択に対応していません。");
        return false;
    }
    try {
        showStatusMessage("フォルダー選択ダイアログを開いています...");
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        for (const r of workspaceRoots) {
            try {
                if (await r.handle.isSameEntry(handle)) {
                    showStatusMessage("そのフォルダーは既に追加されています");
                    return false;
                }
            } catch (e) { }
        }
        workspaceRoots.push({ handle, name: handle.name, expanded: true });
        workspaceRootExpanded.set(handle, true);
        currentDirectoryHandle = workspaceRoots[0]?.handle || handle;
        currentWorkspaceMode = "project";
        await persistWorkspaceHandle();
        await refreshExplorerSync();
        updateUI();
        showStatusMessage(`「${handle.name}」をワークスペースに追加しました`);
        return true;
    } catch (e) {
        if (e?.name !== "AbortError")
            alert("フォルダーの追加に失敗しました。\n" + (e?.message || e));
        return false;
    }
}
async function saveWorkspaceFile() {
    if (!workspaceRoots.length) {
        alert("先にワークスペースを開いてください。");
        return false;
    }
    try {
        const payload = {
            version: 1,
            name:
                workspaceRoots.length === 1 ? workspaceRoots[0].name : "CB Workspace",
            folders: workspaceRoots.map((r) => ({ name: r.name })),
        };
        const handle = await window.showSaveFilePicker({
            suggestedName: `${payload.name}.code-workspace`,
            types: [
                {
                    description: "CB Editor Workspace",
                    accept: { "application/json": [".code-workspace"] },
                },
            ],
        });
        await writeFileAtomically(handle, JSON.stringify(payload, null, 2));
        showStatusMessage("ワークスペース設定を保存しました");
        return true;
    } catch (e) {
        if (e?.name !== "AbortError")
            alert("ワークスペースの保存に失敗しました。\n" + (e?.message || e));
        return false;
    }
}
function isImageName(name) {
    return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(name);
}
function makeId(prefix = "file") {
    return (
        prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9)
    );
}
function makeTab(handle, name, content = "", isImage = false, imageUrl = null) {
    return {
        id: makeId(),
        name,
        content,
        isModified: false,
        handle,
        isImage,
        imageUrl,
    };
}
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function span(cls, text) {
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function highlightCode(code, name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (["html", "htm", "xhtml", "xml", "svg", "xsl", "xslt"].includes(ext))
        return highlightHTML(code);
    if (["css", "scss", "sass", "less"].includes(ext)) return highlightCSS(code);
    if (
        [
            "js",
            "mjs",
            "cjs",
            "jsx",
            "ts",
            "tsx",
            "java",
            "c",
            "h",
            "cpp",
            "cc",
            "cxx",
            "hpp",
            "cs",
            "php",
            "go",
            "rs",
            "swift",
            "kt",
            "kts",
            "dart",
            "py",
            "rb",
            "lua",
            "sh",
            "bash",
            "bat",
            "cmd",
            "ps1",
            "sql",
        ].includes(ext)
    )
        return highlightJS(code, ext);
    if (["json", "jsonc"].includes(ext)) return highlightJSON(code);
    if (["md", "markdown"].includes(ext)) return highlightMarkdown(code);
    if (["yaml", "yml", "toml", "ini", "conf", "env"].includes(ext))
        return highlightConfig(code);
    return escapeHtml(code);
}
function highlightConfig(code) {
    let out = escapeHtml(code);
    out = out.replace(
        /(^|\n)(\s*[#;].*)/g,
        '$1<span class="tok-comment">$2</span>',
    );
    out = out.replace(
        /(^|\n)(\s*)([A-Za-z_][\w.-]*)(\s*:|\s*=)/g,
        '$1$2<span class="tok-property">$3</span>$4',
    );
    out = out.replace(
        /(["'`])([^"'`\n]*?)\1/g,
        '<span class="tok-string">$1$2$1</span>',
    );
    out = out.replace(
        /\b(?:true|false|null|yes|no|on|off)\b/gi,
        '<span class="tok-keyword">$&</span>',
    );
    out = out.replace(
        /\b-?\d+(?:\.\d+)?\b/g,
        '<span class="tok-number">$&</span>',
    );
    return out;
}
function tokenizeJS(code, ext) {
    const tokenRe =
        /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`])*`|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\/(?:\\.|[^\/\n\\])+\/[gimsuy]*|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|try|catch|finally|throw|async|await|typeof|instanceof|in|of|this|true|false|null|undefined|delete|void|yield|import|export|from|default|new)\b|[A-Za-z_$][\w$]*|===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\+=|-=|\*=|\/=|%=|[+\-*\/%=<>!&|?:~^])/g;
    let out = "",
        last = 0,
        m;
    while ((m = tokenRe.exec(code))) {
        out += escapeHtml(code.slice(last, m.index));
        const x = m[0];
        if (/^\/\//.test(x) || /^\/\*/.test(x)) out += span("tok-comment", x);
        else if (/^['"`"]/.test(x)) out += span("tok-string", x);
        else if (/^\/(?:\\.|[^\/\n\\])+\/[gimsuy]*$/.test(x))
            out += span("tok-regex", x);
        else if (/^\d/.test(x)) out += span("tok-number", x);
        else if (
            /^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|try|catch|finally|throw|async|await|typeof|instanceof|in|of|this|true|false|null|undefined|delete|void|yield|import|export|from|default)$/.test(
                x,
            )
        )
            out += span("tok-keyword", x);
        else if (/^[A-Za-z_$]/.test(x)) {
            const rest = code.slice(tokenRe.lastIndex);
            if (/^\s*\(/.test(rest)) out += span("tok-function", x);
            else if (/^\s*:/.test(rest)) out += span("tok-property", x);
            else if (/[A-Z]/.test(x[0])) out += span("tok-object", x);
            else out += span("tok-variable", x);
        } else if (/^[()[\]{}]$/.test(x)) out += span("tok-bracket", x);
        else out += span("tok-operator", x);
        last = tokenRe.lastIndex;
    }
    return out + escapeHtml(code.slice(last));
}
function highlightJS(code, ext) {
    return tokenizeJS(code, ext);
}

function highlightJSON(code) {
    const re =
        /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}\[\],:])/g;
    let out = "",
        last = 0,
        m;
    while ((m = re.exec(code))) {
        out += escapeHtml(code.slice(last, m.index));
        const x = m[0];
        if (/^\/\//.test(x) || /^\/\*/.test(x)) out += span("tok-comment", x);
        else if (/^"/.test(x))
            out += span(/:\s*$/.test(x) ? "tok-property" : "tok-string", x);
        else if (/^(true|false|null)$/.test(x)) out += span("tok-keyword", x);
        else if (/^-?\d/.test(x)) out += span("tok-number", x);
        else out += span("tok-bracket", x);
        last = re.lastIndex;
    }
    return out + escapeHtml(code.slice(last));
}
function highlightCSS(code) {
    let out = escapeHtml(code);
    out = out.replace(
        /(\/\*[\s\S]*?\*\/)/g,
        '<span class="tok-comment">$1</span>',
    );
    out = out.replace(
        /(&quot;(?:\\.|[^&quot;])*?&quot;|&#39;(?:\\.|[^&#39;])*?&#39;)/g,
        '<span class="tok-string">$1</span>',
    );
    out = out.replace(
        /(^|[{}\s;])([a-zA-Z-]+)(?=\s*:)/g,
        '$1<span class="tok-property">$2</span>',
    );
    out = out.replace(
        /(^|[}\s,])(\.[\w-]+|#[\w-]+|::?[\w-]+)/g,
        '$1<span class="tok-selector">$2</span>',
    );
    out = out.replace(
        /\b(\d+(?:\.\d+)?)(px|em|rem|%|vh|vw|s|ms)?\b/g,
        '<span class="tok-number">$1$2</span>',
    );
    return out;
}
function highlightHTML(code) {
    let out = "",
        pos = 0,
        re = /\x3C!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>/gi,
        m;
    while ((m = re.exec(code))) {
        out += escapeHtml(code.slice(pos, m.index));
        const x = m[0];
        if (/^\x3C!--/.test(x)) out += span("tok-comment", x);
        else if (/^<!DOCTYPE/i.test(x)) out += span("tok-doctype", x);
        else {
            const h = escapeHtml(x)
                .replace(
                    /(&lt;\/?)([A-Za-z][\w:-]*)/g,
                    '$1<span class="tok-tag">$2</span>',
                )
                .replace(
                    /([A-Za-z_:][-A-Za-z0-9_:.]*)(=)(&quot;.*?&quot;|&#39;.*?&#39;)/g,
                    '<span class="tok-attr">$1</span>$2<span class="tok-string">$3</span>',
                );
            out += h;
        }
        pos = re.lastIndex;
    }
    return out + escapeHtml(code.slice(pos));
}
function highlightMarkdown(code) {
    let out = escapeHtml(code);
    out = out.replace(
        /^(#{1,6})\s+(.*)$/gm,
        '<span class="tok-markdown">$1 $2</span>',
    );
    out = out.replace(/(`[^`\n]+`)/g, '<span class="tok-string">$1</span>');
    out = out.replace(
        /(\*\*[^*\n]+\*\*|__[^_\n]+__)/g,
        '<span class="tok-function">$1</span>',
    );
    out = out.replace(
        /(^|\n)(\s*[-*+]\s)/g,
        '$1<span class="tok-keyword">$2</span>',
    );
    return out;
}

function renderMarkdownInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '<strong>$1$2</strong>');
    out = out.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, '<em>$1$2</em>');
    out = out.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
        const safeHref = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
        return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${label}</a>`;
    });
    return out;
}

function renderMarkdown(code) {
    const lines = String(code).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];
    let quoteLines = [];
    let codeLines = [];
    let codeLanguage = "";

    const flushParagraph = () => {
        if (paragraph.length) {
            blocks.push(`<p>${paragraph.map(renderMarkdownInline).join("<br>")}</p>`);
            paragraph = [];
        }
    };
    const flushList = () => {
        if (!listItems.length) return;
        blocks.push(`<${listType}>${listItems.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</${listType}>`);
        listType = null;
        listItems = [];
    };
    const flushQuote = () => {
        if (!quoteLines.length) return;
        blocks.push(`<blockquote>${quoteLines.map(renderMarkdownInline).join("<br>")}</blockquote>`);
        quoteLines = [];
    };
    const flushCode = () => {
        if (!codeLines.length) return;
        const language = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
        blocks.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        codeLanguage = "";
    };

    let inCode = false;
    for (const line of lines) {
        const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
        if (fence) {
            if (inCode) flushCode();
            else {
                flushParagraph();
                flushList();
                flushQuote();
                codeLanguage = fence[1];
            }
            inCode = !inCode;
            continue;
        }
        if (inCode) {
            codeLines.push(line);
            continue;
        }

        const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
        const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        const quote = line.match(/^\s*>\s?(.*)$/);
        if (heading) {
            flushParagraph();
            flushList();
            flushQuote();
            blocks.push(`<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`);
        } else if (unordered || ordered) {
            flushParagraph();
            flushQuote();
            const nextType = unordered ? "ul" : "ol";
            if (listType && listType !== nextType) flushList();
            listType = nextType;
            listItems.push((unordered || ordered)[1]);
        } else if (quote) {
            flushParagraph();
            flushList();
            quoteLines.push(quote[1]);
        } else if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
            flushParagraph();
            flushList();
            flushQuote();
            blocks.push("<hr>");
        } else if (!line.trim()) {
            flushParagraph();
            flushList();
            flushQuote();
        } else {
            flushList();
            flushQuote();
            paragraph.push(line);
        }
    }
    if (inCode) flushCode();
    flushParagraph();
    flushList();
    flushQuote();
    return blocks.join("") || "<p class=\"markdown-empty\">プレビューする内容がありません</p>";
}

function updateSyntaxHighlight() {
    if (!syntaxHighlight || !editor) return;
    const t = tabs.find((x) => x.id === activeTabId);
    syntaxHighlight.innerHTML =
        t && !t.isImage ? highlightCode(editor.value, t.name) : "";
    syntaxHighlight.classList.toggle("wrap-on", wrapEnabled);
    syntaxHighlight.scrollTop = editor.scrollTop;
    syntaxHighlight.scrollLeft = editor.scrollLeft;
}

function getJSPosition(error, source) {
    let line = 1,
        col = 1;
    if (error && Number.isFinite(error.lineNumber)) line = error.lineNumber;
    if (error && Number.isFinite(error.columnNumber)) col = error.columnNumber;
    if ((!error || !error.lineNumber) && error && error.stack) {
        const m = String(error.stack).match(/<anonymous>:(\d+):(\d+)/);
        if (m) {
            line = Number(m[1]);
            col = Number(m[2]);
        }
    }
    if (error && error.message) {
        const m = String(error.message).match(/line\s*(\d+).*column\s*(\d+)/i);
        if (m) {
            line = Number(m[1]);
            col = Number(m[2]);
        }
    }
    return { line, col };
}
function validateCode(code, name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    const diagnostics = [];
    if (["js", "mjs", "cjs"].includes(ext)) {
        try {
            new Function(code);
        } catch (e) {
            const p = getJSPosition(e, code);
            let line = p.line,
                col = p.col;
            if (!e.lineNumber && e.message) {
                const near = String(e.message).match(/at line (\d+)/i);
                if (near) line = Number(near[1]);
            }
            diagnostics.push({
                severity: "error",
                line,
                col,
                message: e.message || "JavaScriptの構文エラー",
            });
        }
    } else if (ext === "json") {
        try {
            JSON.parse(code);
        } catch (e) {
            const m = String(e.message).match(/position (\d+)/i);
            let line = 1,
                col = 1;
            if (m) {
                const pos = Number(m[1]),
                    before = code.slice(0, pos);
                line = before.split("\n").length;
                col = before.length - before.lastIndexOf("\n");
            }
            diagnostics.push({
                severity: "error",
                line,
                col,
                message: e.message || "JSONの構文エラー",
            });
        }
    } else if (ext === "css") {
        try {
            const sheet = new CSSStyleSheet();
            if (typeof sheet.replaceSync === "function") sheet.replaceSync(code);
        } catch (e) {
            diagnostics.push({
                severity: "error",
                line: 1,
                col: 1,
                message: e.message || "CSSの構文エラー",
            });
        }
    } else if (["html", "htm"].includes(ext)) {
        const parser = new DOMParser(),
            doc = parser.parseFromString(code, "text/html");
        const parserError = doc.querySelector("parsererror");
        if (parserError)
            diagnostics.push({
                severity: "error",
                line: 1,
                col: 1,
                message: parserError.textContent || "HTMLを解析できませんでした",
            });
    }
    return diagnostics;
}
function renderDiagnostics(diagnostics) {
    activeDiagnostics = diagnostics || [];
    const lines = new Set(
        activeDiagnostics.filter((d) => d.line > 0).map((d) => d.line),
    );
    lineNumbersWrapper.innerHTML = "";
    lineNumbersWrapper.innerHTML = buildLineNumbers(lines);
    if (!diagnosticsPanel) return;
    if (!activeDiagnostics.length) {
        diagnosticsPanel.style.display = "none";
        return;
    }
    diagnosticsPanel.innerHTML = activeDiagnostics
        .map(
            (d) =>
                `<div class="diagnostic-item"><span>●</span><span class="diag-pos">行 ${d.line}, 列 ${d.col || 1}</span><span>${escapeHtml(d.message)}</span></div>`,
        )
        .join("");
    diagnosticsPanel.style.display = "block";
}
function runDiagnostics() {
    const t = tabs.find((x) => x.id === activeTabId);
    if (!t || t.isImage) {
        renderDiagnostics([]);
        return;
    }
    renderDiagnostics(validateCode(editor.value, t.name));
}
function updateEditorVisuals() {
    updateSyntaxHighlight();
    runDiagnostics();
}
function updateLineNumbersBase() {
    if (activeDiagnostics.length) {
        renderDiagnostics(activeDiagnostics);
        return;
    }
    lineNumbersWrapper.innerHTML = buildLineNumbers();
    lineNumbersWrapper.scrollTop = editor.scrollTop;
}
function getWrappedLineCount(line) {
    if (!wrapEnabled) return 1;
    const limit = Math.max(1, Number(maxWrapLength) || 80);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = getComputedStyle(editor).font;
    const unitWidth = context.measureText("0").width;
    const targetWidth =
        wrapLengthUnit === "half"
            ? limit * unitWidth
            : limit * context.measureText("あ").width;
    let width = 0;
    let rows = 1;
    for (const character of line) {
        const characterWidth = character === "\t"
            ? unitWidth * 4
            : context.measureText(character).width;
        width += characterWidth;
        if (width > targetWidth) {
            rows++;
            width = characterWidth;
        }
    }
    return rows;
}
function buildLineNumbers(errorLines = new Set()) {
    const sourceLines = editor.value.split("\n");
    const displayLines = [];
    sourceLines.forEach((line, index) => {
        const lineNumber = index + 1;
        displayLines.push(
            errorLines.has(lineNumber)
                ? `<span class="line-error">${lineNumber}</span>`
                : `${lineNumber}`,
        );
        for (let row = 1; row < getWrappedLineCount(line); row++)
            displayLines.push("");
    });
    return displayLines.join("\n");
}
function updateLineNumbers() {
    updateLineNumbersBase();
}

function syncEditorScroll() {
    lineNumbersWrapper.scrollTop = editor.scrollTop;
    if (syntaxHighlight) {
        syntaxHighlight.scrollTop = editor.scrollTop;
        syntaxHighlight.scrollLeft = editor.scrollLeft;
    }
}
editor.addEventListener("scroll", syncEditorScroll);

function applyWrapStyles() {
    editor.classList.toggle("wrap-on", wrapEnabled);
    syntaxHighlight.classList.toggle("wrap-on", wrapEnabled);
    const limit = Math.max(1, Number(maxWrapLength) || 80);
    const width = wrapEnabled
        ? `calc(${limit}${wrapLengthUnit === "half" ? "ch" : "em"} + 24px)`
        : "";
    editor.style.setProperty("--wrap-width", width || "none");
    syntaxHighlight.style.setProperty("--wrap-width", width || "none");
}
function leadingIndent(text) {
    const line = text.split("\n").pop() || "";
    return (line.match(/^[ \t]*/) || [""])[0];
}
function replaceEditorRange(start, end, replacement, caretStart, caretEnd = caretStart) {
    editor.setRangeText(replacement, start, end, "preserve");
    editor.selectionStart = caretStart;
    editor.selectionEnd = caretEnd;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
}
function smartOpenBrace() {
    const st = editor.selectionStart,
        en = editor.selectionEnd,
        sel = editor.value.slice(st, en);
    const r = "{" + sel + "}";
    replaceEditorRange(st, en, r, st + 1, st + 1 + sel.length);
}
function smartOpenParenthesis() {
    const st = editor.selectionStart,
        en = editor.selectionEnd,
        sel = editor.value.slice(st, en);
    const r = "(" + sel + ")";
    replaceEditorRange(st, en, r, st + 1, st + 1 + sel.length);
}
function smartEnter() {
    const st = editor.selectionStart,
        en = editor.selectionEnd,
        before = editor.value.slice(0, st),
        after = editor.value.slice(en),
        indent = leadingIndent(before);
    const trimmed = before.trimEnd(),
        prev = trimmed.slice(-1),
        next = after.trimStart().charAt(0);
    if (prev === "{" && next === "}") {
        const inserted = "\n" + indent + "\t\n" + indent;
        const caret = st + 1 + indent.length + 1;
        replaceEditorRange(st, en, inserted, caret);
    } else {
        const add = prev === "{" ? "\t" : "";
        const inserted = "\n" + indent + add;
        replaceEditorRange(st, en, inserted, st + inserted.length);
    }
}
function updateLineColumn() {
    const text = editor.value,
        pos = editor.selectionStart || 0,
        before = text.substring(0, pos).split("\n");
    statusInfo.textContent = `行 ${before.length}, 列 ${before[before.length - 1].length + 1}`;
    statusCountAll.textContent = `改行込: ${text.length}`;
    statusCount.textContent = `改行無: ${text.replace(/\r?\n/g, "").length}`;
}
function showStatusMessage(msg) {
    statusMsg.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (statusMsg.textContent = ""), 2500);
}
function appendPreviewConsoleEntry(level, args) {
    if (!previewConsoleOutput) return;
    const entry = document.createElement("div");
    entry.className = `preview-console-entry ${level}`;
    entry.textContent = args.join(" ");
    previewConsoleOutput.appendChild(entry);
    previewConsoleOutput.scrollTop = previewConsoleOutput.scrollHeight;
}
function executeEditorCode() {
    const tab = tabs.find((item) => item.id === activeTabId);
    const extension = (tab?.name.split(".").pop() || "").toLowerCase();

    if (!tab || !["js", "mjs", "cjs"].includes(extension)) {
        showStatusMessage("JavaScriptファイルを開いてください");
        return;
    }

    // ターミナルを開く
    terminalPanel.classList.add("open");
    document.getElementById("btn-toggle-terminal").classList.add("active");


    const source = editor.value.replace(/<\/script/gi, "<\\/script");

    codeRunnerFrame.srcdoc = `<script>
        (() => {
            const stringify = (value) => {
                try {
                    return typeof value === "string"
                        ? value
                        : JSON.stringify(value);
                } catch (_) {
                    return String(value);
                }
            };

            const send = (level, values) => {
                parent.postMessage({
                    source: "cb-code-runner-console",
                    level,
                    args: Array.from(values, stringify)
                }, "*");
            };

            ["log", "info", "warn", "error"].forEach((level) => {
                console[level] = (...values) => send(level, values);
            });

            try {
                new Function(${JSON.stringify(source)})();
            } catch (error) {
                send("error", [
                    error?.stack || error?.message || String(error)
                ]);
            }
        })();
    <\/script>`;

    showStatusMessage("JavaScriptを実行しました");
}
function appendTerminalLine(text, isError = false) {
    if (!terminalOutput) return;
    const line = document.createElement("div");
    if (isError) line.className = "terminal-error";
    line.textContent = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}
function executeTerminalCommand(command) {
    const value = command.trim();
    if (!value) return;
    appendTerminalLine(`> ${value}`);
    if (value === "clear") {
        terminalOutput.replaceChildren();
        return;
    }
    if (value === "help") {
        appendTerminalLine("help    利用できるコマンドを表示");
        appendTerminalLine("clear   ターミナルを消去");
        appendTerminalLine("version CB Editor のバージョンを表示");
        appendTerminalLine("preview ライブプレビュー Console を開く");
        return;
    }
    if (value === "version") {
        appendTerminalLine(document.querySelector(".version")?.textContent || "CB Editor");
        return;
    }
    if (value === "preview") {
        appendTerminalLine("ライブプレビューの Console を開きました");
        return;
    }
    appendTerminalLine(`コマンドを認識できません: ${value}`, true);
}
window.addEventListener("message", (event) => {
    if (
        event.source !== previewFrame.contentWindow &&
        event.source !== codeRunnerFrame.contentWindow
    )
        return;
    const data = event.data;
    if (!data) return;
    if (data.source === "cb-preview-console") {
        appendPreviewConsoleEntry(data.level || "log", data.args || []);
        return;
    }
    if (data.source === "cb-code-runner-console") {
        const level = data.level || "log";
        const args = data.args || [];

        appendTerminalLine(
            `[${level}] ${args.join(" ")}`,
            level === "error"
        );

        return;
    }
    if (data.source === "cb-preview-navigation") navigatePreview(data.href);
});

function sortEntries(entries) {
    return entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name, "ja", {
            numeric: true,
            sensitivity: "base",
        });
    });
}
function fileTypeLabel(name) {
    const e = (name.split(".").pop() || "").toLowerCase();
    const m = {
        js: "JS",
        mjs: "JS",
        cjs: "JS",
        jsx: "JS",
        ts: "TS",
        tsx: "TS",
        html: "<>",
        htm: "<>",
        css: "#",
        scss: "#",
        sass: "#",
        less: "#",
        json: "{}",
        md: "MD",
        markdown: "MD",
        xml: "XML",
        svg: "SVG",
        py: "PY",
        java: "JAVA",
        c: "C",
        cpp: "C++",
        h: "C",
        hpp: "C++",
        cs: "C#",
        php: "PHP",
        go: "GO",
        rs: "RS",
        swift: "SW",
        kt: "KT",
        sql: "SQL",
        yaml: "YML",
        yml: "YML",
        txt: "TXT",
    };
    return m[e] || e.toUpperCase() || "FILE";
}
async function refreshExplorerSync() {
    if (currentWorkspaceMode !== "project" || !workspaceRoots.length) return;
    fileTree.innerHTML = "";
    async function renderDirectory(handle, parentNode, depth = 0) {
        const entries = [];
        for await (const entry of handle.values()) entries.push(entry);
        sortEntries(entries);
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "tree-placeholder";
            empty.textContent = "フォルダーは空です";
            parentNode.appendChild(empty);
            return;
        }
        for (const entry of entries) {
            const container = document.createElement("div");
            const item = document.createElement("div");
            item.className = "tree-item";
            item.draggable = true;
            const bind = {
                name: entry.name,
                kind: entry.kind,
                handle: entry,
                parentHandle: handle,
            };
            const active = tabs.find((x) => x.id === activeTabId);
            if (active?.handle) {
                try {
                    if (await entry.isSameEntry(active.handle))
                        item.classList.add("active");
                } catch (e) { }
            }
            if (entry.kind === "file") {
                item.innerHTML = `<div class="tree-item-label"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span class="file-type-badge ${escapeHtml((entry.name.split(".").pop() || "").toLowerCase())}">${escapeHtml(fileTypeLabel(entry.name))}</span><span>${escapeHtml(entry.name)}</span></div><div class="tree-item-actions"><button class="tree-action-sub-btn btn-ren" title="名前変更">✎</button><button class="tree-action-sub-btn btn-del" title="削除">×</button></div>`;
                item.querySelector(".tree-item-label").onclick = () => openEntry(entry);
                container.appendChild(item);
            } else {
                item.innerHTML = `<div class="tree-item-label"><span class="tree-toggle-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg><span>${escapeHtml(entry.name)}</span></div><div class="tree-item-actions"><button class="tree-action-sub-btn btn-ren" title="名前変更">✎</button><button class="tree-action-sub-btn btn-del" title="削除">×</button></div>`;
                const sub = document.createElement("div");
                sub.style.paddingLeft = "14px";
                sub.style.display = "none";
                item.querySelector(".tree-item-label").onclick = async () => {
                    const hidden = sub.style.display === "none";
                    sub.style.display = hidden ? "block" : "none";
                    item
                        .querySelector(".tree-toggle-icon")
                        ?.classList.toggle("collapsed", !hidden);
                };
                container.append(item, sub);
                await renderDirectory(entry, sub, depth + 1);
            }
            item.addEventListener("dragstart", (e) => {
                e.stopPropagation();
                window.activeDragData = bind;
                e.dataTransfer.effectAllowed = "move";
            });
            item.addEventListener("dragover", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!window.activeDragData || bind.kind !== "directory") return;
                const src = window.activeDragData;
                const bad =
                    src.handle === bind.handle ||
                    (await isDescendantOrSelf(src.handle, bind.handle));
                item.classList.toggle("drop-not-allowed", bad);
                item.classList.toggle("drag-over", !bad);
                e.dataTransfer.dropEffect = bad ? "none" : "move";
            });
            item.addEventListener("dragleave", () =>
                item.classList.remove("drag-over", "drop-not-allowed"),
            );
            item.addEventListener("drop", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove("drag-over", "drop-not-allowed");
                if (window.activeDragData)
                    await executeMoveProcess(
                        window.activeDragData,
                        bind.kind === "directory" ? bind.handle : bind.parentHandle,
                    );
            });
            item.querySelector(".btn-ren").onclick = (e) => {
                e.stopPropagation();
                executeRenameUI(bind);
            };
            item.querySelector(".btn-del").onclick = (e) => {
                e.stopPropagation();
                executeDeleteUI(bind);
            };
            item.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showContextMenuFor(bind, e.clientX, e.clientY);
            };
            parentNode.appendChild(container);
        }
    }
    for (const root of workspaceRoots) {
        const rootWrap = document.createElement("div");
        const header = document.createElement("div");
        header.className = "workspace-root-header";
        header.innerHTML = `<svg class="root-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h6l2 2h10v10H3z"></path></svg><span>${escapeHtml(root.name)}</span><div class="workspace-root-actions"><button class="root-new-file" title="新しいファイル">＋</button><button class="root-new-folder" title="新しいフォルダー">📁</button><button class="root-remove" title="ワークスペースから外す">×</button></div>`;
        const sub = document.createElement("div");
        sub.style.paddingLeft = "8px";
        const expanded = workspaceRootExpanded.get(root.handle) !== false;
        sub.style.display = expanded ? "block" : "none";
        header.onclick = (e) => {
            if (e.target.closest("button")) return;
            const open = sub.style.display === "none";
            sub.style.display = open ? "block" : "none";
            workspaceRootExpanded.set(root.handle, open);
            root.expanded = open;
            persistWorkspaceHandle();
        };
        header.querySelector(".root-new-file").onclick = (e) => {
            e.stopPropagation();
            createFileInDirectory(root.handle);
        };
        header.querySelector(".root-new-folder").onclick = (e) => {
            e.stopPropagation();
            createFolderInDirectory(root.handle);
        };
        header.querySelector(".root-remove").onclick = async (e) => {
            e.stopPropagation();
            if (workspaceRoots.length === 1) {
                showStatusMessage(
                    "最後のフォルダーは外せません。ワークスペースを閉じてください。",
                );
                return;
            }
            if (confirm(`「${root.name}」をワークスペースから外しますか？`)) {
                workspaceRoots = workspaceRoots.filter((r) => r !== root);
                workspaceRootExpanded.delete(root.handle);
                currentDirectoryHandle = workspaceRoots[0].handle;
                await persistWorkspaceHandle();
                await refreshExplorerSync();
                updateUI();
            }
        };
        rootWrap.append(header, sub);
        fileTree.appendChild(rootWrap);
        await renderDirectory(root.handle, sub, 0);
    }
    renderOpenedEditorsSection();
}
async function openEntry(entry) {
    try {
        let existing = tabs.find(
            (t) => t.handle && entry && t.handle && t.handle === entry,
        );
        if (!existing) {
            for (const t of tabs) {
                if (t.handle) {
                    try {
                        if (await t.handle.isSameEntry(entry)) {
                            existing = t;
                            break;
                        }
                    } catch (e) { }
                }
            }
        }
        if (existing) {
            switchTab(existing.id);
            return;
        }

        const file = await entry.getFile();
        const img = isImageName(entry.name);
        const content = img ? "" : await file.text();
        const imageUrl = img ? URL.createObjectURL(file) : null;
        const t = makeTab(entry, entry.name, content, img, imageUrl);

        tabs.push(t);
        currentWorkspaceMode = "project";

        switchTab(t.id);
        updateUI();

        try {
            await persistWorkspaceHandle();
        } catch (e) {
            console.warn("workspace persistence after open failed", e);
        }
        try {
            await refreshExplorerSync();
        } catch (e) {
            console.warn("explorer refresh after open failed", e);
        }
    } catch (e) {
        alert("ファイルを開けませんでした: " + (e?.message || e));
    }
}

async function isDescendantOrSelf(srcHandle, destHandle) {
    try {
        if (await srcHandle.isSameEntry(destHandle)) return true;
    } catch (e) { }
    if (srcHandle.kind !== "directory") return false;
    try {
        for await (const entry of srcHandle.values()) {
            if (
                entry.kind === "directory" &&
                (await isDescendantOrSelf(entry, destHandle))
            )
                return true;
        }
    } catch (e) { }
    return false;
}
async function copyFileAsync(srcHandle, destDirHandle, newName) {
    const file = await srcHandle.getFile(),
        contents = await file.arrayBuffer();
    const newFileHandle = await destDirHandle.getFileHandle(newName, {
        create: true,
    });
    const writable = await newFileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
    return newFileHandle;
}
async function copyDirectoryRecursiveAsync(
    srcDirHandle,
    destParentDirHandle,
    newName,
) {
    const newDir = await destParentDirHandle.getDirectoryHandle(newName, {
        create: true,
    });
    const entries = [];
    for await (const e of srcDirHandle.values()) entries.push(e);
    for (const e of entries) {
        if (e.kind === "file") await copyFileAsync(e, newDir, e.name);
        else await copyDirectoryRecursiveAsync(e, newDir, e.name);
    }
    return newDir;
}
async function executeMoveProcess(src, destDirHandle) {
    if (!src || !destDirHandle) return;
    if (await isDescendantOrSelf(src.handle, destDirHandle)) {
        alert("エラー: 自分自身の中、または子フォルダーへの移動はできません。");
        return;
    }
    try {
        const sameKind =
            src.kind === "file" ? "getFileHandle" : "getDirectoryHandle";
        try {
            await destDirHandle[sameKind](src.name, { create: false });
            if (
                !confirm(
                    src.kind === "file"
                        ? `同名のファイル「${src.name}」が存在します。上書きしますか？`
                        : `同名のフォルダー「${src.name}」が存在します。中身を統合しますか？`,
                )
            )
                return;
        } catch (e) { }
        if (src.kind === "file") {
            const newHandle = await copyFileAsync(
                src.handle,
                destDirHandle,
                src.name,
            );
            await src.parentHandle.removeEntry(src.name);
            for (const t of tabs) {
                if (t.handle) {
                    try {
                        if (await t.handle.isSameEntry(src.handle)) {
                            t.handle = newHandle;
                            t.name = newHandle.name;
                        }
                    } catch (e) { }
                }
            }
        } else {
            await copyDirectoryRecursiveAsync(src.handle, destDirHandle, src.name);
            await src.parentHandle.removeEntry(src.name, { recursive: true });
            for (const t of [...tabs]) {
                if (t.handle) {
                    try {
                        if (await isDescendantOrSelf(src.handle, t.handle)) {
                            t.handle = null;
                        }
                    } catch (e) { }
                }
            }
        }
        window.activeDragData = null;
        await refreshExplorerSync();
        renderTabs();
        showStatusMessage("移動が完了しました");
    } catch (e) {
        alert("移動処理中にエラーが発生しました: " + (e.message || e));
    }
}

function renderOpenedEditorsSection() {
    const c = document.getElementById("opened-editors-wrapper");
    c.innerHTML = "";
    if (!tabs.length) {
        c.innerHTML =
            '<div class="tree-placeholder" style="padding:4px 8px;">開いているファイルなし</div>';
        return;
    }
    tabs.forEach((t) => {
        const item = document.createElement("div");
        item.className = "tree-item" + (t.id === activeTabId ? " active" : "");
        item.innerHTML = `<div class="tree-item-label"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span>${escapeHtml(t.name)}${t.isModified ? " *" : ""}</span></div>`;
        item.onclick = () => switchTab(t.id);
        c.appendChild(item);
    });
}

async function handleOpenFileWorkspace() {
    if ((await checkUnsavedProtection()) === "cancel") return;
    if (typeof window.showOpenFilePicker !== "function") {
        alert("このブラウザはファイル選択に対応していません。");
        return;
    }
    try {
        const [handle] = await window.showOpenFilePicker({ multiple: false });
        closeCurrentWorkspace(true);
        workspaceRoots = [];
        currentDirectoryHandle = null;
        currentWorkspaceMode = "file";
        const file = await handle.getFile(),
            img = isImageName(file.name),
            t = makeTab(
                handle,
                file.name,
                img ? "" : await file.text(),
                img,
                img ? URL.createObjectURL(file) : null,
            );
        tabs.push(t);
        await persistWorkspaceHandle();
        switchTab(t.id);
        fileTree.innerHTML =
            '<div class="tree-placeholder">単体ファイルモード</div>';
        updateUI();
    } catch (e) {
        if (e?.name !== "AbortError")
            alert("ファイルを開けませんでした。\n" + (e?.message || e));
    }
}
async function handleOpenDirectoryWorkspace() {
    if ((await checkUnsavedProtection()) === "cancel") return;
    if (typeof window.showDirectoryPicker !== "function") {
        alert("このブラウザはフォルダー選択に対応していません。");
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        closeCurrentWorkspace(true);
        tabs = [];
        activeTabId = null;
        workspaceRoots = [];
        await openDirectoryAsWorkspace(handle);
        showStatusMessage(`「${handle.name}」をCB Editorで開きました`);
    } catch (e) {
        if (e?.name !== "AbortError")
            alert("ワークスペースを開けませんでした。\n" + (e?.message || e));
    }
}

async function writeFileAtomically(handle, content) {
    const writable = await handle.createWritable();
    try {
        await writable.write(content);
        await writable.close();
    } catch (e) {
        try {
            await writable.abort();
        } catch (_) { }
        throw e;
    }
}
async function handleSaveFile() {
    if (!activeTabId) return false;
    const t = tabs.find((x) => x.id === activeTabId);
    if (!t || t.isImage) return false;
    t.content = editor.value;
    if (!t.handle) return await handleSaveAsFile();

    try {
        await writeFileAtomically(t.handle, t.content);
    } catch (err) {
        alert("保存に失敗しました。\n" + (err?.message || err));
        return false;
    }

    t.isModified = false;
    renderTabs();
    showStatusMessage("保存しました");
    runDiagnostics();

    try {
        await refreshExplorerSync();
    } catch (e) {
        console.warn("Explorer refresh after save failed", e);
    }
    try {
        await persistWorkspaceHandle();
    } catch (e) {
        console.warn("workspace persistence after save failed", e);
    }
    return true;
}
async function handleSaveAsFile() {
    if (!activeTabId) return false;
    const t = tabs.find((x) => x.id === activeTabId);
    if (!t || t.isImage) return false;
    t.content = editor.value;

    const currentName = t.name || "untitled";
    const currentExt = (
        currentName.match(/\.([^.\\/]+)$/)?.[1] || defaultExtension
    ).trim();
    const hasExtension = /\.[^.\\/]+$/.test(currentName);
    const suggestedName = hasExtension
        ? currentName
        : (currentName.endsWith(".") ? currentName.slice(0, -1) : currentName) +
        (currentName.endsWith(".") ? "" : "." + currentExt);

    try {
        const handle = await window.showSaveFilePicker({
            suggestedName,
            types: [
                {
                    description: "ファイル",
                    accept: { "text/plain": ["." + currentExt] },
                },
            ],
        });

        let actualName = handle.name;
        if (!/\.[^.\\/]+$/.test(actualName)) {
            const parentName = actualName.endsWith(".")
                ? actualName.slice(0, -1)
                : actualName;
            const correctedName = parentName + "." + currentExt;

            const correctedHandle = await window.showSaveFilePicker({
                suggestedName: correctedName,
                types: [
                    {
                        description: "ファイル",
                        accept: { "text/plain": ["." + currentExt] },
                    },
                ],
            });
            await writeFileAtomically(correctedHandle, t.content);
            t.handle = correctedHandle;
            t.name = correctedHandle.name;
        } else {
            await writeFileAtomically(handle, t.content);
            t.handle = handle;
            t.name = handle.name;
        }

        t.isModified = false;
        statusPath.textContent = t.name;
        renderTabs();
        showStatusMessage("保存しました");
        runDiagnostics();

        try {
            await persistWorkspaceHandle();
        } catch (e) {
            console.warn("workspace persistence after save-as failed", e);
        }
        if (currentWorkspaceMode === "project" && currentDirectoryHandle) {
            try {
                await refreshExplorerSync();
            } catch (e) {
                console.warn("Explorer refresh after save-as failed", e);
            }
        }
        return true;
    } catch (err) {
        if (err && err.name !== "AbortError")
            alert("名前を付けて保存に失敗しました。\n" + (err.message || err));
        return false;
    }
}
function createUntitledTab() {
    const t = makeTab(null, `untitled.${defaultExtension}`, "", false, null);
    if (initialUntitledTabId === null && tabs.length === 0 && currentWorkspaceMode === "none") {
        initialUntitledTabId = t.id;
    }
    tabs.push(t);
    currentWorkspaceMode =
        currentWorkspaceMode === "project" ? "project" : currentWorkspaceMode;
    switchTab(t.id);
}
const helpDocument = `# CBE の使い方

CBEは、ブラウザー上でローカルファイルを編集できる軽量エディターです。インストール不要で、Chromeを搭載したパソコンだけでなく、Chrome Bookでも利用できます。ファイルの内容はサーバーへ送信せず、対応ブラウザーのローカルファイル機能を使って読み書きします。

## まず覚えること

1. 「ファイル」からファイルまたはフォルダーを開きます。
2. 左のエクスプローラーで編集するファイルを選びます。
3. 編集後は **Ctrl+S** で保存します。保存先は元のローカルファイルです。
4. 「使い方」ボタンをもう一度押すと、この説明をいつでも開けます。

## 最重要: ファイルとワークスペース

- 「ファイルを開く」では単一ファイルを編集できます。
- 「フォルダを開く」ではフォルダーをワークスペースとして開き、複数ファイルを一覧から切り替えられます。
- 「ワークスペースを保存」で、開いているフォルダー構成を保存できます。
- 前回のワークスペースは、ブラウザーの権限が残っていれば自動的に復元されます。権限が必要な場合は、メニューからフォルダーを再接続してください。
- フォルダーやファイルの追加、名前変更、削除はエクスプローラーのボタンまたは右クリックメニューから行えます。
- エクスプローラーの項目はドラッグして移動できます。ファイルを右クリックすると、そのファイルをメインのプレビュー対象にもできます。

## ライブプレビュー

- HTMLは右側にそのまま表示され、フォームやダイアログなどの操作も確認できます。
- HTML内で参照したワークスペース内の画像などもプレビューに読み込めます。
- Markdownは見出し、太字、斜体、リンク、リスト、引用、コードブロックを整形して表示します。
- CSS、JavaScript、JSON、TXTなどHTML以外のファイルも内容を確認できます。
- Consoleボタンでプレビュー内のログを確認でき、消去ボタンでログを削除できます。
- プレビューの背景は「表示」メニューからライト、ダーク、アプリのテーマに合わせる、の3種類を選べます。この設定はHTML以外に適用されます。

## 編集と表示

- タブをクリックして、開いているファイルを切り替えます。タブの × で閉じられます。
- 「新規種類」では、最初に作るファイルの種類をHTML、CSS、JavaScript、JSON、Markdown、Textから選べます。
- 「表示」メニューでは、指定文字数での折り返し、折り返し単位、プレビュー背景、設定の保存を変更できます。
- 左のエクスプローラー、中央のエディター、右のプレビューは境界線をドラッグして幅を調整できます。不要な領域は上部の各ボタンで隠せます。
- テーマ切り替えボタンでアプリ全体のライト・ダーク表示を変更できます。

## キーボード操作

- ファイルを開く: **Ctrl+O**
- 保存: **Ctrl+S**
- 新規ファイル: **Ctrl+N**
- 名前変更: **F2**
- ターミナルでは「help」でコマンド一覧、「version」でCBEのバージョンを表示できます。

## v2.8.21 更新内容

### アプリ名をCBEに統一

ブラウザーのタイトル、アプリ上部のロゴ、説明文を「CBE」に統一しました。Chrome Bookでも利用できるローカルエディターであることを説明に明記しています。

### 説明を再整理

最初に保存方法とワークスペースの使い方を案内し、その後にライブプレビュー、編集・表示設定、キーボード操作を確認できる構成に更新しました。現在利用できる機能を優先順位順にまとめています。

困ったときは、このファイルを編集して自分用のメモとして保存できます。
`;
function openHelpDocument() {
    const existing = tabs.find((t) => t.isHelpDocument);
    if (existing) {
        switchTab(existing.id);
        return;
    }
    const t = makeTab(null, "説明.md", helpDocument);
    t.isHelpDocument = true;
    tabs.push(t);
    switchTab(t.id);
    updateUI();
}
function updateInitialUntitledExtension(extension) {
    const t = tabs.find((x) => x.id === initialUntitledTabId);
    if (!t || t.handle || t.isModified || t.content !== "") return;
    if (!/^untitled\.[^.]+$/i.test(t.name)) return;
    t.name = `untitled.${extension}`;
    if (activeTabId === t.id) statusPath.textContent = t.name;
    renderTabs();
    updatePreview();
}
function renderTabs() {
    tabsBar.innerHTML = "";
    tabs.forEach((tab) => {
        const el = document.createElement("div");
        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;
        el.innerHTML = `<span>${escapeHtml(tab.name)}${tab.isModified ? " *" : ""}</span><span class="tab-close">×</span>`;
        el.onclick = (e) => {
            if (e.target.classList.contains("tab-close")) {
                e.stopPropagation();
                closeTab(tab.id);
            } else switchTab(tab.id);
        };
        tabsBar.appendChild(el);
    });
    renderOpenedEditorsSection();
}
function switchTab(id) {
    if (activeTabId) {
        const cur = tabs.find((t) => t.id === activeTabId);
        if (cur && !cur.isImage) cur.content = editor.value;
    }
    activeTabId = id;
    const next = tabs.find((t) => t.id === id);
    if (!next) return;
    statusPath.textContent = next.name;
    if (next.isImage) {
        editor.style.display = "none";
        lineNumbersWrapper.style.display = "none";
        syntaxHighlight.style.display = "none";
        diagnosticsPanel.style.display = "none";
        imageViewerImg.src = next.imageUrl || "";
        imageViewerContainer.style.display = "flex";
        previewFrame.srcdoc = '<p style="padding:10px;color:#666;">画像表示中</p>';
    } else {
        imageViewerContainer.style.display = "none";
        editor.style.display = "block";
        lineNumbersWrapper.style.display = "block";
        syntaxHighlight.style.display = "block";
        editor.disabled = false;
        editor.value = next.content;
        applyWrapStyles();
        updateEditorVisuals();
        updatePreview();
        updateLineColumn();
        syncEditorScroll();
    }
    renderTabs();
    refreshExplorerSync();
}
function closeTab(id) {
    const target = tabs.find((t) => t.id === id);
    if (!target) return;
    if (target.isModified) {
        if (!confirm(`「${target.name}」には未保存の変更があります。閉じますか？`))
            return;
    }
    if (target.imageUrl) URL.revokeObjectURL(target.imageUrl);
    const wasActive = activeTabId === id;
    tabs = tabs.filter((t) => t.id !== id);
    if (wasActive) {
        if (tabs.length) switchTab(tabs[tabs.length - 1].id);
        else {
            activeTabId = null;
            editor.value = "";
            editor.disabled = true;
            renderTabs();
            renderDiagnostics([]);
            updateLineColumn();
        }
    } else renderTabs();
    persistWorkspaceHandle();
}
function getTextPreviewStyles() {
    const isDark =
        previewTextTheme === "dark" ||
        (previewTextTheme === "auto" && document.body.dataset.theme === "dark");
    return isDark
        ? "body{font:15px/1.7 system-ui,sans-serif;color:#d4d4d4;background:#1e1e1e;padding:24px;max-width:860px;margin:auto}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em;color:#fff}p{margin:.7em 0}a{color:#75beff}code{font-family:ui-monospace,monospace;background:#2d2d2d;color:#f3f3f3;padding:.15em .35em;border-radius:4px}pre{padding:14px;overflow:auto;background:#252526;border:1px solid #3f3f46;border-radius:6px}pre code{padding:0;background:none}blockquote{margin:1em 0;padding:0 1em;color:#b0b0b0;border-left:3px solid #666}li{margin:.2em 0}hr{border:0;border-top:1px solid #555;margin:1.5em 0}.markdown-empty{color:#969696}"
        : "body{font:15px/1.7 system-ui,sans-serif;color:#24292f;background:#fff;padding:24px;max-width:860px;margin:auto}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em;color:#24292f}p{margin:.7em 0}a{color:#0969da}code{font-family:ui-monospace,monospace;background:#f0f2f4;padding:.15em .35em;border-radius:4px}pre{padding:14px;overflow:auto;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px}pre code{padding:0;background:none}blockquote{margin:1em 0;padding:0 1em;color:#57606a;border-left:3px solid #d0d7de}li{margin:.2em 0}hr{border:0;border-top:1px solid #d0d7de;margin:1.5em 0}.markdown-empty{color:#6e7781}";
}

async function updatePreview() {
    const updateToken = ++previewUpdateToken;
    if (previewConsoleOutput) previewConsoleOutput.replaceChildren();
    try {

        if (
            previewMode === "workspace" &&
            mainPreviewHandle &&
            currentWorkspaceMode === "project"
        ) {
            const mergedPreview = await buildMergedPreview(mainPreviewHandle);
            if (updateToken !== previewUpdateToken) return;
            previewFrame.srcdoc = mergedPreview;
            return;
        }
        if (!activeTabId) {
            previewFrame.srcdoc =
                '<p style="padding:10px;color:#666;">プレビューなし</p>';
            return;
        }
        const t = tabs.find((x) => x.id === activeTabId);
        if (!t) return;
        if (/\.(html?|xhtml)$/i.test(t.name))
            previewFrame.srcdoc = await buildMergedPreview(t.handle, editor.value);
        else if (/\.(md|markdown)$/i.test(t.name))
            previewFrame.srcdoc = `<style>${getTextPreviewStyles()}</style>${renderMarkdown(editor.value)}`;
        else if (!editor.value)
            previewFrame.srcdoc = `<style>${getTextPreviewStyles()}</style>`;
        else
            previewFrame.srcdoc = `<style>${getTextPreviewStyles()}</style><div class="plain-text-preview">${escapeHtml(editor.value)}</div>`;
    } catch (e) {
        if (updateToken !== previewUpdateToken) return;
        previewFrame.srcdoc = `<pre style="padding:10px;color:#d32f2f;white-space:pre-wrap;">ライブプレビュー生成エラー: ${escapeHtml(e.message || String(e))}</pre>`;
    }
}

function schedulePreviewUpdate() {
    clearTimeout(previewUpdateTimer);
    previewUpdateTimer = setTimeout(updatePreview, 180);
}

async function executeRenameUI(itemData) {
    const newName = prompt("新しい名前を入力してください:", itemData.name);
    if (!newName || !newName.trim() || newName.trim() === itemData.name) return;
    const name = newName.trim();
    if (/[\\\/:*?"<>|]/.test(name)) {
        alert("使用できない文字が含まれています。");
        return;
    }
    try {
        if (itemData.kind === "file") {
            const oldHandle = await itemData.parentHandle.getFileHandle(
                itemData.name,
            );
            const newHandle = await copyFileAsync(
                oldHandle,
                itemData.parentHandle,
                name,
            );
            await itemData.parentHandle.removeEntry(itemData.name);
            for (const t of tabs) {
                if (t.handle) {
                    try {
                        if (await t.handle.isSameEntry(oldHandle)) {
                            t.handle = newHandle;
                            t.name = name;
                        }
                    } catch (e) { }
                }
            }
        } else {
            const newDir = await copyDirectoryRecursiveAsync(
                itemData.handle,
                itemData.parentHandle,
                name,
            );
            await itemData.parentHandle.removeEntry(itemData.name, {
                recursive: true,
            });
            for (const t of tabs) {
                if (t.handle) {
                    try {
                        if (await isDescendantOrSelf(itemData.handle, t.handle))
                            t.handle = null;
                    } catch (e) { }
                }
            }
        }
        await refreshExplorerSync();
        renderTabs();
        if (activeTabId) switchTab(activeTabId);
        showStatusMessage("名前を変更しました");
    } catch (e) {
        alert("変更に失敗しました。\n" + (e.message || e));
    }
}
function executeDeleteUI(itemData) {
    const dialog = document.getElementById("delete-confirm-dialog");
    document.getElementById("delete-dialog-body").innerText =
        `項目「${itemData.name}」を完全に削除しますか？`;
    dialog.showModal();
    document.getElementById("btn-dialog-delete-confirm").onclick = async () => {
        try {
            if (!itemData.parentHandle)
                throw new Error("削除対象の親フォルダーがありません。");
            if (itemData.kind === "file") {
                const targetTabs = [];
                for (const t of tabs) {
                    if (t.handle) {
                        try {
                            if (await t.handle.isSameEntry(itemData.handle))
                                targetTabs.push(t);
                        } catch (e) { }
                    }
                }
                for (const t of targetTabs) closeTab(t.id);
            } else {
                for (const t of [...tabs]) {
                    if (t.handle) {
                        try {
                            if (await isDescendantOrSelf(itemData.handle, t.handle))
                                closeTab(t.id);
                        } catch (e) { }
                    }
                }
            }
            await itemData.parentHandle.removeEntry(itemData.name, {
                recursive: itemData.kind === "directory",
            });
            dialog.close();
            await refreshExplorerSync();
            showStatusMessage("削除しました");
        } catch (e) {
            dialog.close();
            alert("削除に失敗しました。\n" + (e.message || e));
        }
    };
    document.getElementById("btn-dialog-delete-cancel").onclick = () =>
        dialog.close();
}

async function readAllWorkspaceFiles() {
    const files = new Map();
    async function walk(dir, prefix = "") {
        for await (const e of dir.values()) {
            const rel = prefix + e.name;
            if (e.kind === "file") {
                files.set(rel, e);
                if (!files.has(e.name)) files.set(e.name, e);
            } else await walk(e, rel + "/");
        }
    }
    for (const r of workspaceRoots) await walk(r.handle, "");
    return files;
}
function normalizeWorkspacePath(path) {
    const parts = [];
    for (const part of path.replace(/\\/g, "/").split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
    }
    return parts.join("/");
}
function resolveWorkspaceFileFrom(files, src, basePath = "") {
    if (!src) return null;
    let clean;
    try {
        clean = decodeURIComponent(src).split("#")[0].split("?")[0];
    } catch (e) {
        return null;
    }
    const normalized = normalizeWorkspacePath(
        clean.startsWith("/") ? clean : `${basePath}/${clean}`,
    );
    return files.get(normalized) || (normalized.includes("/")
        ? null
        : files.get(normalized.split("/").pop()) || null);
}
async function getWorkspacePath(files, handle) {
    if (!handle) return "";
    for (const [path, candidate] of files) {
        if (!path.includes("/")) continue;
        try {
            if (await candidate.isSameEntry(handle)) return normalizeWorkspacePath(path);
        } catch (e) { }
    }
    return "";
}
async function replaceAsync(text, re, repl) {
    const ms = [...text.matchAll(re)];
    let out = "",
        last = 0;
    for (const m of ms) {
        out += text.slice(last, m.index);
        out += await repl(m);
        last = m.index + m[0].length;
    }
    return out + text.slice(last);
}
async function getLocalAssetUrl(handle) {
    if (localAssetUrlCache.has(handle)) return localAssetUrlCache.get(handle);
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    localAssetUrlCache.set(handle, url);
    localAssetObjectUrls.add(url);
    return url;
}
async function getLocalScriptUrl(handle) {
    if (localScriptUrlCache.has(handle)) return localScriptUrlCache.get(handle);
    const file = await handle.getFile();
    const url = URL.createObjectURL(
        new Blob([await file.text()], { type: "text/javascript" }),
    );
    localScriptUrlCache.set(handle, url);
    localScriptObjectUrls.add(url);
    return url;
}
async function buildLocalAssetMap(files) {
    const assets = {};
    for (const [path, handle] of files) {
        if (!isImageName(path)) continue;
        const localUrl = await getLocalAssetUrl(handle);
        const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
        const name = normalized.split("/").pop();
        assets[normalized] = localUrl;
        assets[name] = assets[name] || localUrl;
        assets[`img/panorama/${name}`] = assets[`img/panorama/${name}`] || localUrl;
    }
    for (const [path, handle] of files) {
        if (!/\.(?:js|mjs|cjs)$/i.test(path)) continue;
        const source = await (await handle.getFile()).text();
        const remotePattern = /["']([^"']+\.(?:png|jpe?g|gif|webp|bmp|ico|svg))["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi;
        for (const match of source.matchAll(remotePattern)) {
            const localUrl = assets[match[1]] || assets[match[1].split("/").pop()];
            if (localUrl) assets[match[2]] = localUrl;
        }
    }
    return assets;
}
function injectLocalAssetBridge(html, assets) {
    const serializedAssets = JSON.stringify(assets).replace(/<\//g, "<\\/");
    const previewLayout = `<style id="cb-editor-preview-layout">html,body{width:100%;min-width:0;max-width:100%;overflow-x:hidden}#leftPanel{left:0!important;transform:translateX(0);will-change:transform}#leftPanel.hide{transform:translateX(-100%)!important}#streetViewContainer{margin-left:320px!important;width:calc(100% - 320px)!important;max-width:calc(100% - 320px)!important}#leftPanel.hide~#streetViewContainer{margin-left:0!important;width:100%!important;max-width:100%!important}#panoramaCanvas{width:100%!important;max-width:100%!important;min-width:0!important}</style>`;
    const previewConsoleBridge = `<script>(function(){const stringify=function(value){try{if(typeof value==="string")return value;const result=JSON.stringify(value);return result===undefined?String(value):result;}catch(_){return String(value);}};const send=function(level,args){try{parent.postMessage({source:"cb-preview-console",level:level,args:Array.prototype.map.call(args,stringify)},"*");}catch(_){}};["log","info","warn","error","debug"].forEach(function(level){const original=console[level];console[level]=function(){send(level,arguments);return original.apply(this,arguments);};});window.addEventListener("error",function(event){send("error",[event.message+" ("+event.filename+":"+event.lineno+")"]);});window.addEventListener("unhandledrejection",function(event){send("error",[event.reason&&event.reason.stack||event.reason]);});})();<\\/script>`;
    const navigationBridge = `<script>(function(){document.addEventListener("click",function(event){const link=event.target.closest&&event.target.closest("a[href]");if(!link)return;const href=link.getAttribute("href")||"";if(!href||href.startsWith("#")||/^(?:[a-z][a-z0-9+.-]*:|\\/\\/)/i.test(href))return;event.preventDefault();parent.postMessage({source:"cb-preview-navigation",href:href},"*");});})();<\\/script>`;
    const bridge = `${previewLayout}${previewConsoleBridge}${navigationBridge}<script>(function(){const assets=${serializedAssets};const resolve=function(value){try{if(typeof value!=="string")return value;const key=decodeURIComponent(value).split(/[?#]/)[0].replace(/\\\\/g,"/").replace(/^\\.\\//,"").replace(/^\\/+/,"");return assets[key]||assets["img/panorama/"+key]||assets[key.split("/").pop()]||value;}catch(_){return value;}};const patch=function(){const three=window.THREE;const loader=three&&three.TextureLoader&&three.TextureLoader.prototype;if(loader&&!loader.__cbLocalAssetBridge){const original=loader.load;loader.load=function(url){const resolved=resolve(url);if(resolved===url&&typeof url==="string"&&/^(?:https?:)?\\/\\//i.test(url)){console.warn("CB Editor: ローカルパノラマが見つからないため外部URLを使用します",url);}const args=Array.prototype.slice.call(arguments);args[0]=resolved;return original.apply(this,args);};loader.__cbLocalAssetBridge=true;}if(window.fetch&&!window.__cbFetchBridge){const originalFetch=window.fetch;window.fetch=function(input){const args=Array.prototype.slice.call(arguments);if(typeof input==="string")args[0]=resolve(input);else if(input&&input.url)args[0]=new Request(resolve(input.url),input);return originalFetch.apply(this,args);};window.__cbFetchBridge=true;}const xhr=window.XMLHttpRequest&&XMLHttpRequest.prototype;if(xhr&&!xhr.__cbLocalAssetBridge){const originalOpen=xhr.open;xhr.open=function(method,url){const args=Array.prototype.slice.call(arguments);args[1]=resolve(url);return originalOpen.apply(this,args);};xhr.__cbLocalAssetBridge=true;}const close=document.getElementById("closeLeftPanel");if(close){close.style.pointerEvents="auto";close.style.position="relative";close.style.zIndex="1002";}};patch();window.addEventListener("DOMContentLoaded",patch);window.addEventListener("resize",function(){const canvas=document.getElementById("panoramaCanvas");if(canvas&&typeof window.onWindowResize==="function")window.onWindowResize();});})();<\\/script>`;
    const scriptClose = "<" + "/script>";
    const safeBridge = bridge.replaceAll("<\\" + "/script>", scriptClose);
    if (/<head\b[^>]*>/i.test(html))
        return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${safeBridge}`);
    return safeBridge + html;
}
async function buildMergedPreview(handle, source = null) {
    let html = source ?? (await (await handle.getFile()).text());
    const files = await readAllWorkspaceFiles();
    const filePath = await getWorkspacePath(files, handle);
    previewDocumentPath = filePath;
    const basePath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    html = await replaceAsync(
        html,
        /<link\b([^>]*?)href=["']([^"']+\.css(?:\?[^"']*)?)["']([^>]*)>/gi,
        async (m) => {
            const h = resolveWorkspaceFileFrom(files, m[2], basePath);
            if (!h) return m[0];
            return `<style>${await (await h.getFile()).text()}</style>`;
        },
    );
    const localScriptPattern = new RegExp(
        "<script\\b([^>]*?)src=[\"']([^\"']+)[\"']([^>]*)>[\\s\\S]*?<" +
        "/script>",
        "gi",
    );
    html = await replaceAsync(
        html,
        localScriptPattern,
        async (m) => {
            const h = resolveWorkspaceFileFrom(files, m[2], basePath);
            if (!h) return m[0];
            const deferred = /\bdefer\b/i.test(`${m[1]} ${m[3]}`) ? " defer" : "";
            const scriptUrl = await getLocalScriptUrl(h);
            return `<script src="${scriptUrl}"${deferred}><\/script>`;
        },
    );
    html = await replaceAsync(
        html,
        /<(?:include|sub-html)\b[^>]*src=["']([^"']+)["'][^>]*\/?>/gi,
        async (m) => {
            const h = resolveWorkspaceFileFrom(files, m[1], basePath);
            return h ? await (await h.getFile()).text() : m[0];
        },
    );
    html = await replaceAsync(
        html,
        /\b(src|poster|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|bmp|ico|svg)(?:[?#][^"']*)?)["']/gi,
        async (m) => {
            const h = resolveWorkspaceFileFrom(files, m[2], basePath);
            if (!h) return m[0];
            return `${m[1]}="${await getLocalAssetUrl(h)}"`;
        },
    );
    html = await replaceAsync(
        html,
        /url\(["']?([^\)"']+\.(?:png|jpe?g|gif|webp|bmp|ico|svg)(?:[?#][^\)"']*)?)["']?\)/gi,
        async (m) => {
            const h = resolveWorkspaceFileFrom(files, m[1], basePath);
            if (!h) return m[0];
            return `url("${await getLocalAssetUrl(h)}")`;
        },
    );
    return injectLocalAssetBridge(html, await buildLocalAssetMap(files));
}
async function navigatePreview(href) {
    if (currentWorkspaceMode !== "project" || !href) return;
    try {
        const files = await readAllWorkspaceFiles();
        const basePath = previewDocumentPath.includes("/")
            ? previewDocumentPath.slice(0, previewDocumentPath.lastIndexOf("/"))
            : "";
        const target = resolveWorkspaceFileFrom(files, href, basePath);
        if (!target || !/\.(html?|xhtml)$/i.test(target.name)) {
            previewFrame.srcdoc = `<pre style="padding:10px;color:#d32f2f;white-space:pre-wrap;">リンク先のHTMLファイルが見つかりません: ${escapeHtml(href)}</pre>`;
            return;
        }
        const targetPath = await getWorkspacePath(files, target);
        const tab = tabs.find((item) => item.handle === target);
        previewDocumentPath = targetPath;
        previewFrame.srcdoc = await buildMergedPreview(
            target,
            tab && !tab.isImage ? tab.content : null,
        );
    } catch (e) {
        previewFrame.srcdoc = `<pre style="padding:10px;color:#d32f2f;white-space:pre-wrap;">リンク先の読み込みエラー: ${escapeHtml(e.message || String(e))}</pre>`;
    }
}
async function setMainPreview(data) {
    try {
        mainPreviewHandle = data.handle;
        previewMode = "workspace";
        await updatePreview();
        await persistWorkspaceHandle();
        showStatusMessage(`「${data.name}」をメインプレビューに設定しました`);
    } catch (e) {
        alert("メインプレビューの設定に失敗しました。\n" + (e.message || e));
    }
}
function resetPreviewMode() {
    mainPreviewHandle = null;
    previewMode = "default";
    updatePreview();
    persistWorkspaceHandle();
    showStatusMessage("ライブプレビューをデフォルトに戻しました");
}

function showContextMenuFor(data, x, y) {
    rightClickedItemData = data;
    const m = document.getElementById("custom-context-menu");
    setupContextMenuDisplay(data, false);
    m.style.display = "block";
    m.style.left = `${Math.min(x, window.innerWidth - m.offsetWidth - 5)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - m.offsetHeight - 5)}px`;
}
function setupContextMenuDisplay(data, isRoot = false) {
    const nf = document.getElementById("ctx-menu-new-file"),
        nfo = document.getElementById("ctx-menu-new-folder"),
        rn = document.getElementById("ctx-menu-rename"),
        del = document.getElementById("ctx-menu-delete");
    nf.style.display = isRoot || data?.kind === "directory" ? "block" : "none";
    nfo.style.display = isRoot || data?.kind === "directory" ? "block" : "none";
    rn.style.display = isRoot ? "none" : "block";
    del.style.display = isRoot ? "none" : "block";
    const main = document.getElementById("ctx-menu-main-preview");
    if (main)
        main.style.display =
            !isRoot && data?.kind === "file" && /\.(html?|xhtml)$/i.test(data.name)
                ? "block"
                : "none";
}
async function createFileInDirectory(dir) {
    if (!dir) return;
    const raw = prompt(
        "ファイル名を入力してください:",
        `untitled.${defaultExtension}`,
    );
    if (!raw || !raw.trim()) return;
    const name = raw.trim();
    try {
        await dir.getFileHandle(name, { create: true });
        showStatusMessage("ファイルを作成しました");
        await refreshExplorerSync();
    } catch (e) {
        alert("作成に失敗しました。\n" + (e.message || e));
    }
}
async function createFolderInDirectory(dir) {
    if (!dir) return;
    const raw = prompt("フォルダー名を入力してください:");
    if (!raw || !raw.trim()) return;
    try {
        await dir.getDirectoryHandle(raw.trim(), { create: true });
        showStatusMessage("フォルダーを作成しました");
        await refreshExplorerSync();
    } catch (e) {
        alert("作成に失敗しました。\n" + (e.message || e));
    }
}

fileTree.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (currentWorkspaceMode === "project")
        fileTree.classList.add("drag-over-root");
});
fileTree.addEventListener("dragleave", () =>
    fileTree.classList.remove("drag-over-root"),
);
fileTree.addEventListener("drop", async (e) => {
    e.preventDefault();
    fileTree.classList.remove("drag-over-root");
    if (window.activeDragData && currentDirectoryHandle)
        await executeMoveProcess(window.activeDragData, currentDirectoryHandle);
});
fileTree.oncontextmenu = (e) => {
    if (currentWorkspaceMode !== "project") return;
    e.preventDefault();
    showContextMenuFor(
        {
            name: workspaceRoots[0]?.name || "Workspace",
            kind: "directory",
            handle: workspaceRoots[0]?.handle || currentDirectoryHandle,
            parentHandle: null,
        },
        e.clientX,
        e.clientY,
    );
};

document.getElementById("ctx-menu-new-file").onclick = () =>
    createFileInDirectory(rightClickedItemData?.handle);
document.getElementById("ctx-menu-new-folder").onclick = () =>
    createFolderInDirectory(rightClickedItemData?.handle);
document.getElementById("ctx-menu-rename").onclick = () => {
    if (rightClickedItemData) executeRenameUI(rightClickedItemData);
};
document.getElementById("ctx-menu-main-preview").onclick = () => {
    if (rightClickedItemData) setMainPreview(rightClickedItemData);
    document.getElementById("custom-context-menu").style.display = "none";
};
document.getElementById("ctx-menu-delete").onclick = () => {
    if (rightClickedItemData) executeDeleteUI(rightClickedItemData);
};
document.getElementById("tool-btn-add-folder").onclick = () =>
    createFolderInDirectory(workspaceRoots[0]?.handle || currentDirectoryHandle);
document.getElementById("tool-btn-add-file").onclick = () =>
    createFileInDirectory(workspaceRoots[0]?.handle || currentDirectoryHandle);

document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-container")) {
        document.querySelectorAll(".dropdown-content").forEach((dc) => {
            dc.style.display = "none";
            dc.parentElement.classList.remove("menu-active");
        });
    }
    if (!e.target.closest("#custom-context-menu"))
        document.getElementById("custom-context-menu").style.display = "none";
});
const menuContainers = document.querySelectorAll(".menu-container");
menuContainers.forEach((container) => {
    const btn = container.querySelector(".menu-btn"),
        dropdown = container.querySelector(".dropdown-content");
    btn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll(".dropdown-content").forEach((dc) => {
            if (dc !== dropdown) {
                dc.style.display = "none";
                dc.parentElement.classList.remove("menu-active");
            }
        });
        dropdown.style.display =
            dropdown.style.display === "block" ? "none" : "block";
        container.classList.toggle(
            "menu-active",
            dropdown.style.display === "block",
        );
    };
    btn.onmouseenter = () => {
        if (
            [...document.querySelectorAll(".dropdown-content")].some(
                (dc) => dc.style.display === "block",
            )
        ) {
            document.querySelectorAll(".dropdown-content").forEach((dc) => {
                dc.style.display = "none";
                dc.parentElement.classList.remove("menu-active");
            });
            dropdown.style.display = "block";
            container.classList.add("menu-active");
        }
    };
});

let isResizingSidebar = false,
    isResizingPreview = false,
    isResizingPreviewConsole = false,
    startX = 0,
    startSidebarWidth = 0,
    startEditorWidth = 0,
    startPreviewWidth = 0,
    startPreviewConsoleWidth = 0,
    totalActiveWidth = 0;
function startDragProtection() {
    document.body.style.cursor = "col-resize";
    editor.style.pointerEvents = "none";
    previewFrame.style.pointerEvents = "none";
}
function stopDragProtection() {
    isResizingSidebar = false;
    isResizingPreview = false;
    isResizingPreviewConsole = false;
    document.body.style.cursor = "default";
    editor.style.pointerEvents = "auto";
    previewFrame.style.pointerEvents = "auto";
}
resizerSidebar.onmousedown = (e) => {
    e.preventDefault();
    isResizingSidebar = true;
    startX = e.clientX;
    startSidebarWidth = sidebar.offsetWidth;
    startDragProtection();
};
resizerPreview.onmousedown = (e) => {
    e.preventDefault();
    isResizingPreview = true;
    startX = e.clientX;
    startEditorWidth = editorPane.offsetWidth;
    startPreviewWidth = previewPane.offsetWidth;
    totalActiveWidth = startEditorWidth + startPreviewWidth;
    startDragProtection();
};
previewConsoleResizer.onmousedown = (e) => {
    e.preventDefault();
    if (!previewConsole.classList.contains("open")) return;
    isResizingPreviewConsole = true;
    startX = e.clientX;
    startPreviewConsoleWidth = previewConsole.offsetWidth || 280;
    startDragProtection();
};
document.addEventListener("mousemove", (e) => {
    if (isResizingSidebar)
        sidebar.style.width = `${Math.max(160, Math.min(startSidebarWidth + (e.clientX - startX), 400))}px`;
    if (isResizingPreview) {
        const dx = e.clientX - startX,
            edW = Math.max(100, startEditorWidth + dx),
            prW = Math.max(100, startPreviewWidth - dx);
        if (edW >= 100 && prW >= 100) {
            editorLastPercent = (edW / totalActiveWidth) * 100;
            editorPane.style.flex = `${editorLastPercent} ${editorLastPercent} 0%`;
            previewPane.style.flex = `${100 - editorLastPercent} ${100 - editorLastPercent} 0%`;
        }
    }
    if (isResizingPreviewConsole && previewConsole.classList.contains("open")) {
        const dx = e.clientX - startX;
        const width = Math.max(
            160,
            Math.min(startPreviewConsoleWidth - dx, previewPane.clientWidth * 0.6),
        );
        previewConsole.style.width = `${width}px`;
    }
});
window.addEventListener("mouseup", stopDragProtection);

function toggleSidebarSection(id, barEl) {
    const el = document.getElementById(id),
        arrow = barEl.querySelector(".section-arrow"),
        hidden = el.style.display === "none";
    el.style.display = hidden ? "block" : "none";
    if (arrow) arrow.classList.toggle("collapsed", !hidden);
}
function saveSettings() {
    maxWrapLength = Math.max(
        1,
        Number(document.getElementById("wrap-length-input").value) || 80,
    );
    wrapLengthUnit =
        document.getElementById("wrap-unit-select").value === "full"
            ? "full"
            : "half";
    defaultExtension = document.getElementById("select-default-ext").value;
    previewTextTheme = document.getElementById("preview-text-theme-select").value;
    const settings = {
        theme: document.body.getAttribute("data-theme") || "dark",
        sidebarVisible: sidebar.style.display !== "none",
        previewVisible: previewPane.style.display !== "none",
        sidebarWidth: sidebar.style.width || "220px",
        editorPercent: editorLastPercent,
        defaultExtension,
        maxWrapLength,
        wrapLengthUnit,
        wrapEnabled,
        previewTextTheme,
    };
    localStorage.setItem("cb_editor_settings_v2.7", JSON.stringify(settings));
    applyWrapStyles();
    updateEditorVisuals();
    showStatusMessage("設定を保存しました");
}
function loadSettings() {
    const saved =
        localStorage.getItem("cb_editor_settings_v2.7") ||
        localStorage.getItem("cb_editor_settings_v2.6");
    if (!saved) return;
    try {
        const s = JSON.parse(saved);
        wrapEnabled = !!s.wrapEnabled;
        maxWrapLength = s.maxWrapLength ?? 80;
        wrapLengthUnit = s.wrapLengthUnit === "full" ? "full" : "half";
        defaultExtension = s.defaultExtension ?? "html";
        previewTextTheme = ["light", "dark", "auto"].includes(s.previewTextTheme)
            ? s.previewTextTheme
            : "light";
        document.getElementById("wrap-length-input").value = maxWrapLength;
        document.getElementById("wrap-unit-select").value = wrapLengthUnit;
        document.getElementById("select-default-ext").value = defaultExtension;
        document.getElementById("preview-text-theme-select").value = previewTextTheme;
        document.body.setAttribute(
            "data-theme",
            s.theme === "light" ? "light" : "dark",
        );
        editorLastPercent = s.editorPercent || 50;
        if (s.sidebarWidth) sidebar.style.width = s.sidebarWidth;
        if (s.sidebarVisible === false) {
            sidebar.style.display = "none";
            resizerSidebar.style.display = "none";
            document.getElementById("btn-toggle-sidebar").classList.remove("active");
        }
        if (s.previewVisible === false) {
            previewPane.style.display = "none";
            resizerPreview.style.display = "none";
            editorPane.style.flex = "1 1 0%";
            document.getElementById("btn-toggle-preview").classList.remove("active");
        } else {
            editorPane.style.flex = `${editorLastPercent} ${editorLastPercent} 0%`;
            previewPane.style.flex = `${100 - editorLastPercent} ${100 - editorLastPercent} 0%`;
        }
        applyWrapStyles();
    } catch (e) { }
}
function hasUnsavedChanges() {
    return tabs.some((t) => t.isModified);
}
function closeCurrentWorkspace(skip = false) {
    localAssetObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    localAssetObjectUrls = new Set();
    localAssetUrlCache = new WeakMap();
    localScriptObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    localScriptObjectUrls = new Set();
    localScriptUrlCache = new WeakMap();
    tabs.forEach((t) => {
        if (t.imageUrl) URL.revokeObjectURL(t.imageUrl);
    });
    tabs = [];
    activeTabId = null;
    currentWorkspaceMode = "none";
    currentDirectoryHandle = null;
    workspaceRoots = [];
    workspaceRootExpanded = new Map();
    editor.value = "";
    editor.disabled = true;
    fileTree.innerHTML =
        '<div class="tree-placeholder">フォルダが選択されていません</div>';
    imageViewerContainer.style.display = "none";
    editor.style.display = "block";
    lineNumbersWrapper.style.display = "block";
    syntaxHighlight.style.display = "block";
    renderDiagnostics([]);
    renderTabs();
    updateUI();
    updatePreview();
    if (!skip) createUntitledTab();
}
function checkUnsavedProtection() {
    return new Promise((resolve) => {
        if (!hasUnsavedChanges()) return resolve("proceed");
        const d = document.getElementById("save-confirm-dialog");
        d.showModal();
        document.getElementById("dialog-save").onclick = async () => {
            const ok = await handleSaveAllModified();
            if (!ok) {
                return;
            }
            d.close();
            resolve("proceed");
        };
        document.getElementById("dialog-discard").onclick = () => {
            d.close();
            resolve("proceed");
        };
        document.getElementById("dialog-cancel").onclick = () => {
            d.close();
            resolve("cancel");
        };
    });
}
async function handleSaveAllModified() {
    const modified = tabs.filter((t) => t.isModified);
    for (const t of modified) {
        switchTab(t.id);
        const ok = await handleSaveFile();
        if (!ok) return false;
    }
    return true;
}
function updateUI() {
    statusMode.textContent =
        currentWorkspaceMode === "project"
            ? "モード: フォルダ"
            : currentWorkspaceMode === "file"
                ? "モード: 単体ファイル"
                : "モード: なし";
}

document.getElementById("btn-toggle-sidebar").onclick = function () {
    const hidden = sidebar.style.display === "none";
    sidebar.style.display = hidden ? "flex" : "none";
    resizerSidebar.style.display = hidden ? "block" : "none";
    this.classList.toggle("active", hidden);
};
const resetPreviewBtn = document.getElementById("btn-preview-default");
if (resetPreviewBtn) resetPreviewBtn.onclick = resetPreviewMode;
const previewConsoleBtn = document.getElementById("btn-preview-console");
const previewConsoleClearBtn = document.getElementById("btn-preview-console-clear");
if (previewConsoleBtn) {
    previewConsoleBtn.onclick = () => {
        previewConsole.classList.toggle("open");
        previewConsoleResizer.style.display = previewConsole.classList.contains("open")
            ? "block"
            : "none";
        previewConsoleBtn.setAttribute(
            "aria-expanded",
            String(previewConsole.classList.contains("open")),
        );
        if (previewConsole.classList.contains("open") && !previewConsole.style.width) {
            previewConsole.style.width = "280px";
        }
    };
}
if (previewConsoleClearBtn)
    previewConsoleClearBtn.onclick = () => previewConsoleOutput.replaceChildren();
document.getElementById("btn-toggle-terminal").onclick = () => {
    terminalPanel.classList.toggle("open");
    document.getElementById("btn-toggle-terminal").classList.toggle(
        "active",
        terminalPanel.classList.contains("open"),
    );
    if (terminalPanel.classList.contains("open") && !terminalOutput.children.length)
        appendTerminalLine("CB Editor Terminal。help でコマンド一覧を表示します。");
};
document.getElementById("btn-terminal-close").onclick = () => {
    terminalPanel.classList.remove("open");
    document.getElementById("btn-toggle-terminal").classList.remove("active");
};
terminalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    executeTerminalCommand(terminalInput.value);
    terminalInput.value = "";
});
document.getElementById("btn-toggle-preview").onclick = function () {
    const hidden = previewPane.style.display === "none";
    previewPane.style.display = hidden ? "flex" : "none";
    resizerPreview.style.display = hidden ? "block" : "none";
    if (!hidden) editorPane.style.flex = "1 1 0%";
    else {
        editorPane.style.flex = `${editorLastPercent} ${editorLastPercent} 0%`;
        previewPane.style.flex = `${100 - editorLastPercent} ${100 - editorLastPercent} 0%`;
    }
    this.classList.toggle("active", hidden);
};
document.getElementById("btn-toggle-theme").onclick = () => {
    document.body.setAttribute(
        "data-theme",
        document.body.getAttribute("data-theme") === "dark" ? "light" : "dark",
    );
    updateEditorVisuals();
    updatePreview();
};
document.getElementById("btn-open-help").onclick = openHelpDocument;
document.getElementById("btn-run-code").onclick = executeEditorCode;
const runPreviewButton = document.getElementById("btn-run-preview-console");

if (runPreviewButton) {
    runPreviewButton.onclick = () => {
        updatePreview();

        if (typeof previewConsole !== "undefined" && previewConsole) {
            previewConsole.classList.add("open");
        }

        if (
            typeof previewConsoleResizer !== "undefined" &&
            previewConsoleResizer
        ) {
            previewConsoleResizer.style.display = "block";
        }

        if (typeof showStatusMessage === "function") {
            showStatusMessage("ライブプレビューを実行しました");
        }
    };
}
document.getElementById("select-default-ext").onchange = (e) => {
    defaultExtension = e.target.value;
    updateInitialUntitledExtension(defaultExtension);
};
document.getElementById("preview-text-theme-select").onchange = (e) => {
    previewTextTheme = ["light", "dark", "auto"].includes(e.target.value)
        ? e.target.value
        : "light";
    updatePreview();
};
document.getElementById("menu-new-file").onclick = createUntitledTab;
document.getElementById("btn-save-settings").onclick = saveSettings;
document.getElementById("menu-save-settings").onclick = saveSettings;
document.getElementById("menu-open-file").onclick = handleOpenFileWorkspace;
document.getElementById("menu-open-dir").onclick = handleOpenDirectoryWorkspace;
document.getElementById("menu-save-file").onclick = handleSaveFile;
document.getElementById("menu-save-as").onclick = handleSaveAsFile;
document.getElementById("menu-close-workspace").onclick = () =>
    checkUnsavedProtection().then((dec) => {
        if (dec === "proceed") {
            storageDelete("workspace");
            closeCurrentWorkspace();
        }
    });
document.getElementById("menu-save-workspace").onclick = saveWorkspaceFile;
document.getElementById("menu-add-workspace-folder").onclick =
    addWorkspaceFolder;
document.getElementById("menu-wrap-setting").onclick = () => {
    wrapEnabled = !wrapEnabled;
    applyWrapStyles();
    updateEditorVisuals();
    showStatusMessage(
        wrapEnabled
            ? `折り返し: ON (${maxWrapLength}${wrapLengthUnit === "half" ? "半角" : "文字"})`
            : "折り返し: OFF",
    );
};
window.setWrapConfig = (length, unit = "half") => {
    maxWrapLength = Math.max(1, Number(length) || 80);
    wrapLengthUnit = unit === "full" ? "full" : "half";
    document.getElementById("wrap-length-input").value = maxWrapLength;
    document.getElementById("wrap-unit-select").value = wrapLengthUnit;
    applyWrapStyles();
    updateEditorVisuals();
    showStatusMessage(
        `折り返し制限: ${maxWrapLength} (${wrapLengthUnit === "half" ? "半角換算" : "文字数"})`,
    );
    saveSettings();
};
document.getElementById("menu-undo").onclick = () => {
    editor.focus();
    document.execCommand("undo");
};
document.getElementById("menu-redo").onclick = () => {
    editor.focus();
    document.execCommand("redo");
};
document.getElementById("menu-select-all").onclick = () => {
    editor.focus();
    editor.select();
};

editor.addEventListener("input", () => {
    const t = tabs.find((x) => x.id === activeTabId);
    if (t && !t.isImage) {
        t.content = editor.value;
        t.isModified = true;
    }
    updateEditorVisuals();
    schedulePreviewUpdate();
    updateLineColumn();
    renderTabs();
    renderOpenedEditorsSection();
});
editor.addEventListener("click", updateLineColumn);
editor.addEventListener("keyup", updateLineColumn);
editor.addEventListener("select", updateLineColumn);
editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
        e.preventDefault();
        const st = editor.selectionStart,
            en = editor.selectionEnd;
        if (e.shiftKey) {
            const ls = editor.value.lastIndexOf("\n", st - 1) + 1;
            const seg = editor.value.slice(ls, st);
            const n = seg.startsWith("\t") ? 1 : seg.startsWith("    ") ? 4 : 0;
            if (n) replaceEditorRange(ls, ls + n, "", Math.max(ls, st - n));
        } else replaceEditorRange(st, en, "\t", st + 1);
        return;
    }
    if (e.key === "{") {
        e.preventDefault();
        smartOpenBrace();
        return;
    }
    if (e.key === "(") {
        e.preventDefault();
        smartOpenParenthesis();
        return;
    }
    if (e.key === ")") {
        const st = editor.selectionStart;
        if (st === editor.selectionEnd && editor.value.slice(st).startsWith(")")) {
            e.preventDefault();
            editor.selectionStart = editor.selectionEnd = st + 1;
            return;
        }
    }
    if (e.key === "}") {
        const st = editor.selectionStart;
        if (st === editor.selectionEnd && editor.value.slice(st).startsWith("}")) {
            e.preventDefault();
            editor.selectionStart = editor.selectionEnd = st + 1;
            return;
        }
        e.preventDefault();
        const ls = editor.value.lastIndexOf("\n", st - 1) + 1,
            line = editor.value.slice(ls, st),
            ind = (line.match(/^[ \t]*/) || [""])[0],
            target = ind.startsWith("\t")
                ? ind.slice(0, -1)
                : ind.length >= 4
                    ? ind.slice(0, -4)
                    : ind;
        if (line.trim() === "") editor.setRangeText("}", ls, st, "end");
        else editor.setRangeText("\n" + target + "}", st, st, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        return;
    }
    if (e.key === "Enter") {
        e.preventDefault();
        smartEnter();
        return;
    }
});
document.addEventListener("keydown", (e) => {
    if (e.key === "F2" && rightClickedItemData) {
        e.preventDefault();
        executeRenameUI(rightClickedItemData);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleOpenFileWorkspace();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createUntitledTab();
    }
});

window.addEventListener("error", (e) => {
    try {
        showStatusMessage("エラー: " + (e.message || "不明なエラー"));
        console.error(e.error || e.message);
    } catch (_) { }
});
window.addEventListener("unhandledrejection", (e) => {
    try {
        showStatusMessage(
            "処理エラー: " + (e.reason?.message || e.reason || "不明なエラー"),
        );
        console.error(e.reason);
    } catch (_) { }
});
window.addEventListener("beforeunload", (e) => {
    if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = "";
    }
});
window.addEventListener("DOMContentLoaded", async () => {
    loadSettings();
    updateUI();
    try {
        await restoreWorkspace();
    } catch (e) {
        console.error(e);
    }
    if (tabs.length === 0) createUntitledTab();
    renderTabs();
    renderOpenedEditorsSection();
    updateLineColumn();
});

window.addEventListener("DOMContentLoaded", () => {
    try {
        const cm = document.getElementById("custom-context-menu");
        if (cm) cm.style.display = "none";
        const iv = document.getElementById("image-viewer");
        if (iv && !iv.dataset.viewerOpen) iv.style.display = "none";
        const dp = document.getElementById("diagnostics-panel");
        if (dp && !document.querySelector(".diagnostic-item"))
            dp.style.display = "none";
        document.querySelectorAll("button").forEach((b) => {
            b.style.pointerEvents = "auto";
        });
    } catch (e) {
        console.warn("interaction safety init failed", e);
    }
});

(function () {
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (
            typeof url === "string" &&
            (url.startsWith("data:") ||
                url.startsWith("http:") ||
                url.startsWith("https:"))
        ) {
            return originalOpen.apply(this, arguments);
        }
        if (window.PANORAMA_IMAGES) {
            var filename = url.substring(url.lastIndexOf("/") + 1).split("?")[0];
            if (window.PANORAMA_IMAGES[filename]) {
                url = window.PANORAMA_IMAGES[filename];
            } else {
                var imgKey = "img/panorama/" + filename;
                if (window.PANORAMA_IMAGES[imgKey])
                    url = window.PANORAMA_IMAGES[imgKey];
            }
        }
        return originalOpen.apply(this, arguments);
    };
    if (window.fetch) {
        var originalFetch = window.fetch;
        window.fetch = function (input, init) {
            if (
                typeof input === "string" &&
                (input.startsWith("data:") ||
                    input.startsWith("http:") ||
                    input.startsWith("https:"))
            ) {
                return originalFetch(input, init);
            }
            if (typeof input === "string" && window.PANORAMA_IMAGES) {
                var filename = input
                    .substring(input.lastIndexOf("/") + 1)
                    .split("?")[0];
                if (window.PANORAMA_IMAGES[filename]) {
                    input = window.PANORAMA_IMAGES[filename];
                }
            }
            return originalFetch(input, init);
        };
    }
})();
